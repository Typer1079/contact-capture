export type ContactSource = 'manual' | 'license' | 'card' | 'voice'

/** One labeled address. "Home" and "Work" are the standard labels; any label is allowed. */
export interface Address {
  id: string
  label: string
  street: string
  suite: string
  city: string
  region: string
  postal_code: string
  country: string
}

export const STANDARD_ADDRESS_LABELS = ['Home', 'Work'] as const

export const ADDRESS_FIELDS = ['label', 'street', 'suite', 'city', 'region', 'postal_code', 'country'] as const
export type AddressField = (typeof ADDRESS_FIELDS)[number]
export const ADDRESS_MAX: Record<AddressField, number> = {
  label: 40,
  street: 200,
  suite: 40,
  city: 100,
  region: 100,
  postal_code: 20,
  country: 100,
}

/** A field the user added in the app (shows on every contact). */
export interface CustomFieldDef {
  id: string
  label: string
  kind: 'text' | 'number' | 'date'
  position: number
}

export interface ContactDraft {
  first_name: string
  last_name: string
  company: string
  title: string
  email: string
  phone: string
  addresses: Address[]
  hire_date: string // YYYY-MM-DD or ''
  home_state: string
  dob: string // YYYY-MM-DD or ''
  dl_number: string
  sex: string
  height: string
  weight: string
  eye_color: string
  hair_color: string
  notes: string
  /** Values for the user's custom fields, keyed by CustomFieldDef.id */
  custom: Record<string, string>
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
  'home_state',
  'dl_number',
  'sex',
  'height',
  'weight',
  'eye_color',
  'hair_color',
  'notes',
] as const satisfies readonly (keyof ContactDraft)[]

export type TextField = (typeof TEXT_FIELDS)[number]

export const DATE_FIELDS = ['hire_date', 'dob'] as const satisfies readonly (keyof ContactDraft)[]
export type DateField = (typeof DATE_FIELDS)[number]

/** Fields that can be auto-filled and highlighted for review. */
export type FillableField = TextField | DateField

export const MAX_LENGTH: Record<TextField, number> = {
  first_name: 100,
  last_name: 100,
  company: 200,
  title: 200,
  email: 254,
  phone: 40,
  home_state: 30,
  dl_number: 30,
  sex: 20,
  height: 20,
  weight: 20,
  eye_color: 30,
  hair_color: 30,
  notes: 2000,
}

export const CUSTOM_VALUE_MAX = 500

export function newId(): string {
  return crypto.randomUUID()
}

export function emptyAddress(label = 'Work'): Address {
  return { id: newId(), label, street: '', suite: '', city: '', region: '', postal_code: '', country: '' }
}

export function isBlankAddress(a: Address): boolean {
  return !a.street && !a.suite && !a.city && !a.region && !a.postal_code && !a.country
}

export function emptyDraft(source: ContactSource = 'manual'): ContactDraft {
  return {
    first_name: '',
    last_name: '',
    company: '',
    title: '',
    email: '',
    phone: '',
    addresses: [],
    hire_date: '',
    home_state: '',
    dob: '',
    dl_number: '',
    sex: '',
    height: '',
    weight: '',
    eye_color: '',
    hair_color: '',
    notes: '',
    custom: {},
    source,
    consent_at: null,
  }
}

export function displayName(c: Pick<ContactDraft, 'first_name' | 'last_name' | 'company'>): string {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ')
  return name || c.company || '(no name)'
}

/** "Street, Suite" as one line. */
export function streetLine(a: Pick<Address, 'street' | 'suite'>): string {
  return [a.street, a.suite].filter(Boolean).join(', ')
}

/** Finds the address with this label (case-insensitive). */
export function addressByLabel(c: Pick<ContactDraft, 'addresses'>, label: string): Address | undefined {
  return c.addresses.find((a) => a.label.trim().toLowerCase() === label.toLowerCase())
}
