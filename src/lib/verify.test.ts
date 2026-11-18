import { describe, expect, it } from 'vitest'
import { mergeReadings, plausiblePhone, suspiciousFields, zipMatchesState } from './verify'

const base = { first_name: 'Daniel', last_name: 'Quam', company: 'Guardian RFID', email: 'daniel.quam@guardianrfid.com', phone: '(832) 594-1714', city: 'Maple Grove', region: 'MN', postal_code: '55311' }

describe('accuracy checks', () => {
  it('knows which ZIP codes belong to which state', () => {
    expect(zipMatchesState('77479', 'TX')).toBe(true)
    expect(zipMatchesState('55311', 'MN')).toBe(true)
    expect(zipMatchesState('55311', 'TX')).toBe(false)
    expect(zipMatchesState('123', 'TX')).toBeNull()
  })

  it('rejects impossible phone numbers', () => {
    expect(plausiblePhone('(832) 594-1714')).toBe(true)
    expect(plausiblePhone('+1 281 555 0100')).toBe(true)
    expect(plausiblePhone('(132) 594-1714')).toBe(false)
    expect(plausiblePhone('594-1714')).toBe(false)
  })

  it('passes a clean reading', () => {
    expect(suspiciousFields(base)).toEqual([])
  })

  it('flags a ZIP/state mismatch, OCR junk in names, and an off company', () => {
    expect(suspiciousFields({ ...base, postal_code: '75311' })).toEqual(expect.arrayContaining(['postal_code', 'region']))
    expect(suspiciousFields({ ...base, last_name: 'Qu4m' })).toContain('last_name')
    expect(suspiciousFields({ ...base, city: 'Madde owe' })).toContain('city')
    expect(suspiciousFields({ ...base, region: 'NN' })).toContain('region')
    expect(suspiciousFields({ ...base, city: 'Port of Spain' })).not.toContain('city')
    expect(suspiciousFields({ ...base, company: 'One Mission' })).toContain('company')
    expect(suspiciousFields({ ...base, email: 'daniel.quam@guardianrfid' })).toContain('email')
  })

  it('takes the value most readings agree on and marks disagreements', () => {
    const a = { ...base, postal_code: '55311', phone: '(832) 594-1714' }
    const b = { ...base, postal_code: '55321', phone: '832.594.1714' }
    const c = { ...base, postal_code: '55311', phone: '(832) 594-1714' }
    const { merged, disputed } = mergeReadings([a, b, c], b, ['postal_code', 'phone', 'email'])
    expect(merged.postal_code).toBe('55311')
    expect(merged.phone).toBe('832.594.1714') // same number; keeps the preferred formatting
    expect(disputed).toEqual(['postal_code'])
  })
})
