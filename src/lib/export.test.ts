import { describe, expect, it } from 'vitest'
import { CSV_PRESETS, csvCell, toCsv } from './csv'
import { emptyDraft, type Contact } from './types'
import { toVCard } from './vcard'

const contact: Contact = {
  ...emptyDraft(),
  id: '1',
  created_at: '2026-11-17T00:00:00Z',
  updated_at: '2026-11-17T00:00:00Z',
  first_name: 'José',
  last_name: 'O"Brien',
  company: 'Acme, Inc.',
  email: 'jose@example.com',
  phone: '+1 281 555 0100',
  notes: '=HYPERLINK("http://evil")',
}

describe('csv', () => {
  it('neutralizes formula injection', () => {
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('-2')).toBe("'-2")
    expect(csvCell('+cmd|calc')).toBe("'+cmd|calc")
  })

  it('leaves international phone numbers alone', () => {
    expect(csvCell('+1 281 555 0100')).toBe('+1 281 555 0100')
  })

  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
  })

  it('builds a file with BOM and header', () => {
    const csv = toCsv([contact], CSV_PRESETS[0])
    expect(csv.startsWith('﻿First Name,Last Name')).toBe(true)
    expect(csv).toContain('"Acme, Inc."')
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`)
  })
})

describe('vcard', () => {
  it('escapes special characters', () => {
    const v = toVCard(contact)
    expect(v).toContain('N:O"Brien;José;;;')
    expect(v).toContain('ORG:Acme\\, Inc.')
    expect(v).toContain('TEL;TYPE=CELL:+1 281 555 0100')
    expect(v.startsWith('BEGIN:VCARD\r\nVERSION:3.0')).toBe(true)
  })
})

describe('addresses, sensitive fields and custom fields in exports', () => {
  const defs = [{ id: 'f1', label: 'Badge #', kind: 'text' as const, position: 0 }]
  const c: Contact = {
    ...contact,
    addresses: [
      { id: 'a', label: 'Work', street: '6900 Wedgwood Rd N', suite: 'Suite 325', city: 'Maple Grove', region: 'MN', postal_code: '55311', country: 'USA' },
      { id: 'b', label: 'Home', street: '100 Example St', suite: '', city: 'Sugar Land', region: 'TX', postal_code: '77478', country: 'USA' },
      { id: 'c', label: 'Warehouse', street: '1 Dock Rd', suite: '', city: 'Houston', region: 'TX', postal_code: '77002', country: 'USA' },
    ],
    hire_date: '2021-01-15',
    home_state: 'TX',
    dob: '1990-01-15',
    dl_number: '12345678',
    custom: { f1: 'B-42' },
  }

  it('puts Work, Home and other addresses in their own columns', () => {
    const csv = toCsv([c], CSV_PRESETS[0], { customDefs: defs })
    const [header, row] = csv.replace('﻿', '').split('\r\n')
    expect(header).toContain('Work Street,Work Suite,Work City')
    expect(header).toContain('Home Street')
    expect(header).toContain('Address 3 Label')
    expect(header).toContain('Badge #')
    expect(row).toContain('Suite 325')
    expect(row).toContain('Warehouse')
    expect(row).toContain('B-42')
    expect(row).toContain('2021-01-15')
  })

  it('leaves out DOB and license number unless asked', () => {
    expect(toCsv([c], CSV_PRESETS[0])).not.toContain('12345678')
    expect(toCsv([c], CSV_PRESETS[0])).not.toContain('1990-01-15')
    const withSensitive = toCsv([c], CSV_PRESETS[0], { includeSensitive: true })
    expect(withSensitive).toContain('12345678')
    expect(withSensitive).toContain('1990-01-15')
  })

  it('maps Home and Work to Outlook columns', () => {
    const csv = toCsv([c], CSV_PRESETS[2])
    expect(csv).toContain('"6900 Wedgwood Rd N, Suite 325"')
    expect(csv).toContain('Sugar Land')
  })

  it('writes labeled addresses to the phone card but never DOB or license number', () => {
    const v = toVCard(c, defs)
    expect(v).toContain('ADR;TYPE=WORK:;Suite 325;6900 Wedgwood Rd N;Maple Grove;MN;55311;USA')
    expect(v).toContain('ADR;TYPE=HOME:')
    expect(v).toContain('item1.X-ABLabel:Warehouse')
    expect(v).toContain('Badge #: B-42')
    expect(v).not.toContain('12345678')
    expect(v).not.toContain('1990')
  })
})
