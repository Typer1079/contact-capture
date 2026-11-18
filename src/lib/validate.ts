import { MAX_LENGTH, TEXT_FIELDS, type ContactDraft, type TextField } from './types'

export type FieldErrors = Partial<Record<TextField | 'form', string>>

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[0-9+().\-\sx#*]+$/i

/** Trims every text field and strips control characters. */
export function normalize(draft: ContactDraft): ContactDraft {
  const out = { ...draft }
  for (const f of TEXT_FIELDS) {
    // eslint-disable-next-line no-control-regex
    const cleaned = (out[f] ?? '').replace(f === 'notes' ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, '')
    out[f] = cleaned.trim()
  }
  out.email = out.email.toLowerCase()
  return out
}

export function validate(draft: ContactDraft): FieldErrors {
  const errors: FieldErrors = {}
  for (const f of TEXT_FIELDS) {
    if (draft[f].length > MAX_LENGTH[f]) errors[f] = `Keep this under ${MAX_LENGTH[f]} characters.`
  }
  if (!draft.first_name && !draft.last_name && !draft.company) {
    errors.form = 'Add at least a first name, last name, or company.'
  }
  if (draft.email && !EMAIL_RE.test(draft.email)) errors.email = 'That email address doesn’t look right.'
  if (draft.phone && !PHONE_RE.test(draft.phone)) errors.phone = 'Use digits and + ( ) - only.'
  if (draft.source === 'license' && !draft.consent_at) {
    errors.form = 'License scans need recorded consent.'
  }
  return errors
}
