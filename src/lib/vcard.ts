import { type ContactDraft, type CustomFieldDef } from './types'

/** Phone labels iPhone and Android understand as standard types. */
const TEL_TYPES: Record<string, string> = {
  mobile: 'CELL', cell: 'CELL', work: 'WORK,VOICE', office: 'WORK,VOICE', direct: 'WORK,VOICE', main: 'MAIN',
  home: 'HOME,VOICE', fax: 'WORK,FAX', 'work fax': 'WORK,FAX', 'home fax': 'HOME,FAX', pager: 'PAGER',
}

/** Escapes a vCard 3.0 text value. */
export function vEscape(v: string): string {
  return (v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

/**
 * Builds a vCard 3.0 (the version both iOS and Android import most reliably).
 * Date of birth and license number are never included: a phone contact syncs to the cloud
 * and is easy to share, so those stay in the app.
 */
export function toVCard(c: ContactDraft, customDefs: CustomFieldDef[] = []): string {
  const fn = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${vEscape(c.last_name)};${vEscape(c.first_name)};;;`,
    `FN:${vEscape(fn)}`,
  ]
  if (c.company || c.department) lines.push(`ORG:${vEscape(c.company)}${c.department ? `;${vEscape(c.department)}` : ''}`)
  if (c.title) lines.push(`TITLE:${vEscape(c.title)}`)
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${vEscape(c.email)}`)
  let item = 0
  c.phones.filter((p) => p.number).forEach((p, i) => {
    // Extensions use the comma "pause" so tapping the number dials the extension too.
    const value = vEscape(p.ext ? `${p.number},${p.ext}` : p.number).replace(/\\,/g, ',')
    const type = TEL_TYPES[p.label.trim().toLowerCase()]
    const pref = i === 0 ? ',PREF' : ''
    if (type) lines.push(`TEL;TYPE=${type}${pref}:${value}`)
    else {
      item++
      lines.push(`item${item}.TEL${pref ? ';TYPE=PREF' : ''}:${value}`, `item${item}.X-ABLabel:${vEscape(p.label)}`)
    }
  })
  for (const a of c.addresses) {
    // ADR parts: PO box ; extended (suite) ; street ; city ; region ; postal code ; country
    const value = `;${vEscape(a.suite)};${vEscape(a.street)};${vEscape(a.city)};${vEscape(a.region)};${vEscape(a.postal_code)};${vEscape(a.country)}`
    const std = a.label.trim().toLowerCase()
    if (std === 'home' || std === 'work') lines.push(`ADR;TYPE=${std.toUpperCase()}:${value}`)
    else {
      // Custom labels (e.g. "Warehouse") use the itemN.X-ABLabel convention iPhone understands.
      item++
      lines.push(`item${item}.ADR:${value}`, `item${item}.X-ABLabel:${vEscape(a.label)}`)
    }
  }
  const extra = [
    c.hire_date && `Hire date: ${c.hire_date}`,
    c.home_state && `Home state: ${c.home_state}`,
    ...customDefs.filter((d) => c.custom[d.id]).map((d) => `${d.label}: ${c.custom[d.id]}`),
  ].filter(Boolean)
  const note = [c.notes, ...extra].filter(Boolean).join('\n')
  if (note) lines.push(`NOTE:${vEscape(note)}`)
  lines.push('END:VCARD')
  return lines.join('\r\n') + '\r\n'
}

export function vcardFileName(c: ContactDraft): string {
  const base = [c.first_name, c.last_name].filter(Boolean).join('-') || c.company || 'contact'
  return base.replace(/[^\p{L}\p{N}-]+/gu, '_').slice(0, 60) + '.vcf'
}
