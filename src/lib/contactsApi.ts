import { supabase } from './supabase'
import { TEXT_FIELDS, type Contact, type ContactDraft } from './types'

const COLUMNS = ['id', ...TEXT_FIELDS, 'source', 'consent_at', 'created_at', 'updated_at'].join(',')

function toRow(d: ContactDraft): ContactDraft {
  // Only send known columns; owner_id is set by the database from the signed-in user.
  const row = { source: d.source, consent_at: d.consent_at } as ContactDraft
  for (const f of TEXT_FIELDS) row[f] = d[f]
  return row
}

export async function listContacts(): Promise<Contact[]> {
  const { data, error } = await supabase
    .from('contacts')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(5000)
  if (error) throw error
  return (data ?? []) as unknown as Contact[]
}

export async function saveContact(draft: ContactDraft, id?: string): Promise<Contact> {
  const query = id
    ? supabase.from('contacts').update(toRow(draft)).eq('id', id)
    : supabase.from('contacts').insert(toRow(draft))
  const { data, error } = await query.select(COLUMNS).single()
  if (error) throw error
  return data as unknown as Contact
}

export async function deleteContacts(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const { error } = await supabase.from('contacts').delete().in('id', ids)
  if (error) throw error
}
