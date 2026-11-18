/**
 * Minimal AAMVA (US/Canada driver's license PDF417) parser.
 *
 * DATA MINIMIZATION: this parser only ever returns the name and mailing address.
 * It deliberately does NOT read or return the license number (DAQ), date of birth
 * (DBB), sex, height, eye color, expiry, or any other element. Those values stay in
 * the raw barcode string, which the scanner drops as soon as parsing finishes.
 */

export interface LicenseContact {
  first_name: string
  last_name: string
  street: string
  city: string
  region: string
  postal_code: string
  country: string
}

// The only AAMVA element IDs this app is allowed to read.
const ALLOWED = new Set([
  'DCS', // family name
  'DAC', // first name
  'DCT', // first + middle (older versions)
  'DAB', // family name (version 1)
  'DAA', // full name "LAST,FIRST,MIDDLE" (version 1)
  'DAG', // street 1
  'DAH', // street 2
  'DAI', // city
  'DAJ', // state / province
  'DAK', // postal code
  'DCG', // country
])

export function isAamva(raw: string): boolean {
  const head = raw.slice(0, 80)
  return /ANSI\s?\d{6}/.test(head) || /AAMVA\s?\d{6}/.test(head) || (/\bDCS|DAA/.test(raw) && /DAJ/.test(raw))
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s\-'’.])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/\bMc(\p{L})/gu, (_, ch: string) => 'Mc' + ch.toUpperCase())
}

function clean(v: string | undefined): string {
  if (!v) return ''
  const t = v.trim()
  // AAMVA uses NONE / UNAVL for missing values.
  if (/^(NONE|UNAVL|UNAVAIL|N\/A)$/i.test(t)) return ''
  return t
}

function formatZip(raw: string, country: string): string {
  const z = raw.replace(/\s+/g, '')
  if (country && country !== 'USA') return z
  const digits = z.replace(/\D/g, '')
  if (digits.length >= 9 && digits.slice(5, 9) !== '0000') return `${digits.slice(0, 5)}-${digits.slice(5, 9)}`
  if (digits.length >= 5) return digits.slice(0, 5)
  return z
}

/** Returns name + address only, or null if the data isn't a readable AAMVA barcode. */
export function parseAamva(raw: string): LicenseContact | null {
  if (!raw || !isAamva(raw)) return null

  const fields: Record<string, string> = {}
  // eslint-disable-next-line no-control-regex -- AAMVA uses record/group separators
  for (const line of raw.split(/[\r\n\u001e\u001d]+/)) {
    // The first element is glued to the subfile header, e.g. "...DL00410278ZT03190008DLDAQ123".
    const m = line.match(/(?:^|DL|ID)(D[A-Z]{2})(.*)$/)
    if (!m) continue
    const [, code, value] = m
    if (ALLOWED.has(code) && !(code in fields)) fields[code] = value
  }

  let last = clean(fields.DCS) || clean(fields.DAB)
  let first = clean(fields.DAC)
  if (!first && fields.DCT) first = clean(fields.DCT.split(/[ ,]/)[0])
  if ((!last || !first) && fields.DAA) {
    const parts = fields.DAA.split(/[,$]/).map((p) => p.trim())
    last ||= clean(parts[0])
    first ||= clean(parts[1])
  }

  const country = clean(fields.DCG).toUpperCase()
  const street = [clean(fields.DAG), clean(fields.DAH)].filter(Boolean).join(', ')

  const result: LicenseContact = {
    first_name: titleCase(first),
    last_name: titleCase(last),
    street: titleCase(street),
    city: titleCase(clean(fields.DAI)),
    region: clean(fields.DAJ).toUpperCase(),
    postal_code: formatZip(clean(fields.DAK), country),
    country: country === 'USA' ? 'USA' : country === 'CAN' ? 'Canada' : country,
  }

  if (!result.first_name && !result.last_name) return null
  return result
}
