import { supabase } from './supabase'
import { DATE_FIELDS, newId, phoneText, primaryPhone, TEXT_FIELDS, type Contact, type ContactDraft, type CustomFieldDef, type Phone } from './types'

const COLUMNS = ['id', ...TEXT_FIELDS, ...DATE_FIELDS, 'phone', 'phones', 'addresses', 'custom', 'source', 'consent_at', 'created_at', 'updated_at'].join(',')

function toRow(d: ContactDraft) {
  // Only send known columns; owner_id is set by the database from the signed-in user.
  const row: Record<string, unknown> = {
    source: d.source,
    consent_at: d.consent_at,
    addresses: d.addresses,
    phones: d.phones,
    // The old single "phone" column keeps the main number, for anything still reading it.
    phone: (() => {
      const p = primaryPhone(d)
      return p ? phoneText(p).slice(0, 40) : ''
    })(),
    custom: d.custom,
  }
  for (const f of TEXT_FIELDS) row[f] = d[f]
  for (const f of DATE_FIELDS) row[f] = d[f] || null
  return row
}

/** Database rows -> app shape (dates as '' when empty, JSON columns always present). */
function fromRow(r: Record<string, unknown>): Contact {
  const { phone, ...c } = r as unknown as Contact & { phone?: string }
  let phones: Phone[] = Array.isArray(r.phones) ? (r.phones as Phone[]) : []
  // Saved before the phone list existed (and before the database update ran).
  if (!phones.length && phone) phones = [{ id: newId(), label: r.source === 'card' ? 'Work' : 'Mobile', number: phone, ext: '' }]
  return {
    ...c,
    department: (r.department as string | null) ?? '',
    phones,
    hire_date: (r.hire_date as string | null) ?? '',
    dob: (r.dob as string | null) ?? '',
    addresses: Array.isArray(r.addresses) ? (r.addresses as Contact['addresses']) : [],
    custom: r.custom && typeof r.custom === 'object' && !Array.isArray(r.custom) ? (r.custom as Record<string, string>) : {},
  }
}

export async function listContacts(): Promise<Contact[]> {
  const { data, error } = await supabase
    .from('contacts')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(5000)
  if (error) throw error
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(fromRow)
}

export async function saveContact(draft: ContactDraft, id?: string): Promise<Contact> {
  const query = id
    ? supabase.from('contacts').update(toRow(draft)).eq('id', id)
    : supabase.from('contacts').insert(toRow(draft))
  const { data, error } = await query.select(COLUMNS).single()
  if (error) throw error
  return fromRow(data as unknown as Record<string, unknown>)
}

export async function deleteContacts(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const { error } = await supabase.from('contacts').delete().in('id', ids)
  if (error) throw error
}

// ---- Custom field definitions ----------------------------------------------------------------

const DEF_COLUMNS = 'id,label,kind,position'

export async function listFieldDefs(): Promise<CustomFieldDef[]> {
  const { data, error } = await supabase.from('custom_field_defs').select(DEF_COLUMNS).order('position').order('created_at')
  if (error) throw error
  return (data ?? []) as CustomFieldDef[]
}

export async function createFieldDef(label: string, kind: CustomFieldDef['kind'], position: number): Promise<CustomFieldDef> {
  const { data, error } = await supabase.from('custom_field_defs').insert({ label, kind, position }).select(DEF_COLUMNS).single()
  if (error) {
    if (error.code === '23505') throw new Error(`You already have a field called “${label}”.`)
    throw error
  }
  return data as CustomFieldDef
}

export async function renameFieldDef(id: string, label: string): Promise<void> {
  const { error } = await supabase.from('custom_field_defs').update({ label }).eq('id', id)
  if (error) {
    if (error.code === '23505') throw new Error(`You already have a field called “${label}”.`)
    throw error
  }
}

/** Removes the field from the list. Values already saved on contacts are kept but hidden. */
export async function deleteFieldDef(id: string): Promise<void> {
  const { error } = await supabase.from('custom_field_defs').delete().eq('id', id)
  if (error) throw error
}
