import { editDistance, initialsMatchDomain, zipMatchesState } from './verify'

/**
 * Turns the text recognized on a business card into contact fields.
 *
 * Cards have no fixed layout, so this uses patterns (emails, phones, ZIP codes) plus
 * clues (job-title words, "Inc"/"LLC", the email's domain, text size) to guess which
 * line is which. Everything it isn't sure about goes into Notes, so nothing is lost.
 */

export interface CardLine {
  text: string
  /** Height of the text (any unit, same for all lines); bigger text is usually the name or company. */
  height?: number
  /** Vertical position (same unit); used to tell which word is on top. */
  y?: number
}

export interface CardContact {
  first_name: string
  last_name: string
  company: string
  title: string
  department: string
  email: string
  /** The main number (same as phones[0]), kept for the accuracy checks. */
  phone: string
  /** Every number on the card, main one first, each with its label and extension. */
  phones: { label: string; number: string; ext: string }[]
  street: string
  suite: string
  city: string
  region: string
  postal_code: string
  country: string
  hire_date: string
  home_state: string
  /** Read from the printed front of a driver's license; YYYY-MM-DD */
  dob: string
  dl_number: string
  sex: string
  height: string
  eye_color: string
  notes: string
  /** True when the photo looks like a driver's license / ID (DOB or license number found). */
  is_id: boolean
}

/** "Special Investigations Unit", "Claims Department", "Division of Water": a department, not a name. */
const DEPARTMENT_WORDS = /\b(unit|department|dept\.?|division|bureau|section|branch)\b/i

const EYE_CODES: Record<string, string> = { BLK: 'Black', BLU: 'Blue', BRO: 'Brown', BRN: 'Brown', GRY: 'Gray', GRN: 'Green', HAZ: 'Hazel', MAR: 'Maroon', PNK: 'Pink' }

/** "1.15.21" / "01/15/2021" -> "2021-01-15". Two-digit years: future = last century. */
function toIsoDate(m: string, d: string, y: string, pastOnly: boolean): string {
  let year = Number(y)
  if (y.length === 2) {
    const nowYY = new Date().getFullYear() % 100
    year = (pastOnly ? year <= nowYY : year <= nowYY + 10) ? 2000 + year : 1900 + year
  }
  const iso = `${year}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`
  const t = new Date(iso + 'T00:00:00Z')
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : ''
}

