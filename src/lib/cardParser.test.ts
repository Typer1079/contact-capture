import { describe, expect, it } from 'vitest'
import { parseBusinessCard, repairState, splitSuite, type CardLine } from './cardParser'

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
    expect(r.phones).toEqual([
      { label: 'Mobile', number: '(281) 555-0142', ext: '' },
      { label: 'Work', number: '(713) 555-0100', ext: '22' },
      { label: 'Fax', number: '(713) 555-0101', ext: '' },
    ])
    expect(r.notes).not.toContain('555-01')
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
    expect(r.phones[1]).toEqual({ label: 'Work', number: '(713) 555-0002', ext: '' })
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

  it('keeps an address whose state was misread (the real badge line)', () => {
    const r = parseBusinessCard(L(['Pat Kim', 30], 'pat@guardianrfid.com', 'GUARUIAN REIL, 6200 Wedgwood RE. 1, Sute 325 Made rove, NN S500'))
    expect(r).toMatchObject({ street: '6200 Wedgwood RE. 1', suite: 'Suite 325', city: 'Made rove', region: 'MN', postal_code: '5500' })
    expect(r.notes).not.toContain('Wedgwood')
  })

  it('repairs misread state codes, using the ZIP to choose', () => {
    expect(repairState('NN', '55311')).toBe('MN')
    expect(repairState('TK', '77479')).toBe('TX')
    expect(repairState('0H', '43004')).toBe('')
    expect(repairState('OH', '43004')).toBe('OH')
    expect(repairState('ZZ', '12345')).toBe('')
  })

  it('separates a suite that runs into the city ("Suite 325 Maple Grove")', () => {
    const r = parseBusinessCard(L(['Pat Kim', 30], 'pat@kimco.com', 'GUARDIAN RFID, 6900 Wedgwood Rd. N, Sute 325 Maple Grove, MN 55311'))
    expect(r).toMatchObject({ street: '6900 Wedgwood Rd. N', suite: 'Suite 325', city: 'Maple Grove', region: 'MN', postal_code: '55311' })
    const two = parseBusinessCard(L(['Pat Kim', 30], 'pat@kimco.com', '6900 Wedgwood Rd. N', 'Ste 4 Houston, TX 77002'))
    expect(two).toMatchObject({ street: '6900 Wedgwood Rd. N', suite: 'Ste 4', city: 'Houston' })
  })

  it('splits a misread "Suite" off the street', () => {
    expect(splitSuite('6900 Wedgwood Rd N, Sute 325')).toEqual(['6900 Wedgwood Rd N', 'Suite 325'])
    expect(splitSuite('1500 Main Street, Suite 200')).toEqual(['1500 Main Street', 'Suite 200'])
    expect(splitSuite('100 Example St Apt 4')).toEqual(['100 Example St', 'Apt 4'])
    expect(splitSuite('12 Unity Ave')).toEqual(['12 Unity Ave', ''])
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

  it('reads a card with a two-line logo name, bullets, a full state name and credentials', () => {
    // Lines as the OCR read Daniel's UIS card (both passes merged, with their slips).
    const r = parseBusinessCard(L(['34', 21], ['Unified', 73], ['Investigations & Sciences, Inc.', 62],
      ['223 E. Greenbriar Lane m Dallas, Texas 75203', 53], ['923 E. Greenbriar Lane m Dallas, Texas 75203', 41],
      ['Office 214-946-8989 m 1-800-615-4840', 33], ['Fax 214-946-8586 m www.uis-usa.com', 31],
      ['aleake @uis-usa.com', 35], ['San Antonio, TX', 31], ['A. Scott Leake, IAAI-CFI', 39], ['A. Scott Leake, JAAI-CFI', 39],
      ['210-659-8677', 29], ['Senior Investigator', 33]))
    expect(r).toMatchObject({
      first_name: 'A. Scott', last_name: 'Leake', title: 'Senior Investigator',
      company: 'Unified Investigations & Sciences, Inc.', email: 'aleake@uis-usa.com', phone: '(210) 659-8677',
      street: '223 E. Greenbriar Lane', city: 'Dallas', region: 'TX', postal_code: '75203',
    })
    expect(r.phones.map((p) => `${p.label} ${p.number}`)).toEqual([
      'Direct (210) 659-8677', 'Work (214) 946-8989', 'Toll-free (800) 615-4840', 'Fax (214) 946-8586',
    ])
    expect(r.notes).toContain('Credentials: IAAI-CFI')
    expect(r.notes).not.toMatch(/Mobile|923 E|JAAI/)
  })

  it('keeps "Texas" in a company name when no ZIP follows it', () => {
    const r = parseBusinessCard(L(['Lee Park', 40], 'Texas Instruments', '12500 TI Blvd, Dallas, TX 75243', 'lee@ti.com'))
    expect(r).toMatchObject({ city: 'Dallas', region: 'TX' })
    expect(JSON.stringify(r)).toContain('Texas Instruments')
  })

  it('keeps a department out of the name and credentials out of the title', () => {
    const r = parseBusinessCard(L(['THE HARTFORD', 60], ['Rick Luna', 34], ['Investigator, MBA, CIF, FCLS', 26], ['Special Investigations Unit', 26],
      '785 Greens Parkway, Suite 210', 'Houston, TX 77067', 'Cell 281-877-3868', '1-800-392-7805 x73808'))
    expect(r).toMatchObject({
      first_name: 'Rick', last_name: 'Luna', title: 'Investigator', department: 'Special Investigations Unit',
      street: '785 Greens Parkway', suite: 'Suite 210', city: 'Houston', region: 'TX', postal_code: '77067',
    })
    expect(r.phones).toEqual([
      { label: 'Mobile', number: '(281) 877-3868', ext: '' },
      { label: 'Toll-free', number: '(800) 392-7805', ext: '73808' },
    ])
    expect(r.notes).toContain('Credentials: MBA, CIF, FCLS')
    expect(r.notes).not.toContain('Rick Luna')
  })

  it('reads extensions written several ways', () => {
    const r = parseBusinessCard(L(['Pat Kim', 30], 'Office 713-555-0100 Ext: 204', 'Direct 713-555-0111, ext. #9', 'pat@kimco.com'))
    expect(r.phones).toEqual([
      { label: 'Direct', number: '(713) 555-0111', ext: '9' },
      { label: 'Work', number: '(713) 555-0100', ext: '204' },
    ])
  })
})

