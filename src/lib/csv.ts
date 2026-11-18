import type { Contact } from './types'

export interface CsvColumn {
  header: string
  value: (c: Contact) => string
}

export interface CsvPreset {
  id: string
  label: string
  columns: CsvColumn[]
}

const address = (c: Contact) => [c.street, c.city, c.region, c.postal_code, c.country].filter(Boolean).join(', ')

export const CSV_PRESETS: CsvPreset[] = [
  {
    id: 'generic',
    label: 'All fields',
    columns: [
      { header: 'First Name', value: (c) => c.first_name },
      { header: 'Last Name', value: (c) => c.last_name },
      { header: 'Company', value: (c) => c.company },
      { header: 'Title', value: (c) => c.title },
      { header: 'Email', value: (c) => c.email },
      { header: 'Phone', value: (c) => c.phone },
      { header: 'Street', value: (c) => c.street },
      { header: 'City', value: (c) => c.city },
      { header: 'State/Region', value: (c) => c.region },
      { header: 'Postal Code', value: (c) => c.postal_code },
      { header: 'Country', value: (c) => c.country },
      { header: 'Notes', value: (c) => c.notes },
      { header: 'Source', value: (c) => c.source },
      { header: 'Created', value: (c) => c.created_at },
    ],
  },
  {
    id: 'google',
    label: 'Google Contacts',
    columns: [
      { header: 'First Name', value: (c) => c.first_name },
      { header: 'Last Name', value: (c) => c.last_name },
      { header: 'Organization Name', value: (c) => c.company },
      { header: 'Organization Title', value: (c) => c.title },
      { header: 'E-mail 1 - Value', value: (c) => c.email },
      { header: 'Phone 1 - Value', value: (c) => c.phone },
      { header: 'Address 1 - Formatted', value: address },
      { header: 'Notes', value: (c) => c.notes },
    ],
  },
  {
    id: 'outlook',
    label: 'Outlook',
    columns: [
      { header: 'First Name', value: (c) => c.first_name },
      { header: 'Last Name', value: (c) => c.last_name },
      { header: 'Company', value: (c) => c.company },
      { header: 'Job Title', value: (c) => c.title },
      { header: 'E-mail Address', value: (c) => c.email },
      { header: 'Mobile Phone', value: (c) => c.phone },
      { header: 'Business Street', value: (c) => c.street },
      { header: 'Business City', value: (c) => c.city },
      { header: 'Business State', value: (c) => c.region },
      { header: 'Business Postal Code', value: (c) => c.postal_code },
      { header: 'Business Country/Region', value: (c) => c.country },
      { header: 'Notes', value: (c) => c.notes },
    ],
  },
]

/**
 * Escapes one CSV cell.
 * - Cells that start with = + - @ tab or CR are prefixed with ' so spreadsheet
 *   apps treat them as text, not formulas (CSV/formula injection).
 * - Cells containing a comma, quote, or newline are quoted, with quotes doubled.
 */
export function csvCell(raw: string): string {
  let v = raw ?? ''
  // Plain international phone numbers ("+1 281 555 0100") are safe and left as-is.
  const isPhone = /^\+[\d\s().-]+$/.test(v)
  if (!isPhone && /^[=+\-@\t\r]/.test(v)) v = `'${v}`
  if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`
  return v
}

export function toCsv(contacts: Contact[], preset: CsvPreset): string {
  const lines = [preset.columns.map((col) => csvCell(col.header)).join(',')]
  for (const c of contacts) lines.push(preset.columns.map((col) => csvCell(col.value(c))).join(','))
  // UTF-8 BOM so Excel reads accented names correctly; CRLF per RFC 4180.
  return '﻿' + lines.join('\r\n') + '\r\n'
}