const DATE_PART = '(\\d{1,2})\\s*[./-]\\s*(\\d{1,2})\\s*[./-]\\s*(\\d{2,4})'
const HIRE_RE = new RegExp(`HIRE\\s*DATE\\s*[:.]?\\s*${DATE_PART}`, 'i')
// OCR sometimes drops the second dot: "1.1521" -> 1 / 15 / 21
const HIRE_SQUASHED_RE = /HIRE\s*DATE\s*[:.]?\s*(\d{1,2})[./-](\d{2})(\d{2})\b/i
const HOME_STATE_RE = /HOME\s*STATE\s*[:.]?\s*([A-Z]{2})\b/i
const DOB_RE = new RegExp(`\\b(?:3\\s*)?(?:DOB|DATE\\s*OF\\s*BIRTH|BIRTH\\s*DATE)\\s*[:.]?\\s*${DATE_PART}`, 'i')
const DLN_RE = /\b(?:4d\s*)?(?:DLN|DL\s*(?:NO|#|NUMBER)|LIC(?:ENSE)?\s*(?:NO|#|NUMBER))\.?\s*[:#]?\s*([A-Z]?\d[\d -]{4,16}\d)/i
const SEX_RE = /\bSEX\s*[:.]?\s*([MFX])\b/i
const HGT_RE = /\bHGT\s*[:.]?\s*(\d)\s*['’-]\s*(\d{1,2})/i
const EYES_RE = /\bEYES\s*[:.]?\s*([A-Z]{3})\b/i

/** "1500 Main St, Suite 200" -> ["1500 Main St", "Suite 200"] */
export function splitSuite(street: string): [string, string] {
  // Includes common misreads of "Suite" (Sute, Suit, Sulte, Svite, Sube).
  const m = street.match(/^(.*?)(?:,\s*|\s+)((?:suite|su[il]?te|suit|svite|sube|ste\.?|unit|apt\.?|apartment|#|floor|fl\.?|bldg\.?|building|room|rm\.?)\s*#?\s*[\w-]*\d[\w-]*)\s*$/i)
  if (!m || !m[1].trim()) return [street, '']
  // Normalize a misread "Suite" to the real word.
  const suite = m[2].trim().replace(/^(su[il]?te|suit|svite|sube)\b/i, 'Suite')
  return [m[1].trim().replace(/,$/, ''), suite]
}

const TITLE_WORDS =
  /\b(ceo|cfo|coo|cto|cio|cmo|vp|svp|evp|president|vice|director|manager|mgr|engineer|developer|designer|consultant|founder|co-founder|owner|partner|principal|associate|analyst|specialist|coordinator|officer|representative|rep|executive|agent|realtor|broker|advisor|adviser|attorney|lawyer|counsel|accountant|cpa|architect|administrator|admin|assistant|supervisor|superintendent|lead|head|chief|sales|marketing|account|technician|nurse|doctor|dds|md|phd|recruiter|strategist|producer|editor|instructor|professor|teacher|pastor|minister|chairman|chair|treasurer|secretary|operations|business development|loan officer|mortgage|insurance|estimator|foreman|inspector|dentist|physician|therapist|pharmacist|planner|investigator|examiner|adjuster|appraiser|auditor|detective|surveyor|paralegal|scientist|researcher|underwriter|controller|bookkeeper|clerk)\b/i

const COMPANY_WORDS =
  /\b(inc|llc|l\.l\.c|ltd|llp|pllc|lp|corp|corporation|co|company|group|holdings|partners|associates|solutions|services|systems|technologies|technology|tech|industries|international|enterprises|consulting|labs|studio|agency|bank|realty|properties|construction|energy|logistics|insurance|financial|capital|ventures|clinic|hospital|church|university|college|school|foundation|restaurant|cafe|plumbing|roofing|electric|law firm|dental|medical)(?![a-z-])/i

// Words that should stay in capitals after fixing an ALL-CAPS line.
const KEEP_CAPS = new Set(['LLC', 'LLP', 'PLLC', 'LP', 'USA', 'CPA', 'CEO', 'CFO', 'COO', 'CTO', 'CIO', 'CMO', 'VP', 'SVP', 'EVP', 'PE', 'MD', 'DDS', 'RN', 'II', 'III', 'IV', 'HVAC', 'IT', 'AI', 'HR'])

const STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY'

// ZIP: 5 digits (+4). OCR sometimes misreads a digit as S/O/I/l or drops one, so a 4–6
// character ZIP is still accepted (and later marked "Check" by the accuracy checks).
const CITY_STATE_ZIP = new RegExp(`^(.*?)[,\\s]+(${STATES})\\.?\\s+([\\dSOIl]{4,6})(?:[-\\s]?(\\d{4}))?\\b`, 'i')
// Same shape, but any two letters as the state (for OCR misreads like "NN" for "MN").
const CITY_ANY_STATE_ZIP = /^(.*?[A-Za-z].*?)[,\s]+([A-Za-z]{2})\.?\s+([\dSOIl]{4,6})(?:[-\s]?(\d{4}))?\s*$/
const STATE_SET = new Set(STATES.split('|'))
const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
}
// "Dallas, Texas 75203" -> "Dallas, TX 75203" (only right before a ZIP, so "Texas Instruments" is left alone).
const STATE_NAME_ZIP = new RegExp(`\\b(${Object.keys(STATE_NAMES).sort((a, b) => b.length - a.length).join('|')})\\.?(?=,?\\s+\\d{5}\\b)`, 'gi')
// Letters OCR commonly confuses in capitals.
const LOOKALIKE: Record<string, string> = {
  N: 'MHW', M: 'NHW', H: 'NM', W: 'VMN', V: 'WUY', U: 'VO', O: 'DQCU', D: 'O', Q: 'O', C: 'GO', G: 'C',
  I: 'LTJ', L: 'I', T: 'I', J: 'I', E: 'F', F: 'E', K: 'X', X: 'K', Y: 'V', A: 'R', R: 'A', P: 'R', S: 'O',
}

/**
 * Repairs a misread state code: tries swapping each letter for its look-alikes and keeps a
 * real state, preferring one that matches the ZIP code's area. Returns '' if nothing fits.
 */
export function repairState(raw: string, zip: string): string {
  const s = raw.toUpperCase()
  if (STATE_SET.has(s)) return s
  const candidates = new Set<string>()
  for (let i = 0; i < 2; i++) for (const c of LOOKALIKE[s[i]] ?? '') candidates.add(i === 0 ? c + s[1] : s[0] + c)
  for (const a of LOOKALIKE[s[0]] ?? '') for (const b of LOOKALIKE[s[1]] ?? '') candidates.add(a + b)
  const valid = [...candidates].filter((c) => STATE_SET.has(c))
  // The first 3 ZIP digits identify the area, so even a ZIP with a digit missing helps choose.
  const digits = zip.replace(/\D/g, '')
  const area = digits.length >= 3 ? digits.slice(0, 3).padEnd(5, '0') : ''
  return valid.find((c) => area && zipMatchesState(area, c) === true) ?? (valid.length === 1 ? valid[0] : '')
}

const fixZipDigits = (z: string) => z.replace(/[Ss]/g, '5').replace(/[Oo]/g, '0').replace(/[Il]/g, '1')
const STREET =
  /^\s*\d{1,6}[A-Z]?\s+([NSEW]\.?\s+)?[\w.' -]+?\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|pkwy|parkway|hwy|highway|fwy|freeway|ct|court|cir|circle|pl|place|ter|terrace|trl|trail|loop|sq|square|plaza|center|ctr)\b\.?(.*)$/i
const SUITE = /^\s*(suite|ste\.?|unit|apt\.?|#|floor|fl\.?|bldg\.?|building)\s*[\w-]+/i
/** A suite at the start of the city text: "Suite 325 Maple Grove", "Ste. 4 Houston", "# 12 Austin". */
const SUITE_THEN_CITY = /^((?:suite|su[il]?te|suit|svite|sube|ste\.?|unit|apt\.?|#|room|rm\.?|floor|fl\.?)\s*#?\s*[\w-]*\d[\w-]*)[,\s]+([A-Za-z].*)$/i
const PO_BOX = /^\s*p\.?\s*o\.?\s*box\s+\d+/i

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const URL_RE = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|us|biz|info|edu|gov|ai|app|dev|me|tv|law|church|realtor|health)(?:\/[^\s]*)?)\b/i
// US/Canada numbers, with optional +1, separators, and extension.
const PHONE = /(?:\+?1[\s.-]*)?\(?\b(\d{3})\)?[\s.\-–/]*(\d{3})[\s.\-–]*(\d{4})\b(?:\s*,?\s*(?:x|ext\.?|extension)\s*[:.#]?\s*(\d{1,6}))?/gi

type PhoneKind = 'mobile' | 'direct' | 'office' | 'fax' | 'other' | 'toll-free'
const TOLL_FREE = /^8(00|33|44|55|66|77|88)$/

function phoneKind(before: string): PhoneKind {
  const label = before.toLowerCase().slice(-14)
  if (/(fax|\bf\b|f:|f\.)\s*[:.]?\s*$/.test(label)) return 'fax'
  if (/(mobile|cell|\bm\b|m:|c:|\bc\b|mob)\s*[:.]?\s*$/.test(label)) return 'mobile'
  if (/(direct|\bd\b|d:)\s*[:.]?\s*$/.test(label)) return 'direct'
  // OCR often reads the letter "O" as zero, so "0:" counts as office too.
  if (/(office|tel|phone|main|work|\bo\b|o:|\b0\b|0:|\bt\b|t:|\bp\b|p:|ph)\s*[:.]?\s*$/.test(label)) return 'office'
  return 'other'
}

function formatPhone(m: RegExpExecArray): string {
  const base = `(${m[1]}) ${m[2]}-${m[3]}`
  return m[4] ? `${base} x${m[4]}` : base
}

const PHONE_LABEL: Record<PhoneKind, string> = { mobile: 'Mobile', direct: 'Direct', office: 'Work', fax: 'Fax', other: 'Work', 'toll-free': 'Toll-free' }

/** Fixes common OCR slips: spaced-out "@", "(at)", stray spaces around dots in emails. */
function repairLine(t: string): string {
  return t
    .replace(/[|]/g, ' ')
    .replace(/\s*[([{<]?\s*@\s*[)\]}>]?\s*/g, '@') // "name(@domain" / "name @ domain" -> "name@domain"
    .replace(/\s*\(at\)\s*/gi, '@')
    .replace(/(@[\w-]+)\s*\.\s*(com|net|org|io|co|us|biz|edu|gov)\b/gi, '$1.$2')
    .replace(/(www\.[\w-]+)\s+\.\s*(com|net|org|io|co|us|biz|edu|gov)\b/gi, '$1.$2')
    .replace(/\s{2,}/g, ' ')
    .replace(STATE_NAME_ZIP, (n) => STATE_NAMES[n.toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '')] ?? n)
    // Bullets between parts are often read as other marks ("=", "«", "+", "*"), or as "m":
    // "Road = Houston", "7688 + » Fax", "Lane m Dallas". Only on lines with digits (addresses,
    // phones). A lone "m" counts only before a word, since "m 214-555-0100" can mean mobile.
    .replace(/(\S)\s+[■▪●•◆=«»*+¢~](?:\s*[■▪●•◆=«»*+¢~])*\s+/g, (all, ch: string) => (/\d/.test(t) ? `${ch} • ` : all))
    .replace(/(\S)\s+m\s+(?=[A-Z][a-z])/g, (all, ch: string) => (/\d/.test(t) ? `${ch} • ` : all))
    // "Houston; Texas" -> "Houston, Texas"; a stray mark at the start of a line ("> 4949 …").
    .replace(/([a-z]);\s/g, '$1, ')
    .replace(/^[>»<«*•·~=+¢&]+\s*/, '')
    .trim()
}

function titleCaseIfShouting(s: string): string {
  const letters = s.replace(/[^A-Za-z]/g, '')
  if (letters.length > 3 && letters === letters.toUpperCase()) {
    s = s.toLowerCase().replace(/(^|[\s\-'’.])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase())
  }
  return s.replace(/\b[A-Za-z]{2,5}\b/g, (w) => (KEEP_CAPS.has(w.toUpperCase()) ? w.toUpperCase() : w))
}

const SUFFIX_RE = /^(jr|sr|ii|iii|iv|phd|md|cpa|pe|esq|mba|rn)\.?$/i
/** "A. Scott Leake, IAAI-CFI" -> ["A. Scott Leake", "IAAI-CFI"]. Common suffixes (Jr., CPA) stay with the name. */
function splitCredentials(t: string, keepSuffixes = true): [string, string] {
  const m = t.match(/^(.*?[A-Za-z]),\s*([A-Z][A-Z0-9-]{1,}(?:[\s,/]+[A-Z][A-Z0-9-]{1,})*)\s*$/)
  if (!m || (keepSuffixes && m[2].split(/[\s,/]+/).every((w) => SUFFIX_RE.test(w)))) return [t, '']
  return [m[1].trim(), m[2].trim()]
}

function looksLikeName(t: string): boolean {
  t = splitCredentials(t)[0]
  if (/\d|@|www\.|\.com/i.test(t)) return false
  const words = t.replace(/,?\s+(jr|sr|ii|iii|iv|phd|md|cpa|pe|esq|mba|rn)\.?$/i, '').split(/\s+/).filter(Boolean)
  if (words.length < 2 || words.length > 4) return false
  return words.every((w) => /^[A-Za-z][A-Za-z.'’-]*$/.test(w))
}

/** "jane.doe" / "jdoe" vs "Jane Doe": does the email's user part match this name? */
function nameMatchesEmail(name: string, local: string): boolean {
  const l = local.toLowerCase().replace(/[^a-z]/g, '')
  const parts = name.toLowerCase().split(/\s+/).map((p) => p.replace(/[^a-z]/g, '')).filter(Boolean)
  if (!l || parts.length < 2) return false
  const first = parts[0]
  const last = parts[parts.length - 1]
  return l.includes(last) || l.includes(first) || l === first[0] + last || l === first + last[0]
}

function domainWord(domain: string): string {
  const generic = /^(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn|comcast|att|sbcglobal|protonmail)$/i
  const core = domain.toLowerCase().replace(/^www\./, '').split('.')[0]
  return generic.test(core) ? '' : core
}

function splitName(full: string): { first: string; last: string } {
  const cleaned = full.replace(/,?\s+(jr|sr|ii|iii|iv|phd|md|cpa|pe|esq|mba|rn)\.?$/i, (m) => m)
  const words = cleaned.split(/\s+/)
  // Keep suffixes (Jr., PhD) with the last name.
  const suffixIdx = words.findIndex((w, i) => i > 0 && /^(jr|sr|ii|iii|iv|phd|md|cpa|pe|esq|mba|rn)\.?,?$/i.test(w.replace(/,$/, '')))
  const core = suffixIdx > 0 ? words.slice(0, suffixIdx) : words
  const suffix = suffixIdx > 0 ? ' ' + words.slice(suffixIdx).join(' ') : ''
  if (core.length === 1) return { first: core[0], last: suffix.trim() }
  // "A. Scott Leake": a leading initial goes with the first name.
  if (core.length >= 3 && /^[A-Z]\.?$/i.test(core[0])) return { first: `${core[0]} ${core[1]}`, last: core.slice(2).join(' ') + suffix }
  return { first: core[0], last: core.slice(1).join(' ').replace(/^([A-Z]\.?)\s+/, '') + suffix }
}

const TLD = /^[a-z0-9.-]*\.(com|net|org|io|co|us|biz|info|edu|gov|ai|app|dev|me)$/i

/** Glare or a line break can split "jane.doe@acme" / "roofing.com" across two lines; rejoin them. */
function joinSplitEmails(lines: { text: string; height: number; y: number }[]) {
  const out: { text: string; height: number; y: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    const next = lines[i + 1]
    if (next && /@[\w.-]*$/.test(cur.text) && !EMAIL.test(cur.text) && TLD.test(next.text.trim())) {
      const left = cur.text.trim()
      const right = next.text.trim()
      // Overlapping pieces ("...guardianrfi" + "id.com") share letters; don't double them.
      let overlap = 0
      for (let k = Math.min(left.length, right.length); k > 0; k--) {
        if (left.toLowerCase().endsWith(right.slice(0, k).toLowerCase())) {
          overlap = k
          break
        }
      }
      out.push({ text: left + right.slice(overlap), height: cur.height, y: cur.y })
      i++
    } else out.push(cur)
  }
  return out
}

const NOT_A_NAME = /^(one|team|mission|the|and|of|for|your|our|hire|date|home|state|since|est|welcome|hello|thank|you|visitor|guest|staff|employee|badge|id)$/i

function isSingleNameWord(t: string): boolean {
  return /^[A-Za-z][A-Za-z'’-]{1,20}$/.test(t.trim()) && !NOT_A_NAME.test(t.trim()) && !TITLE_WORDS.test(t) && !COMPANY_WORDS.test(t)
}

/** "daniel.quam" -> ["daniel", "quam"]; null for "info", "jdoe", etc. */
function nameFromEmail(local: string): [string, string] | null {
  const m = local.toLowerCase().match(/^([a-z]{2,})[._-]([a-z]{2,})$/)
  if (!m || /^(info|sales|admin|contact|office|support|hello|team|mail|service)$/.test(m[1])) return null
  return [m[1], m[2]]
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()

/**
 * The email domain is typed, so it's spelled right; the card text is read by OCR and may
 * not be. "GUARDIAN RFIL" + "guardianrfid" -> "GUARDIAN RFID" (card's spacing, domain's letters).
 */
function spellLikeDomain(text: string, domainCore: string): string {
  const letters = text.replace(/[^A-Za-z0-9]/g, '')
  // Last letter or two cut off ("GUARDIAN RFI" vs "guardianrfid"): finish it from the domain.
  const missing = domainCore.length - letters.length
  if (missing >= 1 && missing <= 2 && letters.length >= 5 && domainCore.startsWith(letters.toLowerCase())) {
    const tail = domainCore.slice(letters.length)
    const upper = letters === letters.toUpperCase()
    return text.trimEnd() + (upper ? tail.toUpperCase() : tail)
  }
  if (letters.length !== domainCore.length) return text
  let diffs = 0
  for (let i = 0; i < letters.length; i++) if (letters[i].toLowerCase() !== domainCore[i]) diffs++
  if (diffs === 0 || diffs > 2) return text
  let k = 0
  return text.replace(/[A-Za-z0-9]/g, (ch) => {
    const d = domainCore[k++]
    return ch === ch.toUpperCase() ? d.toUpperCase() : d
  })
}

const COMMON_SHORT = new Set(['bank', 'park', 'land', 'home', 'life', 'care', 'west', 'east', 'gulf', 'best', 'star', 'gold', 'iron', 'rock', 'blue', 'red', 'inn', 'pro', 'max', 'tech', 'law', 'art', 'arts', 'auto', 'pet', 'pets', 'spa', 'bar', 'cafe', 'shop', 'farm', 'firm', 'fund', 'hub', 'lab', 'labs', 'net', 'one', 'top', 'web', 'york', 'and', 'the', 'of', 'for', 'inc', 'co', 'corp'])

/** Company names in ALL CAPS: title-case them, but keep acronyms (RFID, IBM) in capitals. */
function companyCase(name: string): string {
  const letters = name.replace(/[^A-Za-z]/g, '')
  if (!(letters.length > 3 && letters === letters.toUpperCase())) return name
  const fixed = titleCaseIfShouting(name)
  return fixed.replace(/\b[A-Za-z]{2,4}\b/g, (w) => {
    const vowels = (w.match(/[aeiou]/gi) ?? []).length
    return vowels <= 1 && !COMMON_SHORT.has(w.toLowerCase()) ? w.toUpperCase() : w
  })
}

export function parseBusinessCard(input: CardLine[]): CardContact {
  const out: CardContact = {
    first_name: '', last_name: '', company: '', title: '', department: '', email: '', phone: '', phones: [],
    street: '', suite: '', city: '', region: '', postal_code: '', country: '',
    hire_date: '', home_state: '', dob: '', dl_number: '', sex: '', height: '', eye_color: '',
    notes: '', is_id: false,
  }

  const hasPositions = input.some((l) => l.y !== undefined)
  const lines = joinSplitEmails(
    input
      .map((l, i) => ({ text: repairLine(l.text), height: l.height ?? 0, y: l.y ?? i }))
      // Drop OCR noise: lines with almost no letters/digits, or mostly symbols.
      .filter((l) => {
        const alnum = l.text.replace(/[^A-Za-z0-9]/g, '').length
        return alnum >= 2 && alnum >= l.text.replace(/\s/g, '').length * 0.6
      }),
  )
  const used = new Set<number>()
  const extras: string[] = []

  // 0. Labeled fields: badges ("HIRE DATE: 1.15.21", "HOME STATE: TX") and the printed
  //    front of a driver's license ("DOB 01/15/1990", "4d DLN 12345678", "SEX M", ...).
  lines.forEach((l, i) => {
    const t = l.text
    let hit = false
    let m: RegExpMatchArray | null
    if ((m = t.match(HIRE_RE) ?? t.match(HIRE_SQUASHED_RE)) && !out.hire_date) { out.hire_date = toIsoDate(m[1], m[2], m[3], true); hit = true }
    if ((m = t.match(HOME_STATE_RE)) && new RegExp(`^(${STATES})$`, 'i').test(m[1]) && !out.home_state) { out.home_state = m[1].toUpperCase(); hit = true }
    if ((m = t.match(DOB_RE)) && !out.dob) { out.dob = toIsoDate(m[1], m[2], m[3], true); hit = true }
    if ((m = t.match(DLN_RE)) && !out.dl_number) { out.dl_number = m[1].replace(/[\s-]/g, '').toUpperCase(); hit = true }
    if ((m = t.match(SEX_RE)) && !out.sex) { out.sex = { M: 'Male', F: 'Female', X: 'X' }[m[1].toUpperCase() as 'M' | 'F' | 'X']; hit = true }
    if ((m = t.match(HGT_RE)) && !out.height) { out.height = `${m[1]}'${Number(m[2])}"`; hit = true }
    if ((m = t.match(EYES_RE)) && !out.eye_color) { out.eye_color = EYE_CODES[m[1].toUpperCase()] ?? ''; hit = true }
    // Only consume the line if nothing else useful is on it.
    if (hit && !EMAIL.test(t) && !CITY_STATE_ZIP.test(t)) used.add(i)
  })
  out.is_id = Boolean(out.dob || out.dl_number)
  if (out.is_id) {
    // License fronts number their fields: "1 SAMPLE" (last name), "2 TEST PERSON" (first + middle),
    // "8 100 EXAMPLE ST" (address). Strip the numbers so the normal rules can use the text.
    lines.forEach((l, i) => {
      if (used.has(i)) return
      const last = l.text.match(/^\s*1\s+([A-Za-z][A-Za-z' -]+)$/)
      const first = l.text.match(/^\s*2\s+([A-Za-z][A-Za-z' -]+)$/)
      if (last && !out.last_name) { out.last_name = titleCaseIfShouting(last[1].trim()); used.add(i) }
      else if (first && !out.first_name) { out.first_name = titleCaseIfShouting(first[1].trim().split(/\s+/)[0]); used.add(i) }
      else lines[i] = { ...l, text: l.text.replace(/^\s*8\s+(?=\d)/, '') }
    })
  }

  // 1. Email (and website, which also hints at the company).
  let emailLocal = ''
  let domain = ''
  lines.forEach((l, i) => {
    const m = l.text.match(EMAIL)
    if (m && !out.email) {
      out.email = m[0].toLowerCase().replace(/[.,;]+$/, '')
      ;[emailLocal, domain] = out.email.split('@')
      const rest = l.text.replace(m[0], '').replace(/^\W*(e-?mail|e)\s*[:.]?\s*/i, '').trim()
      if (rest.replace(/\W/g, '').length < 3) used.add(i)
      else lines[i] = { ...l, text: rest }
    }
  })
  lines.forEach((l, i) => {
    if (used.has(i) || EMAIL.test(l.text)) return
    const m = l.text.match(URL_RE)
    if (m && /www\.|https?:\/\/|^[a-z0-9-]+\.[a-z]{2,}\/?$/i.test(m[0])) {
      extras.push(`Website: ${m[0].replace(/^https?:\/\//i, '')}`)
      domain ||= m[0].replace(/^https?:\/\//i, '').replace(/^www\./i, '')
      const rest = l.text.replace(m[0], '').replace(/^\W*(web|w)\s*[:.]?\s*/i, '').trim()
      if (rest.replace(/\W/g, '').length < 3) used.add(i)
    }
  })

  // 2. Phones: prefer mobile, then direct, then office. Fax and the rest go to Notes.
  const phones: { kind: PhoneKind; value: string; number: string; ext: string }[] = []
  lines.forEach((l, i) => {
    if (used.has(i)) return
    PHONE.lastIndex = 0
    let m: RegExpExecArray | null
    let found = false
    while ((m = PHONE.exec(l.text))) {
      let kind = phoneKind(l.text.slice(0, m.index))
      // A toll-free number is never a personal line (a bullet read as "m" isn't "mobile").
      if (TOLL_FREE.test(m[1]) && kind !== 'fax') kind = 'toll-free'
      // A number printed on its own line, with no label, is usually the person's own.
      else if (kind === 'other' && l.text.replace(m[0], '').replace(/[^A-Za-z0-9]/g, '').length === 0) kind = 'direct'
      phones.push({ kind, value: formatPhone(m), number: `(${m[1]}) ${m[2]}-${m[3]}`, ext: m[4] ?? '' })
      found = true
    }
    if (found) used.add(i)
  })
  const rank: PhoneKind[] = ['mobile', 'direct', 'office', 'other', 'toll-free']
  const best = rank.map((k) => phones.find((p) => p.kind === k)).find(Boolean)
  if (best) out.phone = best.value
  // All numbers go in the phone list: the main one first, then by kind, fax last; no repeats.
  const order: PhoneKind[] = [...rank, 'fax']
  const seenNumbers = new Set<string>()
  for (const p of [...phones].sort((a, b) => (a === best ? -1 : b === best ? 1 : order.indexOf(a.kind) - order.indexOf(b.kind)))) {
    if (seenNumbers.has(p.value)) continue
    seenNumbers.add(p.value)
    out.phones.push({ label: PHONE_LABEL[p.kind], number: p.number, ext: p.ext })
  }

  // 3. Address: "City, ST 77479" plus the street line(s) above it.
  let addressCompany = ''
  lines.forEach((l, i) => {
    if (used.has(i) || out.city) return
    // Address may be on one line: "123 Main St, Suite 4, Houston, TX 77002"
    const parts = l.text.split(/\s*[,•·]\s*|\s{2,}/)
    // Try the shortest tail first so "123 Main St, Houston, TX 77002" gives city = "Houston".
    for (let k = parts.length - 1; k >= 0; k--) {
      const tail = parts.slice(k).join(', ')
      let m = tail.match(CITY_STATE_ZIP)
      if (!m) {
        // State misread ("NN" for "MN")? Accept when the state can be repaired, or when the line
        // clearly is an address (a house number before it).
        const loose = tail.match(CITY_ANY_STATE_ZIP)
        if (!loose) continue
        const fixed = repairState(loose[2], fixZipDigits(loose[3]))
        const hasStreet = parts.slice(0, k).some((h) => /^\s*\d{1,6}\s+[A-Za-z]/.test(h)) || (i > 0 && STREET.test(lines[i - 1].text))
        if (!fixed && !hasStreet) continue
        m = [loose[0], loose[1], fixed || loose[2].toUpperCase(), loose[3], loose[4]] as unknown as RegExpMatchArray
      }
      let cityPart = m[1].trim()
      // "Suite 325 Maple Grove" (no comma after the suite number): the suite isn't part of the city.
      const suiteFirst = cityPart.match(SUITE_THEN_CITY)
      let suiteFromCity = ''
      if (suiteFirst) {
        suiteFromCity = suiteFirst[1].trim()
        cityPart = suiteFirst[2].trim()
      }
      // "ACME LLC, 123 Main St, ..." -> parts before the street number are a company, not an address.
      let headParts = parts.slice(0, k)
      const firstStreet = headParts.findIndex((h) => /^\s*\d/.test(h) || PO_BOX.test(h))
      if (firstStreet > 0) {
        const lead = headParts.slice(0, firstStreet).join(', ')
        if (/[A-Za-z]{2}/.test(lead)) addressCompany = lead
        headParts = headParts.slice(firstStreet)
      }
      const head = headParts.join(', ')
      out.city = titleCaseIfShouting(cityPart)
      if (suiteFromCity) out.suite = suiteFromCity.replace(/^(su[il]?te|suit|svite|sube)\b/i, 'Suite')
      out.region = m[2].toUpperCase()
      const zip5 = fixZipDigits(m[3])
      out.postal_code = m[4] && m[4] !== '0000' ? `${zip5}-${m[4]}` : zip5
      out.country = 'USA'
      used.add(i)
      if (head) out.street = titleCaseIfShouting(head)
      else {
        // Walk upward to collect street + suite lines.
        const above: string[] = []
        for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
          if (used.has(j)) continue
          const t = lines[j].text
          if (STREET.test(t) || SUITE.test(t) || PO_BOX.test(t) || /^\s*\d{1,6}\s*$/.test(t)) {
            above.unshift(t)
            used.add(j)
            continue
          }
          // "ACME LLC, 6900 Main Rd N, Suite" -> company + street on one line.
          const segs = t.split(/\s*,\s*/)
          const streetAt = segs.findIndex((g) => /^\d{1,6}\s+[A-Za-z]/.test(g))
          if (streetAt >= 0) {
            if (streetAt > 0 && !addressCompany) addressCompany = segs.slice(0, streetAt).join(', ')
            above.unshift(segs.slice(streetAt).join(', '))
            used.add(j)
          }
          break
        }
        out.street = titleCaseIfShouting(above.join(', ').replace(/\b(suite|ste\.?|unit|#),\s*(\d)/i, '$1 $2'))
      }
      break
    }
  })
  if (/\b(suite|ste\.?|unit|#)$/i.test(out.street)) {
    const n = lines.findIndex((l, idx) => !used.has(idx) && /^\s*\d{1,5}\s*$/.test(l.text))
    if (n >= 0) {
      out.street += ' ' + lines[n].text.trim()
      used.add(n)
    }
  }
  if (!out.street) {
    const i = lines.findIndex((l, idx) => !used.has(idx) && (STREET.test(l.text) || PO_BOX.test(l.text)))
    if (i >= 0) {
      out.street = titleCaseIfShouting(lines[i].text)
      used.add(i)
    }
  }

  // 3b. Department: "Special Investigations Unit" (would otherwise look like a three-word name).
  const deptIdx = lines.findIndex((l, i) => !used.has(i) && DEPARTMENT_WORDS.test(l.text) && !/\d|@/.test(l.text) && !COMPANY_WORDS.test(l.text) && l.text.length <= 60)
  if (deptIdx >= 0) {
    out.department = titleCaseIfShouting(lines[deptIdx].text.trim())
    used.add(deptIdx)
  }

  // 4. Title: a line with job-title words.
  const titleIdx = lines.findIndex((l, i) => !used.has(i) && TITLE_WORDS.test(l.text) && !COMPANY_WORDS.test(l.text) && l.text.length <= 60)

  // 5. Name. Candidates: a "First Last" line, or two single words on consecutive lines
  // ("DANIEL" / "Quam": the bigger/top word is the first name). Clues: matches the email,
  // sits next to the title, big text, near the top.
  const maxH = Math.max(1, ...lines.map((l) => l.height))
  const emailName = emailLocal ? nameFromEmail(emailLocal) : null
  type Cand = { idx: number[]; first: string; last: string; score: number; creds?: string }
  const cands: Cand[] = []
  const scoreOf = (text: string, idx: number[], height: number) => {
    let score = 0
    if (emailLocal && nameMatchesEmail(text, emailLocal)) score += 5
    if (titleIdx >= 0 && idx.some((i) => Math.abs(i - titleIdx) === 1)) score += 3
    const dwName = domain ? domainWord(domain) : ''
    if (dwName && text.toLowerCase().replace(/[^a-z]/g, '').includes(dwName)) score -= 4
    score += (height / maxH) * 2
    score -= idx[0] * 0.1
    return score
  }
  lines.forEach((l, i) => {
    if (used.has(i) || i === titleIdx || !looksLikeName(l.text) || COMPANY_WORDS.test(l.text)) return
    if (TITLE_WORDS.test(l.text) && !nameMatchesEmail(l.text, emailLocal)) return
    if (l.text.split(/\s+/).every((w) => NOT_A_NAME.test(w))) return
    const [nameText, creds] = splitCredentials(l.text)
    const { first, last } = splitName(titleCaseIfShouting(nameText))
    cands.push({ idx: [i], first, last, creds, score: scoreOf(nameText, [i], l.height) })
  })
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i]
    const b = lines[i + 1]
    if (used.has(i) || used.has(i + 1) || !isSingleNameWord(a.text) || !isSingleNameWord(b.text)) continue
    // Largest (or, if equal, top) word is the first name.
    const [f, l] = b.height > a.height * 1.15 ? [b, a] : [a, b]
    const text = `${f.text.trim()} ${l.text.trim()}`
    cands.push({ idx: [i, i + 1], first: cap(f.text.trim()), last: cap(l.text.trim()), score: scoreOf(text, [i, i + 1], Math.max(a.height, b.height)) + 0.5 })
  }
  cands.sort((x, y) => y.score - x.score)
  const pick = cands[0]
  if (pick && !out.first_name && !out.last_name && (pick.score >= 1 || !emailName)) {
    out.first_name = pick.first
    out.last_name = pick.last
    if (pick.creds) extras.push(`Credentials: ${pick.creds}`)
    pick.idx.forEach((i) => used.add(i))
  }
  // Fall back to (or confirm with) the email: "daniel.quam@" -> Daniel Quam.
  const close = (a: string, b: string) => {
    const x = a.toLowerCase().replace(/[^a-z]/g, '')
    return x === b || (x.length >= 3 && b.startsWith(x.slice(0, 3)) && Math.abs(x.length - b.length) <= 2)
  }
  if (emailName && !(close(out.first_name, emailName[0]) && close(out.last_name.split(' ')[0] ?? '', emailName[1]))) {
    const [ef, el] = emailName
    // Mark any lines that are just those words as used so they don't land in Notes.
    lines.forEach((l, i) => {
      const w = l.text.trim().toLowerCase()
      if (w === ef || w === el) used.add(i)
    })
    out.first_name = cap(ef)
    out.last_name = cap(el)
  }
  if (titleIdx >= 0) {
    // "Investigator, MBA, CIF, FCLS": the letters after the title are credentials.
    const [titleText, creds] = splitCredentials(lines[titleIdx].text, false)
    out.title = titleCaseIfShouting(titleText)
    if (creds && !extras.some((e) => e.startsWith('Credentials:'))) extras.push(`Credentials: ${creds}`)
    else if (creds) extras[extras.findIndex((e) => e.startsWith('Credentials:'))] += `, ${creds}`
    used.add(titleIdx)
  }

  // 6. Company. Best clue: the email/website domain ("@guardianrfid.com" -> "GUARDIAN RFID").
  const dw = domain ? domainWord(domain) : ''
  const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (dw.length >= 3) {
    // Look in every line (including the address line) for the text that spells the domain.
    for (const l of lines) {
      const seg = l.text.split(/\s*[,|•·]\s*/).find((p) => {
        const sq = squash(p)
        return sq.length >= 3 && (sq === dw || (sq.startsWith(dw.slice(0, Math.max(4, dw.length - 2))) && sq.length <= dw.length + 2))
      })
      if (seg) {
        out.company = companyCase(spellLikeDomain(seg.trim(), dw))
        break
      }
    }
  }
  if (!out.company && addressCompany) out.company = companyCase(dw ? spellLikeDomain(addressCompany, dw) : addressCompany)
  let companyIdx = -1
  if (!out.company) {
    companyIdx = lines.findIndex((l, i) => !used.has(i) && COMPANY_WORDS.test(l.text) && !/\d{3}/.test(l.text))
    if (companyIdx < 0 && dw.length >= 3) {
      companyIdx = lines.findIndex((l, i) => {
        if (used.has(i)) return false
        const squashed = squash(l.text)
        const initials = l.text.split(/\s+/).map((w) => w[0]?.toLowerCase() ?? '').join('')
        return squashed.includes(dw) || (squashed.length >= 4 && dw.includes(squashed.slice(0, 6))) || (initials.length >= 2 && dw.startsWith(initials))
      })
    }
    if (companyIdx < 0) {
      let bestH = 0
      lines.forEach((l, i) => {
        if (used.has(i) || /\d{3}/.test(l.text) || l.text.length > 40) return
        if (l.height > bestH) {
          bestH = l.height
          companyIdx = i
        }
      })
      const avg = lines.reduce((a, l) => a + l.height, 0) / Math.max(1, lines.length)
      if (companyIdx >= 0 && lines[companyIdx].height < avg * 1.15) companyIdx = -1
    }
    if (companyIdx >= 0) {
      out.company = companyCase(lines[companyIdx].text)
      used.add(companyIdx)
      // Logo-style names split over two lines ("Unified" / "Investigations & Sciences, Inc."):
      // join them when together their initials spell the domain ("uis-usa.com").
      // The nearest unused line above it (by position, not list order).
      let a = -1
      lines.forEach((l, i) => {
        if (used.has(i) || i === companyIdx || l.y >= lines[companyIdx].y) return
        // With real positions, it must be close above (within about three line heights).
        if (hasPositions && lines[companyIdx].y - l.y > lines[companyIdx].height * 3) return
        if (a < 0 || l.y > lines[a].y) a = i
      })
      if (dw && a >= 0 && !used.has(a) && !/\d/.test(lines[a].text) && lines[a].text.trim().split(/\s+/).length <= 3 &&
          !initialsMatchDomain(out.company, dw) && initialsMatchDomain(`${lines[a].text} ${out.company}`, dw)) {
        out.company = companyCase(`${lines[a].text.trim()} ${lines[companyIdx].text.trim()}`)
        used.add(a)
      }
    } else if (dw) {
      out.company = cap(dw)
    }
  }
  if (out.company) {
    // Trademark marks are often misread as quotes: "POOL SUPPLY®" -> "Pool Supply'".
    out.company = out.company.replace(/[\s®™©"'’`]+$/, '').replace(/\s*[®™©]\s*/g, ' ').trim()
    // A stray mark inside a word ("RFI)d"): drop it, and match the word's capitals ("RFID").
    out.company = out.company.replace(/([A-Za-z])[)(\][|}{!]([A-Za-z])/g, '$1$2').replace(/\b[A-Z]{2,}[a-z]\b/g, (w) => w.toUpperCase())
    out.company = companyCase(out.company)
    // A script or stylized word the reader missed ("Warehouse" above "POOL SUPPLY"):
    // the domain spells it out (warehousepoolsupply.com -> "Warehouse Pool Supply").
    const sq = squash(out.company)
    const missing = dw.length - sq.length
    if (sq.length >= 4 && dw.endsWith(sq) && missing >= 3 && missing <= 12) out.company = `${cap(dw.slice(0, missing))} ${out.company}`
  }
  // Mark lines that are the company name (or part of it) as used.
  if (out.company) {
    const cq = squash(out.company)
    lines.forEach((l, i) => {
      const lq = squash(l.text)
      if (lq === cq || (lq.length >= 4 && cq.includes(lq))) used.add(i)
    })
  }

  // Street and suite go in separate fields.
  if (out.street) {
    const [st, su] = splitSuite(out.street)
    out.street = st
    out.suite = su || out.suite
  }
  // A "Suite" whose number was lost ("…Rd N, Suite") is dropped rather than kept half-read.
  out.street = out.street.replace(/,?\s*\b(suite|ste\.?|unit|apt\.?|#)\s*$/i, '').trim()

  // 7. Everything left goes to Notes so nothing is lost.
  // Skip tiny fragments (logo bits, OCR noise); keep anything with real content.
  // Also skip a line that's a near-copy of one already used (two OCR passes read it slightly differently).
  const sq = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '')
  const seen = lines.filter((_, i) => used.has(i)).map((l) => sq(l.text))
  const usedWords = new Set(lines.filter((_, i) => used.has(i)).flatMap((l) => l.text.toLowerCase().match(/[a-z]{3,}|\d{3,}/g) ?? []))
  // The address line had "Texas" shortened to "TX": count the full state name as used too.
  for (const [name, code] of Object.entries(STATE_NAMES)) if (code === out.region) name.split(' ').forEach((w) => usedWords.add(w))
  const leftovers: string[] = []
  lines.forEach((l, i) => {
    const q = sq(l.text)
    if (used.has(i) || q.length < 4) return
    // Logo and artwork scraps ("rer = AE Es", "X Bad"): no real word, number or email in them.
    if (!/[A-Za-z]{4,}|\d{3,}|@/.test(l.text)) return
    // Another reading of a line already used ("224949 Greenhouse Road « pe Texas 7708.").
    const words = l.text.toLowerCase().match(/[a-z]{3,}|\d{3,}/g) ?? []
    if (words.length >= 3 && words.filter((w) => usedWords.has(w)).length >= words.length * 0.6) return
    if (seen.some((p) => p.length >= 6 && editDistance(p, q) <= Math.max(1, Math.floor(Math.max(p.length, q.length) * 0.1)))) return
    seen.push(q)
    leftovers.push(l.text)
  })
  const noteParts = [...new Set(extras), ...(leftovers.length ? [`Other text on card: ${leftovers.join(' / ')}`] : [])]
  out.notes = noteParts.join('\n')
  return out
}
