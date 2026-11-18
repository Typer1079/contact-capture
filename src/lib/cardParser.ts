/**
 * Turns the text recognized on a business card into contact fields.
 *
 * Cards have no fixed layout, so this uses patterns (emails, phones, ZIP codes) plus
 * clues (job-title words, "Inc"/"LLC", the email's domain, text size) to guess which
 * line is which. Everything it isn't sure about goes into Notes, so nothing is lost.
 */

export interface CardLine {
  text: string
  /** Height of the text in pixels; bigger text is usually the name or company. */
  height?: number
}

export interface CardContact {
  first_name: string
  last_name: string
  company: string
  title: string
  email: string
  phone: string
  street: string
  city: string
  region: string
  postal_code: string
  country: string
  notes: string
}

const TITLE_WORDS =
  /\b(ceo|cfo|coo|cto|cio|cmo|vp|svp|evp|president|vice|director|manager|mgr|engineer|developer|designer|consultant|founder|co-founder|owner|partner|principal|associate|analyst|specialist|coordinator|officer|representative|rep|executive|agent|realtor|broker|advisor|adviser|attorney|lawyer|counsel|accountant|cpa|architect|administrator|admin|assistant|supervisor|superintendent|lead|head|chief|sales|marketing|account|technician|nurse|doctor|dds|md|phd|pe|recruiter|strategist|producer|editor|instructor|professor|teacher|pastor|minister|chairman|chair|treasurer|secretary|operations|business development|loan officer|mortgage|insurance|estimator|foreman|inspector|dentist|physician|therapist|pharmacist|planner)\b/i

const COMPANY_WORDS =
  /\b(inc|llc|l\.l\.c|ltd|llp|pllc|lp|corp|corporation|co|company|group|holdings|partners|associates|solutions|services|systems|technologies|technology|tech|industries|international|enterprises|consulting|labs|studio|agency|bank|realty|properties|construction|energy|logistics|insurance|financial|capital|ventures|clinic|hospital|church|university|college|school|foundation|restaurant|cafe|plumbing|roofing|electric|law firm|dental|medical)(?![a-z-])/i

// Words that should stay in capitals after fixing an ALL-CAPS line.
const KEEP_CAPS = new Set(['LLC', 'LLP', 'PLLC', 'LP', 'USA', 'CPA', 'CEO', 'CFO', 'COO', 'CTO', 'CIO', 'CMO', 'VP', 'SVP', 'EVP', 'PE', 'MD', 'DDS', 'RN', 'II', 'III', 'IV', 'HVAC', 'IT', 'AI', 'HR'])

const STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY'

const CITY_STATE_ZIP = new RegExp(`^(.*?)[,\\s]+(${STATES})\\.?\\s+(\\d{5})(?:[-\\s]?(\\d{4}))?\\b`, 'i')
const STREET =
  /^\s*\d{1,6}[A-Z]?\s+([NSEW]\.?\s+)?[\w.' -]+?\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|pkwy|parkway|hwy|highway|fwy|freeway|ct|court|cir|circle|pl|place|ter|terrace|trl|trail|loop|sq|square|plaza|center|ctr)\b\.?(.*)$/i
const SUITE = /^\s*(suite|ste\.?|unit|apt\.?|#|floor|fl\.?|bldg\.?|building)\s*[\w-]+/i
const PO_BOX = /^\s*p\.?\s*o\.?\s*box\s+\d+/i

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const URL_RE = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|us|biz|info|edu|gov|ai|app|dev|me|tv|law|church|realtor|health)(?:\/[^\s]*)?)\b/i
// US/Canada numbers, with optional +1, separators, and extension.
const PHONE = /(?:\+?1[\s.-]*)?\(?\b(\d{3})\)?[\s.\-–]*(\d{3})[\s.\-–]*(\d{4})\b(?:\s*(?:x|ext\.?|extension)\s*(\d{1,6}))?/gi

