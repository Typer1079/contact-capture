export type ContactSource = 'manual' | 'license' | 'card' | 'voice'

export interface ContactDraft {
  first_name: string
  last_name: string
  company: string
  title: string
  email: string
  phone: string
  street: string
  city: string
  region: string
  postal_code: string
  country: string
  notes: string
  source: ContactSource
  consent_at: string | null
}

export interface Contact extends ContactDraft {
  id: string
  created_at: string
  updated_at: string
}

export const TEXT_FIELDS = [
  'first_name',
  'last_name',
  'company',
  'title',
  'email',
  'phone',
  'street',
  'city',
  'region',
  'postal_code',
  'country',
  'notes',
] as const satisfies readonly (keyof ContactDraft)[]

export type TextField = (typeof TEXT_FIELDS)[number]

export const MAX_LENGTH: Record<TextField, number> = {
  first_name: 100,
  last_name: 100,
  company: 200,
  title: 200,
  email: 254,
  phone: 40,
  street: 200,
  city: 100,
  region: 100,
  postal_code: 20,
  country: 100,
  notes: 2000,
}

export function emptyDraft(source: ContactSource = 'manual'): ContactDraft {
  return {
    first_name: '',
    last_name: '',
    company: '',
    title: '',
    email: '',
    phone: '',
    street: '',
    city: '',
    region: '',
    postal_code: '',
    country: '',
    notes: '',
    source,
    consent_at: null,
  }
}

export function displayName(c: Pick<ContactDraft, 'first_name' | 'last_name' | 'company'>): string {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ')
  return name || c.company || '(no name)'
}
