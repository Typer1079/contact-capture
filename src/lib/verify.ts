/**
 * Post-scan accuracy checks. Text reading can swap a digit or a letter, so after a scan
 * these rules look for values that can't be right (a ZIP code from another state, an
 * impossible phone number…) and mark those fields "check this" on the review screen.
 * They never change a value on their own.
 */

/** First three ZIP digits for each state (USPS ranges). */
const ZIP3: Record<string, [number, number][]> = {
  AL: [[350, 369]], AK: [[995, 999]], AZ: [[850, 865]], AR: [[716, 729]], CA: [[900, 961]], CO: [[800, 816]],
  CT: [[60, 69]], DE: [[197, 199]], DC: [[200, 205]], FL: [[320, 349]], GA: [[300, 319], [398, 399]], HI: [[967, 968]],
  ID: [[832, 838]], IL: [[600, 629]], IN: [[460, 479]], IA: [[500, 528]], KS: [[660, 679]], KY: [[400, 427]],
  LA: [[700, 714]], ME: [[39, 49]], MD: [[206, 219]], MA: [[10, 27], [55, 55]], MI: [[480, 499]], MN: [[550, 567]],
  MS: [[386, 397]], MO: [[630, 658]], MT: [[590, 599]], NE: [[680, 693]], NV: [[889, 898]], NH: [[30, 38]],
  NJ: [[70, 89]], NM: [[870, 884]], NY: [[100, 149], [5, 5], [63, 63]], NC: [[270, 289]], ND: [[580, 588]],
  OH: [[430, 459]], OK: [[730, 749]], OR: [[970, 979]], PA: [[150, 196]], RI: [[28, 29]], SC: [[290, 299]],
  SD: [[570, 577]], TN: [[370, 385]], TX: [[750, 799], [733, 733], [885, 885]], UT: [[840, 847]], VT: [[50, 59]],
  VA: [[201, 201], [220, 246]], WA: [[980, 994]], WV: [[247, 268]], WI: [[530, 549]], WY: [[820, 831]],
}

export function zipMatchesState(zip: string, state: string): boolean | null {
  const ranges = ZIP3[state.trim().toUpperCase()]
  const digits = zip.replace(/\D/g, '')
  if (!ranges || digits.length < 5) return null // can't tell
  const p = Number(digits.slice(0, 3))
  return ranges.some(([lo, hi]) => p >= lo && p <= hi)
}

/** US/Canada (NANP): area code and exchange can't start with 0 or 1. */
export function plausiblePhone(phone: string): boolean {
  const d = phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  if (d.length < 10) return false
  return /^[2-9]\d{2}[2-9]\d{6}/.test(d)
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i

export interface Checkable {
  first_name: string
  last_name: string
  company: string
  email: string
  phone: string
  region: string
  postal_code: string
  city: string
}

/** Returns the names of fields whose values look wrong and need a human check. */
export function suspiciousFields(c: Checkable): string[] {
  const out = new Set<string>()
  if (c.email && !EMAIL.test(c.email)) out.add('email')
  if (c.phone && !plausiblePhone(c.phone)) out.add('phone')
  if (c.postal_code && c.region) {
    const ok = zipMatchesState(c.postal_code, c.region)
    if (ok === false) {
      out.add('postal_code')
      out.add('region')
    }
  }
  if (c.postal_code && !/^\d{5}(-\d{4})?$/.test(c.postal_code) && !/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i.test(c.postal_code)) out.add('postal_code')
  // OCR noise in names: digits or stray symbols.
  for (const f of ['first_name', 'last_name', 'city'] as const) if (c[f] && /[^A-Za-zÀ-ÿ'’. -]/.test(c[f])) out.add(f)
  // Company should usually echo a work email's domain; a mismatch is worth a look.
  const domain = c.email.split('@')[1]?.split('.')[0]?.toLowerCase() ?? ''
  const generic = /^(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn|comcast|att|sbcglobal|protonmail)$/
  if (c.company && domain && !generic.test(domain)) {
    const sq = c.company.toLowerCase().replace(/[^a-z0-9]/g, '')
    const initials = c.company.split(/\s+/).map((w) => w[0]?.toLowerCase() ?? '').join('')
    const related = sq.includes(domain) || domain.includes(sq.slice(0, Math.max(4, Math.min(sq.length, 6)))) || domain.startsWith(initials)
    if (!related) out.add('company')
  }
  return [...out]
}

/** Normalizes a value for comparing readings ("(832) 594-1714" == "832.594.1714"). */
export function sameValue(a: string, b: string): boolean {
  return a.toLowerCase().replace(/[^a-z0-9@]/g, '') === b.toLowerCase().replace(/[^a-z0-9@]/g, '')
}

/**
 * Combines several readings of the same card. For each field the value most readings
 * agree on wins (ties go to `preferred`, the most careful reading). Fields where readings
 * disagree are returned as `disputed`.
 */
export function mergeReadings<T extends object>(readings: T[], preferred: T, fields: (keyof T & string)[]): { merged: T; disputed: string[] } {
  const merged = { ...preferred }
  const disputed: string[] = []
  for (const f of fields) {
    const values = readings.map((r) => (r as Record<string, unknown>)[f]).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    if (!values.length) continue
    const groups: { value: string; count: number }[] = []
    for (const v of values) {
      const g = groups.find((x) => sameValue(x.value, v))
      if (g) g.count++
      else groups.push({ value: v, count: 1 })
    }
    groups.sort((a, b) => b.count - a.count)
    const pv = (preferred as Record<string, unknown>)[f]
    const pref = typeof pv === 'string' ? pv : ''
    const top = groups[0]
    const tiedWithPreferred = pref && groups.find((g) => sameValue(g.value, pref))?.count === top.count
    // Keep the preferred reading's formatting when it agrees with the winner.
    const winner = tiedWithPreferred ? pref : top.value
    ;(merged as Record<string, unknown>)[f] = winner
    if (groups.length > 1) disputed.push(f)
  }
  return { merged, disputed }
}
