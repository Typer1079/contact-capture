import { addressByLabel, phonesLabeled, phoneText, streetLine, type Address, type Contact, type CustomFieldDef, type Phone } from './types'

export interface CsvColumn {
  header: string
  value: (c: Contact) => string
}

export interface CsvOptions {
  /** Include date of birth and driver's license number (off by default). */
  includeSensitive?: boolean
  customDefs?: CustomFieldDef[]
}

export interface CsvPreset {
  id: string
  label: string
  columns: (contacts: Contact[], opts: CsvOptions) => CsvColumn[]
}

const blank: Address = { id: '', label: '', street: '', suite: '', city: '', region: '', postal_code: '', country: '' }

/** Column set for one address slot. */
function addressColumns(prefix: string, pick: (c: Contact) => Address | undefined, withLabel = false): CsvColumn[] {
  const get = (c: Contact) => pick(c) ?? blank
  return [
    ...(withLabel ? [{ header: `${prefix} Label`, value: (c: Contact) => get(c).label }] : []),
    { header: `${prefix} Street`, value: (c) => get(c).street },
    { header: `${prefix} Suite`, value: (c) => get(c).suite },
    { header: `${prefix} City`, value: (c) => get(c).city },
    { header: `${prefix} State`, value: (c) => get(c).region },
    { header: `${prefix} Postal Code`, value: (c) => get(c).postal_code },
    { header: `${prefix} Country`, value: (c) => get(c).country },
  ]
}

const phonesOf = (c: Contact) => c.phones.filter((p) => p.number)
const maxPhones = (contacts: Contact[]) => Math.max(1, ...contacts.map((c) => phonesOf(c).length))
const txt = (p: Phone | undefined) => (p ? phoneText(p) : '')
/** Outlook has fixed phone slots; numbers with other labels go to "Other Phone". */
const OUTLOOK_TAKEN = ['mobile', 'cell', 'work', 'office', 'direct', 'main', 'fax', 'home']
const otherPhone = (c: Contact) => phonesOf(c).find((p) => !OUTLOOK_TAKEN.includes(p.label.trim().toLowerCase()))

const otherAddresses = (c: Contact) => c.addresses.filter((a) => !/^(home|work)$/i.test(a.label.trim()))