type PhoneKind = 'mobile' | 'direct' | 'office' | 'fax' | 'other'

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

/** Fixes common OCR slips: spaced-out "@", "(at)", stray spaces around dots in emails. */
function repairLine(t: string): string {
  return t
    .replace(/[|]/g, ' ')
    .replace(/\s*@\s*/g, '@')
    .replace(/\s*\(at\)\s*/gi, '@')
    .replace(/(@[\w-]+)\s*\.\s*(com|net|org|io|co|us|biz|edu|gov)\b/gi, '$1.$2')
    .replace(/(www\.[\w-]+)\s+\.\s*(com|net|org|io|co|us|biz|edu|gov)\b/gi, '$1.$2')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function titleCaseIfShouting(s: string): string {
  const letters = s.replace(/[^A-Za-z]/g, '')
  if (letters.length > 3 && letters === letters.toUpperCase()) {
    s = s.toLowerCase().replace(/(^|[\s\-'’.])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase())
  }
  return s.replace(/\b[A-Za-z]{2,5}\b/g, (w) => (KEEP_CAPS.has(w.toUpperCase()) ? w.toUpperCase() : w))
}

function looksLikeName(t: string): boolean {
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
  return { first: core[0], last: core.slice(1).join(' ').replace(/^([A-Z]\.?)\s+/, '') + suffix }
}

export function parseBusinessCard(input: CardLine[]): CardContact {
  const out: CardContact = {
    first_name: '', last_name: '', company: '', title: '', email: '', phone: '',
    street: '', city: '', region: '', postal_code: '', country: '', notes: '',
  }

  const lines = input
    .map((l) => ({ text: repairLine(l.text), height: l.height ?? 0 }))
    .filter((l) => l.text.replace(/[^A-Za-z0-9]/g, '').length >= 2)
  const used = new Set<number>()
  const extras: string[] = []

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
  const phones: { kind: PhoneKind; value: string }[] = []
  lines.forEach((l, i) => {
    if (used.has(i)) return
    PHONE.lastIndex = 0
    let m: RegExpExecArray | null
    let found = false
    while ((m = PHONE.exec(l.text))) {
      phones.push({ kind: phoneKind(l.text.slice(0, m.index)), value: formatPhone(m) })
      found = true
    }
    if (found) used.add(i)
  })
  const rank: PhoneKind[] = ['mobile', 'direct', 'office', 'other']
  const best = rank.map((k) => phones.find((p) => p.kind === k)).find(Boolean)
  if (best) out.phone = best.value
  for (const p of phones) {
    if (p !== best) extras.push(`${p.kind === 'other' ? 'Phone' : p.kind[0].toUpperCase() + p.kind.slice(1)}: ${p.value}`)
  }

  // 3. Address: "City, ST 77479" plus the street line(s) above it.
  lines.forEach((l, i) => {
    if (used.has(i) || out.city) return
    // Address may be on one line: "123 Main St, Suite 4, Houston, TX 77002"
    const parts = l.text.split(/\s*[,•·]\s*|\s{2,}/)
    // Try the shortest tail first so "123 Main St, Houston, TX 77002" gives city = "Houston".
    for (let k = parts.length - 1; k >= 0; k--) {
      const tail = parts.slice(k).join(', ')
      const m = tail.match(CITY_STATE_ZIP)
      if (!m) continue
      const cityPart = m[1].trim()
      const head = parts.slice(0, k).join(', ')
      out.city = titleCaseIfShouting(cityPart)
      out.region = m[2].toUpperCase()
      out.postal_code = m[4] && m[4] !== '0000' ? `${m[3]}-${m[4]}` : m[3]
      out.country = 'USA'
      used.add(i)
      if (head) out.street = titleCaseIfShouting(head)
      else {
        // Walk upward to collect street + suite lines.
        const above: string[] = []
        for (let j = i - 1; j >= 0 && j >= i - 2; j--) {
          if (used.has(j)) continue
          const t = lines[j].text
          if (STREET.test(t) || SUITE.test(t) || PO_BOX.test(t)) {
            above.unshift(t)
            used.add(j)
          } else break
        }
        out.street = titleCaseIfShouting(above.join(', '))
      }
      break
    }
  })
  if (!out.street) {
    const i = lines.findIndex((l, idx) => !used.has(idx) && (STREET.test(l.text) || PO_BOX.test(l.text)))
    if (i >= 0) {
      out.street = titleCaseIfShouting(lines[i].text)
      used.add(i)
    }
  }

  // 4. Title: a line with job-title words.
  const titleIdx = lines.findIndex((l, i) => !used.has(i) && TITLE_WORDS.test(l.text) && !COMPANY_WORDS.test(l.text) && l.text.length <= 60)

  // 5. Name: best "First Last" candidate. Clues: matches email, sits right above the title, big text.
  const maxH = Math.max(1, ...lines.map((l) => l.height))
  let nameIdx = -1
  let bestScore = -Infinity
  lines.forEach((l, i) => {
    if (used.has(i) || i === titleIdx || !looksLikeName(l.text) || COMPANY_WORDS.test(l.text)) return
    if (TITLE_WORDS.test(l.text) && !nameMatchesEmail(l.text, emailLocal)) return
    let score = 0
    if (emailLocal && nameMatchesEmail(l.text, emailLocal)) score += 5
    if (titleIdx >= 0 && (i === titleIdx - 1 || i === titleIdx + 1)) score += 3
    if (domain && l.text.toLowerCase().replace(/[^a-z]/g, '').includes(domainWord(domain)) && domainWord(domain)) score -= 4
    score += (l.height / maxH) * 2
    score -= i * 0.1
    if (score > bestScore) {
      bestScore = score
      nameIdx = i
    }
  })
  if (nameIdx >= 0) {
    const { first, last } = splitName(titleCaseIfShouting(lines[nameIdx].text))
    out.first_name = first
    out.last_name = last
    used.add(nameIdx)
  }
  if (titleIdx >= 0) {
    out.title = titleCaseIfShouting(lines[titleIdx].text)
    used.add(titleIdx)
  }

  // 6. Company: a line with company words, or one that matches the email/website domain, or the biggest leftover text.
  const dw = domain ? domainWord(domain) : ''
  let companyIdx = lines.findIndex((l, i) => !used.has(i) && COMPANY_WORDS.test(l.text) && !/\d{3}/.test(l.text))
  if (companyIdx < 0 && dw.length >= 3) {
    companyIdx = lines.findIndex((l, i) => {
      if (used.has(i)) return false
      const squashed = l.text.toLowerCase().replace(/[^a-z0-9]/g, '')
      const initials = l.text.split(/\s+/).map((w) => w[0]?.toLowerCase() ?? '').join('')
      return squashed.includes(dw) || dw.includes(squashed.slice(0, 6)) || (initials.length >= 2 && dw.startsWith(initials))
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
    // Only trust "biggest text" if it's clearly bigger than average.
    const avg = lines.reduce((a, l) => a + l.height, 0) / Math.max(1, lines.length)
    if (companyIdx >= 0 && lines[companyIdx].height < avg * 1.15) companyIdx = -1
  }
  if (companyIdx >= 0) {
    out.company = titleCaseIfShouting(lines[companyIdx].text)
    used.add(companyIdx)
  } else if (dw) {
    out.company = dw.charAt(0).toUpperCase() + dw.slice(1)
  }

  // 7. Everything left goes to Notes so nothing is lost.
  const leftovers = lines.filter((_, i) => !used.has(i)).map((l) => l.text)
  const noteParts = [...extras, ...(leftovers.length ? [`Other text on card: ${leftovers.join(' / ')}`] : [])]
  out.notes = noteParts.join('\n')
  return out
}
