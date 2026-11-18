import type { ContactDraft } from './types'

/** Escapes a vCard 3.0 text value. */
export function vEscape(v: string): string {
  return (v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

/** Builds a vCard 3.0 (the version both iOS and Android import most reliably). */
export function toVCard(c: ContactDraft): string {
  const fn = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${vEscape(c.last_name)};${vEscape(c.first_name)};;;`,
    `FN:${vEscape(fn)}`,
  ]
  if (c.company) lines.push(`ORG:${vEscape(c.company)}`)
  if (c.title) lines.push(`TITLE:${vEscape(c.title)}`)
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${vEscape(c.email)}`)
  if (c.phone) lines.push(`TEL;TYPE=CELL:${vEscape(c.phone)}`)
  if (c.street || c.city || c.region || c.postal_code || c.country) {
    lines.push(
      `ADR;TYPE=WORK:;;${vEscape(c.street)};${vEscape(c.city)};${vEscape(c.region)};${vEscape(c.postal_code)};${vEscape(c.country)}`,
    )
  }
  if (c.notes) lines.push(`NOTE:${vEscape(c.notes)}`)
  lines.push('END:VCARD')
  return lines.join('\r\n') + '\r\n'
}

export function vcardFileName(c: ContactDraft): string {
  const base = [c.first_name, c.last_name].filter(Boolean).join('-') || c.company || 'contact'
  return base.replace(/[^\p{L}\p{N}-]+/gu, '_').slice(0, 60) + '.vcf'
}