export const CSV_PRESETS: CsvPreset[] = [
  {
    id: 'generic',
    label: 'All fields',
    columns: (contacts, { includeSensitive, customDefs = [] }) => {
      const maxOther = Math.max(0, ...contacts.map((c) => otherAddresses(c).length))
      return [
        { header: 'First Name', value: (c) => c.first_name },
        { header: 'Last Name', value: (c) => c.last_name },
        { header: 'Company', value: (c) => c.company },
        { header: 'Title', value: (c) => c.title },
        { header: 'Department', value: (c) => c.department },
        { header: 'Email', value: (c) => c.email },
        ...Array.from({ length: maxPhones(contacts) }, (_, i): CsvColumn[] => [
          { header: `Phone ${i + 1} Label`, value: (c) => phonesOf(c)[i]?.label ?? '' },
          { header: `Phone ${i + 1}`, value: (c) => phonesOf(c)[i]?.number ?? '' },
          { header: `Phone ${i + 1} Ext`, value: (c) => phonesOf(c)[i]?.ext ?? '' },
        ]).flat(),
        ...addressColumns('Work', (c) => addressByLabel(c, 'Work')),
        ...addressColumns('Home', (c) => addressByLabel(c, 'Home')),
        ...Array.from({ length: maxOther }, (_, i) => addressColumns(`Address ${i + 3}`, (c) => otherAddresses(c)[i], true)).flat(),
        { header: 'Hire Date', value: (c) => c.hire_date },
        { header: 'Home State', value: (c) => c.home_state },
        ...(includeSensitive
          ? [
              { header: 'Date of Birth', value: (c: Contact) => c.dob },
              { header: "Driver's License #", value: (c: Contact) => c.dl_number },
            ]
          : []),
        { header: 'Sex', value: (c) => c.sex },
        { header: 'Height', value: (c) => c.height },
        { header: 'Weight', value: (c) => c.weight },
        { header: 'Eye Color', value: (c) => c.eye_color },
        { header: 'Hair Color', value: (c) => c.hair_color },
        ...customDefs.map((d) => ({ header: d.label, value: (c: Contact) => c.custom[d.id] ?? '' })),
        { header: 'Notes', value: (c) => c.notes },
        { header: 'Source', value: (c) => c.source },
        { header: 'Created', value: (c) => c.created_at },
      ]
    },
  },
  {
    id: 'google',
    label: 'Google Contacts',
    columns: (contacts, { includeSensitive }) => {
      const max = Math.max(1, ...contacts.map((c) => c.addresses.length))
      return [
        { header: 'First Name', value: (c) => c.first_name },
        { header: 'Last Name', value: (c) => c.last_name },
        { header: 'Organization Name', value: (c) => c.company },
        { header: 'Organization Title', value: (c) => c.title },
        { header: 'Organization Department', value: (c) => c.department },
        { header: 'E-mail 1 - Value', value: (c) => c.email },
        ...Array.from({ length: maxPhones(contacts) }, (_, i): CsvColumn[] => [
          { header: `Phone ${i + 1} - Type`, value: (c) => phonesOf(c)[i]?.label ?? '' },
          { header: `Phone ${i + 1} - Value`, value: (c) => txt(phonesOf(c)[i]) },
        ]).flat(),
        ...Array.from({ length: max }, (_, i): CsvColumn[] => {
          const n = i + 1
          const a = (c: Contact) => c.addresses[i] ?? blank
          return [
            { header: `Address ${n} - Type`, value: (c) => a(c).label },
            { header: `Address ${n} - Street`, value: (c) => streetLine(a(c)) },
            { header: `Address ${n} - City`, value: (c) => a(c).city },
            { header: `Address ${n} - Region`, value: (c) => a(c).region },
            { header: `Address ${n} - Postal Code`, value: (c) => a(c).postal_code },
            { header: `Address ${n} - Country`, value: (c) => a(c).country },
          ]
        }).flat(),
        ...(includeSensitive ? [{ header: 'Birthday', value: (c: Contact) => c.dob }] : []),
        { header: 'Notes', value: (c) => c.notes },
      ]
    },
  },
  {
    id: 'outlook',
    label: 'Outlook',
    columns: (_contacts, { includeSensitive }) => {
      const work = (c: Contact) => addressByLabel(c, 'Work') ?? blank
      const home = (c: Contact) => addressByLabel(c, 'Home') ?? blank
      return [
        { header: 'First Name', value: (c) => c.first_name },
        { header: 'Last Name', value: (c) => c.last_name },
        { header: 'Company', value: (c) => c.company },
        { header: 'Job Title', value: (c) => c.title },
        { header: 'Department', value: (c) => c.department },
        { header: 'E-mail Address', value: (c) => c.email },
        { header: 'Mobile Phone', value: (c) => txt(phonesLabeled(c, 'Mobile', 'Cell')[0]) },
        { header: 'Business Phone', value: (c) => txt(phonesLabeled(c, 'Work', 'Office', 'Direct', 'Main')[0]) },
        { header: 'Business Phone 2', value: (c) => txt(phonesLabeled(c, 'Work', 'Office', 'Direct', 'Main')[1]) },
        { header: 'Business Fax', value: (c) => txt(phonesLabeled(c, 'Fax')[0]) },
        { header: 'Home Phone', value: (c) => txt(phonesLabeled(c, 'Home')[0]) },
        { header: 'Other Phone', value: (c) => txt(otherPhone(c)) },
        { header: 'Business Street', value: (c) => streetLine(work(c)) },
        { header: 'Business City', value: (c) => work(c).city },
        { header: 'Business State', value: (c) => work(c).region },
        { header: 'Business Postal Code', value: (c) => work(c).postal_code },
        { header: 'Business Country/Region', value: (c) => work(c).country },
        { header: 'Home Street', value: (c) => streetLine(home(c)) },
        { header: 'Home City', value: (c) => home(c).city },
        { header: 'Home State', value: (c) => home(c).region },
        { header: 'Home Postal Code', value: (c) => home(c).postal_code },
        { header: 'Home Country/Region', value: (c) => home(c).country },
        ...(includeSensitive ? [{ header: 'Birthday', value: (c: Contact) => c.dob }] : []),
        { header: 'Notes', value: (c) => c.notes },
      ]
    },
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

export function toCsv(contacts: Contact[], preset: CsvPreset, opts: CsvOptions = {}): string {
  const columns = preset.columns(contacts, opts)
  const lines = [columns.map((col) => csvCell(col.header)).join(',')]
  for (const c of contacts) lines.push(columns.map((col) => csvCell(col.value(c))).join(','))
  // UTF-8 BOM so Excel reads accented names correctly; CRLF per RFC 4180.
  return '﻿' + lines.join('\r\n') + '\r\n'
}
