import {
  ADDRESS_FIELDS,
  ADDRESS_MAX,
  CUSTOM_VALUE_MAX,
  DATE_FIELDS,
  isBlankAddress,
  MAX_LENGTH,
  TEXT_FIELDS,
  type ContactDraft,
  type CustomFieldDef,
  type DateField,
  type TextField,
} from './types'

/** Error keys: a field name, "addr:<id>:<field>", "custom:<id>", or "form". */
export type FieldErrors = Partial<Record<TextField | DateField | 'form' | `addr:${string}` | `custom:${string}`, string>>

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[0-9+().\-\sx#*]+$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g
// eslint-disable-next-line no-control-regex
const CONTROL_KEEP_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F]/g

const clean = (v: string | undefined) => (v ?? '').replace(CONTROL, '').trim()

function isRealDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false
  const d = new Date(v + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** Trims every field, strips control characters, and drops empty addresses. */
export function normalize(draft: ContactDraft): ContactDraft {
  const out: ContactDraft = { ...draft }
  for (const f of TEXT_FIELDS) out[f] = f === 'notes' ? (out[f] ?? '').replace(CONTROL_KEEP_NEWLINE, '').trim() : clean(out[f])
  for (const f of DATE_FIELDS) out[f] = clean(out[f])
  out.email = out.email.toLowerCase()
  out.home_state = out.home_state.toUpperCase()
  out.dl_number = out.dl_number.toUpperCase().replace(/\s+/g, '')
  out.addresses = (draft.addresses ?? [])
    .map((a) => {
      const n = { ...a }
      for (const f of ADDRESS_FIELDS) n[f] = clean(a[f])
      n.region = n.region.toUpperCase().length <= 3 ? n.region.toUpperCase() : n.region
      n.label = n.label || 'Other'
      return n
    })
    .filter((a) => !isBlankAddress(a))
  out.custom = Object.fromEntries(
    Object.entries(draft.custom ?? {})
      .map(([k, v]) => [k, clean(v)] as const)
      .filter(([, v]) => v !== ''),
  )
  return out
}

export function validate(draft: ContactDraft, defs: CustomFieldDef[] = []): FieldErrors {
  const errors: FieldErrors = {}
  for (const f of TEXT_FIELDS) {
    if (draft[f].length > MAX_LENGTH[f]) errors[f] = `Keep this under ${MAX_LENGTH[f]} characters.`
  }
  for (const f of DATE_FIELDS) {
    if (draft[f] && !isRealDate(draft[f])) errors[f] = 'Use a valid date.'
  }
  if (draft.dob && isRealDate(draft.dob) && draft.dob > new Date().toISOString().slice(0, 10)) errors.dob = 'Date of birth can’t be in the future.'
  for (const a of draft.addresses) {
    for (const f of ADDRESS_FIELDS) {
      if (a[f].length > ADDRESS_MAX[f]) errors[`addr:${a.id}:${f}`] = `Keep this under ${ADDRESS_MAX[f]} characters.`
    }
  }
  if (draft.addresses.length > 10) errors.form = 'Up to 10 addresses per contact.'
  for (const def of defs) {
    const v = draft.custom[def.id]
    if (!v) continue
    if (v.length > CUSTOM_VALUE_MAX) errors[`custom:${def.id}`] = `Keep this under ${CUSTOM_VALUE_MAX} characters.`
    else if (def.kind === 'number' && !/^-?\d+(\.\d+)?$/.test(v.replace(/,/g, ''))) errors[`custom:${def.id}`] = 'Enter a number.'
    else if (def.kind === 'date' && !isRealDate(v)) errors[`custom:${def.id}`] = 'Use a valid date.'
  }
  if (!draft.first_name && !draft.last_name && !draft.company) {
    errors.form = 'Add at least a first name, last name, or company.'
  }
  if (draft.email && !EMAIL_RE.test(draft.email)) errors.email = 'That email address doesn’t look right.'
  if (draft.phone && !PHONE_RE.test(draft.phone)) errors.phone = 'Use digits and + ( ) - only.'
  if (draft.dl_number && !/^[A-Z0-9-]+$/.test(draft.dl_number)) errors.dl_number = 'Letters, digits and dashes only.'
  if (draft.source === 'license' && !draft.consent_at) {
    errors.form = 'License scans need recorded consent.'
  }
  return errors
}
