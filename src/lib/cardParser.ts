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
  /\b(ceo|cfo|coo|cto|cio|cmo|vp|svp|evp|president|vice|director|manager|mgr|engineer|developer|designer|consultant|founder|co-founder|owner|partner|principal|associate|analyst|specialist|coordinator|officer|representative|rep|executive|agent|realtor|broker|advisor|adviser|attorney|lawyer|counsel|accountant|cpa|architect|administrator|admin|assistant|supervisor|superintendent|lead|head|chief|sales|marketing|account|technician|nurse|doctor|dds|md|phd|recruiter|strategist|producer|editor|instructor|professor|teacher|pastor|minister|chairman|chair|treasurer|secretary|operations|business development|loan officer|mortgage|insurance|estimator|foreman|inspector|dentist|physician|therapist|pharmacist|planner)\b/i

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

const TLD = /^[a-z0-9.-]*\.(com|net|org|io|co|us|biz|info|edu|gov|ai|app|dev|me)$/i

/** Glare or a line break can split "jane.doe@acme" / "roofing.com" across two lines; rejoin them. */
function joinSplitEmails(lines: { text: string; height: number }[]) {
  const out: { text: string; height: number }[] = []
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
      out.push({ text: left + right.slice(overlap), height: cur.height })
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
    first_name: '', last_name: '', company: '', title: '', email: '', phone: '',
    street: '', city: '', region: '', postal_code: '', country: '', notes: '',
  }

  const lines = joinSplitEmails(
    input
      .map((l) => ({ text: repairLine(l.text), height: l.height ?? 0 }))
      // Drop OCR noise: lines with almost no letters/digits, or mostly symbols.
      .filter((l) => {
        const alnum = l.text.replace(/[^A-Za-z0-9]/g, '').length
        return alnum >= 2 && alnum >= l.text.replace(/\s/g, '').length * 0.6
      }),
  )
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
    if (p !== best && p.value !== best?.value) extras.push(`${p.kind === 'other' ? 'Phone' : p.kind[0].toUpperCase() + p.kind.slice(1)}: ${p.value}`)
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
      const m = tail.match(CITY_STATE_ZIP)
      if (!m) continue
      const cityPart = m[1].trim()
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
      out.region = m[2].toUpperCase()
      out.postal_code = m[4] && m[4] !== '0000' ? `${m[3]}-${m[4]}` : m[3]
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

  // 4. Title: a line with job-title words.
  const titleIdx = lines.findIndex((l, i) => !used.has(i) && TITLE_WORDS.test(l.text) && !COMPANY_WORDS.test(l.text) && l.text.length <= 60)

  // 5. Name. Candidates: a "First Last" line, or two single words on consecutive lines
  // ("DANIEL" / "Quam": the bigger/top word is the first name). Clues: matches the email,
  // sits next to the title, big text, near the top.
  const maxH = Math.max(1, ...lines.map((l) => l.height))
  const emailName = emailLocal ? nameFromEmail(emailLocal) : null
  type Cand = { idx: number[]; first: string; last: string; score: number }
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
    const { first, last } = splitName(titleCaseIfShouting(l.text))
    cands.push({ idx: [i], first, last, score: scoreOf(l.text, [i], l.height) })
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
  if (pick && (pick.score >= 1 || !emailName)) {
    out.first_name = pick.first
    out.last_name = pick.last
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
    out.title = titleCaseIfShouting(lines[titleIdx].text)
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
    } else if (dw) {
      out.company = cap(dw)
    }
  }
  // Mark lines that are exactly the company name as used.
  if (out.company) lines.forEach((l, i) => squash(l.text) === squash(out.company) && used.add(i))

  // 7. Everything left goes to Notes so nothing is lost.
  // Skip tiny fragments (logo bits, OCR noise); keep anything with real content.
  const leftovers = lines
    .filter((l, i) => !used.has(i) && l.text.replace(/[^A-Za-z0-9]/g, '').length >= 4)
    .map((l) => l.text)
  const noteParts = [...new Set(extras), ...(leftovers.length ? [`Other text on card: ${leftovers.join(' / ')}`] : [])]
  out.notes = noteParts.join('\n')
  return out
}
