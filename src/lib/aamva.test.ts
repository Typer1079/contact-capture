import { describe, expect, it } from 'vitest'
import { parseAamva } from './aamva'

// Synthetic test data (not a real person).
const SAMPLE = [
  '@',
  '\u001e\rANSI 636015090002DL00410278ZT03190008DLDAQ12345678',
  'DCSMCDONALD',
  'DACJANE',
  'DADMARIE',
  'DBB01151990',
  'DBA01152030',
  'DBC2',
  'DAYBRO',
  'DAU065 IN',
  'DAG123 MAIN ST',
  'DAHAPT 4',
  'DAISUGAR LAND',
  'DAJTX',
  'DAK774790000  ',
  'DCGUSA',
].join('\n')

describe('parseAamva', () => {
  it('extracts name, address and physical description', () => {
    expect(parseAamva(SAMPLE)).toEqual({
      first_name: 'Jane',
      last_name: 'McDonald',
      street: '123 Main St, Apt 4',
      city: 'Sugar Land',
      region: 'TX',
      postal_code: '77479',
      country: 'USA',
      sex: 'Female',
      height: `5'5"`,
      weight: '',
      eye_color: 'Brown',
      hair_color: '',
    })
  })

  it('reads weight and hair color when present', () => {
    const r = parseAamva(SAMPLE + '\nDAW145\nDAZBLN')
    expect(r).toMatchObject({ weight: '145 lb', hair_color: 'Blond' })
  })

  it('handles metric height and a weight range', () => {
    const r = parseAamva(SAMPLE.replace('DAU065 IN', 'DAU178 CM') + '\nDCE3')
    expect(r).toMatchObject({ height: '178 cm', weight: '131–160 lb' })
  })

  it('never returns license number, birth date, or expiry', () => {
    const out = JSON.stringify(parseAamva(SAMPLE))
    expect(out).not.toContain('12345678')
    expect(out).not.toContain('01151990')
    expect(out).not.toContain('01152030')
    expect(Object.keys(parseAamva(SAMPLE)!)).not.toContain('license_number')
  })

  it('formats ZIP+4', () => {
    const r = parseAamva(SAMPLE.replace('DAK774790000  ', 'DAK774791234'))
    expect(r?.postal_code).toBe('77479-1234')
  })

  it('handles version-1 full name field', () => {
    const v1 = '@\n\u001e\rANSI 6360150101DL00290192DLDAQ999\nDAADOE,JOHN,Q\nDAIHOUSTON\nDAJTX\n'
    expect(parseAamva(v1)).toMatchObject({ first_name: 'John', last_name: 'Doe', city: 'Houston' })
  })

  it('rejects non-license barcodes', () => {
    expect(parseAamva('hello world')).toBeNull()
    expect(parseAamva('')).toBeNull()
  })
})
