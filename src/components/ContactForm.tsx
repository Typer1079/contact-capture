import { useState, type FormEvent } from 'react'
import { MAX_LENGTH, type ContactDraft, type TextField } from '../lib/types'
import { normalize, validate, type FieldErrors } from '../lib/validate'

interface Props {
  initial: ContactDraft
  /** Fields filled automatically (e.g. from a scan) get a "check this" highlight. */
  autoFilled?: TextField[]
  isEdit: boolean
  onSave: (draft: ContactDraft) => Promise<void>
  onCancel: () => void
}

interface FieldDef {
  key: TextField
  label: string
  type?: string
  autoComplete?: string
  inputMode?: 'text' | 'email' | 'tel' | 'numeric'
  half?: boolean
}

const FIELDS: FieldDef[] = [
  { key: 'first_name', label: 'First name', autoComplete: 'off', half: true },
  { key: 'last_name', label: 'Last name', autoComplete: 'off', half: true },
  { key: 'company', label: 'Company', autoComplete: 'off' },
  { key: 'title', label: 'Title', autoComplete: 'off' },
  { key: 'email', label: 'Email', type: 'email', inputMode: 'email', autoComplete: 'off' },
  { key: 'phone', label: 'Phone', type: 'tel', inputMode: 'tel', autoComplete: 'off' },
  { key: 'street', label: 'Street', autoComplete: 'off' },
  { key: 'city', label: 'City', autoComplete: 'off', half: true },
  { key: 'region', label: 'State', autoComplete: 'off', half: true },
  { key: 'postal_code', label: 'ZIP / Postal code', inputMode: 'numeric', autoComplete: 'off', half: true },
  { key: 'country', label: 'Country', autoComplete: 'off', half: true },
]

export default function ContactForm({ initial, autoFilled = [], isEdit, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<ContactDraft>(initial)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [saving, setSaving] = useState(false)

  const set = (key: TextField, value: string) => setDraft((d) => ({ ...d, [key]: value }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    const clean = normalize(draft)
    const errs = validate(clean)
    setErrors(errs)
    if (Object.keys(errs).length) return
    setSaving(true)
    try {
      await onSave(clean)
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : 'Could not save. Try again.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {draft.source === 'license' && autoFilled.length > 0 && (
        <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          Filled from a license barcode. Highlighted fields need a quick check. Only the name and address were kept;
          the license number, birth date and physical details were discarded.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map((f) => {
          const highlighted = autoFilled.includes(f.key) && draft[f.key] === initial[f.key] && draft[f.key] !== ''
          return (
            <div key={f.key} className={f.half ? 'col-span-1' : 'col-span-2'}>
              <label className="label" htmlFor={f.key}>{f.label}</label>
              <input
                id={f.key}
                className={`input ${highlighted ? 'border-amber-400 bg-amber-50' : ''} ${errors[f.key] ? 'border-red-500' : ''}`}
                type={f.type ?? 'text'}
                inputMode={f.inputMode}
                autoComplete={f.autoComplete}
                maxLength={MAX_LENGTH[f.key]}
                value={draft[f.key]}
                onChange={(e) => set(f.key, e.target.value)}
                aria-invalid={Boolean(errors[f.key])}
              />
              {errors[f.key] && <p className="mt-1 text-xs text-red-600">{errors[f.key]}</p>}
            </div>
          )
        })}
        <div className="col-span-2">
          <label className="label" htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            className="input min-h-24"
            maxLength={MAX_LENGTH.notes}
            value={draft.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </div>
      </div>

      {errors.form && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{errors.form}</p>}

      <div className="sticky bottom-0 -mx-4 flex gap-3 border-t border-slate-200 bg-slate-50/95 px-4 py-3 backdrop-blur">
        <button type="button" className="btn-secondary flex-1" onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save contact'}</button>
      </div>
    </form>
  )
}
