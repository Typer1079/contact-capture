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
