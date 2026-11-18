import { describe, expect, it } from 'vitest'
import { parseBusinessCard, type CardLine } from './cardParser'

const L = (...rows: (string | [string, number])[]): CardLine[] =>
  rows.map((r) => (typeof r === 'string' ? { text: r, height: 20 } : { text: r[0], height: r[1] }))

describe('parseBusinessCard', () => {
  it('reads a classic card', () => {
    const r = parseBusinessCard(
      L(['ACME ROOFING LLC', 40], ['Jane McDonald', 32], 'Sales Director', 'M: 281-555-0142', 'O: (713) 555-0100 ext 22', 'F: 713.555.0101',
        'jane.mcdonald@acmeroofing.com', 'www.acmeroofing.com', '1500 Main Street, Suite 200', 'Sugar Land, TX 77479'),
    )
    expect(r).toMatchObject({
      first_name: 'Jane',
      last_name: 'McDonald',
      title: 'Sales Director',
      company: 'Acme Roofing LLC',
      email: 'jane.mcdonald@acmeroofing.com',
      phone: '(281) 555-0142',
      street: '1500 Main Street, Suite 200',
      city: 'Sugar Land',
      region: 'TX',
      postal_code: '77479',
      country: 'USA',
    })
    expect(r.notes).toContain('Office: (713) 555-0100 x22')
    expect(r.notes).toContain('Fax: (713) 555-0101')
    expect(r.notes).toContain('Website: www.acmeroofing.com')
  })

  it('finds the company from the email domain when there is no "Inc/LLC"', () => {
    const r = parseBusinessCard(L(['Brightline', 44], 'DAVID CHEN', 'Senior Software Engineer', 'dchen@brightline.io', '+1 832 555 7788'))
    expect(r).toMatchObject({ first_name: 'David', last_name: 'Chen', company: 'Brightline', title: 'Senior Software Engineer', phone: '(832) 555-7788' })
  })

  it('handles a one-line address and OCR noise', () => {
    const r = parseBusinessCard(
      L(['Maria Lopez', 30], 'Realtor®', 'Gulf Coast Realty', 'maria @ gulfcoastrealty . com | 713-555-0199', '2200 Post Oak Blvd, Houston, TX 77056-1234'),
    )
    expect(r).toMatchObject({
      first_name: 'Maria', last_name: 'Lopez', email: 'maria@gulfcoastrealty.com', phone: '(713) 555-0199',
      company: 'Gulf Coast Realty', street: '2200 Post Oak Blvd', city: 'Houston', region: 'TX', postal_code: '77056-1234',
    })
  })

  it('keeps suffixes with the last name', () => {
    const r = parseBusinessCard(L(['Robert Smith Jr.', 30], 'Owner', 'Smith Plumbing Co.', '(281) 555-0000'))
    expect(r).toMatchObject({ first_name: 'Robert', last_name: 'Smith Jr.', title: 'Owner', company: 'Smith Plumbing Co.' })
  })

  it('repairs common OCR slips', () => {
    const r = parseBusinessCard(L(['Pat Kim', 30], 'Owner', 'M: 281-555-0001', '0: 713-555-0002', 'www.kimco .com', 'pat@kimco.com'))
    expect(r.phone).toBe('(281) 555-0001')
    expect(r.notes).toContain('Office: (713) 555-0002')
    expect(r.notes).toContain('Website: www.kimco.com')
  })

  it('puts unknown text in notes instead of dropping it', () => {
    const r = parseBusinessCard(L(['Pat Kim', 30], 'Quality you can trust since 1998', 'pat@kimco.com'))
    expect(r.notes).toContain('Quality you can trust since 1998')
  })
})
