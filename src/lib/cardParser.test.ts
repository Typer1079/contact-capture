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
      street: '1500 Main Street',
      suite: 'Suite 200',
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

  it('reads an ID badge: stacked name, split email, company from the email domain', () => {
    // Lines as the text reader returned them for a real badge photo (with its misreads).
    const r = parseBusinessCard(
      L('ONE TEAM', ['DANIEL', 90], ['Quam', 45], 'ONE M', '832.594.1714', 'daniel.quam@guardianrfi', 'id.com', 'HIRE DATE: 1.15.21 HOME STATE: TX',
        ['GUARDIAN RFIL, 6900 Wedgwood Rd. N, Suite 325, Maple Grove, MN 55311', 12]),
    )
    expect(r).toMatchObject({
      first_name: 'Daniel', last_name: 'Quam', company: 'Guardian RFID', email: 'daniel.quam@guardianrfid.com', phone: '(832) 594-1714',
      street: '6900 Wedgwood Rd. N', suite: 'Suite 325', city: 'Maple Grove', region: 'MN', postal_code: '55311',
      hire_date: '2021-01-15', home_state: 'TX', is_id: false,
    })
    expect(r.notes).not.toContain('HIRE DATE')
  })

  it('keeps an address whose ZIP was misread (so it can be marked "Check")', () => {
    const r = parseBusinessCard(L(['Pat Kim', 30], 'pat@kimco.com', 'GUARDIAN RFIL, 6900 Wedgwood Rd N, Suite', 'Maple Grove, MN 5S311'))
    expect(r).toMatchObject({ city: 'Maple Grove', region: 'MN', postal_code: '55311', street: '6900 Wedgwood Rd N' })
    const short = parseBusinessCard(L(['Pat Kim', 30], 'pat@kimco.com', 'Maple Grove, MN 5531'))
    expect(short).toMatchObject({ city: 'Maple Grove', postal_code: '5531' })
  })

  it('removes stray brackets around the @ in an email', () => {
    expect(parseBusinessCard(L(['Pat Kim', 30], 'pat.kim(@kimco.com')).email).toBe('pat.kim@kimco.com')
  })

  it('finishes a company name cut short, using the email domain', () => {
    const r = parseBusinessCard(L(['Pat Kim', 30], 'pat.kim@guardianrfid.com', 'GUARDIAN RFI'))
    expect(r.company).toBe('Guardian RFID')
  })

  it('reads a hire date even when OCR drops a dot', () => {
    expect(parseBusinessCard(L(['Pat Kim', 30], 'HIRE DATE: 1.1521 HOME STATE: TX', 'pat@kimco.com'))).toMatchObject({ hire_date: '2021-01-15', home_state: 'TX' })
  })

  it('reads the printed front of a Texas driver license', () => {
    const r = parseBusinessCard(
      L('TEXAS', 'USA DRIVER LICENSE', '4d DLN 12345678', '3 DOB 01/15/1990', ['1 SAMPLE', 30], ['2 TEST PERSON', 30], '8 100 EXAMPLE ST APT 4', 'SUGAR LAND, TX 77478',
        '15 SEX M 16 HGT 5-10', '18 EYES BRO', '4b EXP 01/15/2030'),
    )
    expect(r).toMatchObject({
      is_id: true, first_name: 'Test', last_name: 'Sample', dob: '1990-01-15', dl_number: '12345678',
      street: '100 Example St', suite: 'Apt 4', city: 'Sugar Land', region: 'TX', postal_code: '77478',
      sex: 'Male', height: `5'10"`, eye_color: 'Brown',
    })
  })

  it('uses the larger stacked word as the first name', () => {
    const r = parseBusinessCard(L(['Smith', 30], ['JOHN', 60], '713-555-0000'))
    expect(r).toMatchObject({ first_name: 'John', last_name: 'Smith' })
  })

  it('takes the name from the email when the card text is unreadable', () => {
    const r = parseBusinessCard(L(['Xq Zr', 40], 'sarah.jones@pinnaclebuilders.com', '281-555-0111'))
    expect(r).toMatchObject({ first_name: 'Sarah', last_name: 'Jones', company: 'Pinnaclebuilders' })
  })

  it('puts unknown text in notes instead of dropping it', () => {
    const r = parseBusinessCard(L(['Pat Kim', 30], 'Quality you can trust since 1998', 'pat@kimco.com'))
    expect(r.notes).toContain('Quality you can trust since 1998')
  })
})
