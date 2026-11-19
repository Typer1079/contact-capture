import { useState, type FormEvent, type ReactNode } from 'react'
import { createFieldDef, deleteFieldDef, renameFieldDef } from '../lib/contactsApi'
import {
  ADDRESS_MAX,
  CUSTOM_VALUE_MAX,
  emptyAddress,
  emptyPhone,
  MAX_LENGTH,
  MAX_PHONES,
  PHONE_MAX,
  STANDARD_ADDRESS_LABELS,
  STANDARD_PHONE_LABELS,
  type Address,
  type Phone,
  type PhoneField,
  type AddressField,
  type ContactDraft,
  type CustomFieldDef,
  type DateField,
  type TextField,
} from '../lib/types'
import { normalize, validate, type FieldErrors } from '../lib/validate'

interface Props {
  initial: ContactDraft
  /** Fields filled automatically (from a scan) get a "check this" highlight. Address ids too. */
  autoFilled?: string[]
  /** Fields the scanner isn't sure about (readings disagreed or the value looks wrong). */
  uncertain?: string[]
  isEdit: boolean
  defs: CustomFieldDef[]
  onDefsChange: (defs: CustomFieldDef[]) => void
  onSave: (draft: ContactDraft) => Promise<void>
  onCancel: () => void
}

interface FieldDef {
  key: TextField | DateField
  label: string
  type?: string
  inputMode?: 'text' | 'email' | 'tel' | 'numeric'
  half?: boolean
  options?: string[]
  list?: string
  hint?: string
}

const BASIC: FieldDef[] = [
  { key: 'first_name', label: 'First name', half: true },
  { key: 'last_name', label: 'Last name', half: true },
  { key: 'company', label: 'Company' },
  { key: 'title', label: 'Title' },
  { key: 'department', label: 'Department' },
  { key: 'email', label: 'Email', type: 'email', inputMode: 'email' },
]

const EMPLOYMENT: FieldDef[] = [
  { key: 'hire_date', label: 'Hire date', type: 'date', half: true },
  { key: 'home_state', label: 'Home state', half: true, list: 'us-states' },
]

const PHYSICAL: FieldDef[] = [
  { key: 'sex', label: 'Sex', half: true, options: ['', 'Male', 'Female', 'X'] },
  { key: 'height', label: 'Height', half: true },
  { key: 'weight', label: 'Weight', half: true },
  { key: 'eye_color', label: 'Eye color', half: true },
  { key: 'hair_color', label: 'Hair color', half: true },
]

const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ')

const ADDRESS_INPUTS: { key: Exclude<AddressField, 'label'>; label: string; half?: boolean; inputMode?: 'numeric' }[] = [
  { key: 'street', label: 'Street' },
  { key: 'suite', label: 'Suite / Apt / Unit', half: true },
  { key: 'city', label: 'City', half: true },
  { key: 'region', label: 'State', half: true },
  { key: 'postal_code', label: 'ZIP / Postal code', half: true, inputMode: 'numeric' },
  { key: 'country', label: 'Country' },
]

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className="col-span-2 mt-2 border-t border-slate-200 pt-4">
      <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      {note && <p className="mt-0.5 text-xs text-slate-500">{note}</p>}
      <div className="mt-3 grid grid-cols-2 gap-3">{children}</div>
    </section>
  )
}

export default function ContactForm({ initial, autoFilled = [], uncertain = [], isEdit, defs, onDefsChange, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<ContactDraft>(() =>
    // New typed contacts start with an empty mobile number and Work address ready to fill in.
    !isEdit && initial.source === 'manual'
      ? {
          ...initial,
          phones: initial.phones.length ? initial.phones : [emptyPhone('Mobile')],
          addresses: initial.addresses.length ? initial.addresses : [emptyAddress('Work')],
        }
      : initial,
  )
  const [errors, setErrors] = useState<FieldErrors>({})
  const [saving, setSaving] = useState(false)
  const [showDl, setShowDl] = useState(false)
  const [newField, setNewField] = useState<{ label: string; kind: CustomFieldDef['kind'] } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null)
  const [fieldError, setFieldError] = useState('')

  const set = (key: TextField | DateField, value: string) => setDraft((d) => ({ ...d, [key]: value }))
  const setAddr = (id: string, key: AddressField, value: string) =>
    setDraft((d) => ({ ...d, addresses: d.addresses.map((a) => (a.id === id ? { ...a, [key]: value } : a)) }))
  const addAddr = (label: string) => setDraft((d) => ({ ...d, addresses: [...d.addresses, emptyAddress(label)] }))
  const removeAddr = (id: string) => setDraft((d) => ({ ...d, addresses: d.addresses.filter((a) => a.id !== id) }))
  const setPhone = (id: string, key: PhoneField, value: string) =>
    setDraft((d) => ({ ...d, phones: d.phones.map((p) => (p.id === id ? { ...p, [key]: value } : p)) }))
  const addPhone = () =>
    setDraft((d) => {
      const used = d.phones.map((p) => p.label.trim().toLowerCase())
      const label = ['Mobile', 'Work', 'Direct', 'Fax'].find((l) => !used.includes(l.toLowerCase())) ?? 'Other'
      return { ...d, phones: [...d.phones, emptyPhone(label)] }
    })
  const removePhone = (id: string) => setDraft((d) => ({ ...d, phones: d.phones.filter((p) => p.id !== id) }))
  const setCustom = (id: string, value: string) => setDraft((d) => ({ ...d, custom: { ...d.custom, [id]: value } }))

  const labelsInUse = draft.addresses.map((a) => a.label.trim().toLowerCase())
  const labelSuggestions = [...new Set([...STANDARD_ADDRESS_LABELS, 'Billing', 'Shipping', 'Other', ...draft.addresses.map((a) => a.label).filter(Boolean)])]

  async function submit(e: FormEvent) {
    e.preventDefault()
    const clean = normalize(draft)
    const errs = validate(clean, defs)
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

  async function addField() {
    if (!newField) return
    const label = newField.label.trim()
    if (!label) return setFieldError('Give the field a name.')
    if (label.length > 60) return setFieldError('Keep the name under 60 characters.')
    setFieldError('')
    try {
      const def = await createFieldDef(label, newField.kind, defs.length)
      onDefsChange([...defs, def])
      setNewField(null)
    } catch (err) {
      setFieldError(err instanceof Error ? err.message : 'Could not add the field.')
    }
  }

  async function saveRename() {
    if (!renaming) return
    const label = renaming.label.trim()
    if (!label) return setFieldError('Give the field a name.')
    try {
      await renameFieldDef(renaming.id, label)
      onDefsChange(defs.map((d) => (d.id === renaming.id ? { ...d, label } : d)))
      setRenaming(null)
      setFieldError('')
    } catch (err) {
      setFieldError(err instanceof Error ? err.message : 'Could not rename the field.')
    }
  }

  async function removeField(def: CustomFieldDef) {
    if (!window.confirm(`Remove the “${def.label}” field from all contacts?`)) return
    try {
      await deleteFieldDef(def.id)
      onDefsChange(defs.filter((d) => d.id !== def.id))
    } catch (err) {
      setFieldError(err instanceof Error ? err.message : 'Could not remove the field.')
    }
  }

  const [touched, setTouched] = useState<Set<string>>(new Set())
  const isUncertain = (key: string) => uncertain.includes(key) && !touched.has(key)
  const touch = (key: string) => setTouched((t) => (t.has(key) ? t : new Set(t).add(key)))

  function inputClass(highlighted: boolean, error?: string, unsure = false) {
    if (unsure && !error) return 'input border-2 border-orange-500 bg-orange-50'
    return `input ${highlighted ? 'border-amber-400 bg-amber-50' : ''} ${error ? 'border-red-500' : ''}`
  }

  const checkTag = <span className="ml-1 rounded bg-orange-500 px-1 py-px text-[10px] font-bold normal-case tracking-normal text-white">Check</span>

  function renderField(f: FieldDef) {
    const highlighted = autoFilled.includes(f.key) && draft[f.key] === initial[f.key] && draft[f.key] !== ''
    const unsure = isUncertain(f.key)
    const cls = inputClass(highlighted, errors[f.key], unsure)
    const maxLength = f.key in MAX_LENGTH ? MAX_LENGTH[f.key as TextField] : undefined
    return (
      <div key={f.key} className={`min-w-0 ${f.half ? 'col-span-1' : 'col-span-2'}`} onFocus={() => unsure && touch(f.key)}>
        <label className="label" htmlFor={f.key}>{f.label}{unsure && checkTag}</label>
        {f.options ? (
          <select id={f.key} className={cls} value={draft[f.key]} onChange={(e) => set(f.key, e.target.value)}>
            {[...new Set([...f.options, draft[f.key]])].map((o) => (
              <option key={o} value={o}>{o || '—'}</option>
            ))}
          </select>
        ) : (
          <input
            id={f.key}
            className={cls}
            type={f.type ?? 'text'}
            inputMode={f.inputMode}
            autoComplete="off"
            list={f.list}
            maxLength={maxLength}
            value={draft[f.key]}
            onChange={(e) => set(f.key, e.target.value)}
            aria-invalid={Boolean(errors[f.key])}
          />
        )}
        {errors[f.key] && <p className="mt-1 text-xs text-red-600">{errors[f.key]}</p>}
      </div>
    )
  }

  function renderAddress(a: Address) {
    const highlighted = autoFilled.includes(`addr:${a.id}`)
    return (
      <div key={a.id} className={`col-span-2 rounded-xl border p-3 ${highlighted ? 'border-amber-300 bg-amber-50/50' : 'border-slate-200 bg-white'}`}>
        <div className="mb-3 flex items-end gap-2">
          <div className="flex-1">
            <label className="label" htmlFor={`addr-${a.id}-label`}>Label</label>
            <input
              id={`addr-${a.id}-label`}
              className="input py-2 font-semibold"
              list="address-labels"
              maxLength={ADDRESS_MAX.label}
              value={a.label}
              placeholder="Home, Work, Warehouse…"
              onChange={(e) => setAddr(a.id, 'label', e.target.value)}
            />
          </div>
          <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => removeAddr(a.id)} aria-label={`Remove ${a.label || 'this'} address`}>
            Remove
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {ADDRESS_INPUTS.map((f) => {
            const err = errors[`addr:${a.id}:${f.key}`]
            const unsure = isUncertain(`addr:${a.id}:${f.key}`)
            return (
              <div key={f.key} className={`min-w-0 ${f.half ? 'col-span-1' : 'col-span-2'}`} onFocus={() => unsure && touch(`addr:${a.id}:${f.key}`)}>
                <label className="label" htmlFor={`addr-${a.id}-${f.key}`}>{f.label}{unsure && checkTag}</label>
                <input
                  id={`addr-${a.id}-${f.key}`}
                  className={inputClass(false, err, unsure)}
                  inputMode={f.inputMode}
                  autoComplete="off"
                  list={f.key === 'region' ? 'us-states' : undefined}
                  maxLength={ADDRESS_MAX[f.key]}
                  value={a[f.key]}
                  onChange={(e) => setAddr(a.id, f.key, e.target.value)}
                />
                {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  function renderPhone(p: Phone, i: number) {
    const highlighted = autoFilled.includes(`phone:${p.id}`)
    const field = (key: PhoneField) => ({
      id: `phone-${p.id}-${key}`,
      err: errors[`phone:${p.id}:${key}`],
      unsure: isUncertain(`phone:${p.id}:${key}`),
    })
    const label = field('label')
    const num = field('number')
    const ext = field('ext')
    return (
      <div key={p.id} className={`col-span-2 rounded-xl border p-3 ${highlighted ? 'border-amber-300 bg-amber-50/50' : 'border-slate-200 bg-white'}`}>
        <div className="mb-2 flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <label className="label" htmlFor={label.id}>Label{i === 0 && <span className="ml-1 font-normal normal-case tracking-normal text-slate-400">(main number)</span>}</label>
            <input id={label.id} className="input py-2 font-semibold" list="phone-labels" maxLength={PHONE_MAX.label} value={p.label} placeholder="Mobile, Work, Direct…" onChange={(e) => setPhone(p.id, 'label', e.target.value)} />
          </div>
          <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => removePhone(p.id)} aria-label={`Remove ${p.label || 'this'} number`}>Remove</button>
        </div>
        <div className="flex gap-2">
          <div className="min-w-0 flex-1" onFocus={() => num.unsure && touch(`phone:${p.id}:number`)}>
            <label className="label" htmlFor={num.id}>Number{num.unsure && checkTag}</label>
            <input id={num.id} className={inputClass(false, num.err, num.unsure)} type="tel" inputMode="tel" autoComplete="off" maxLength={PHONE_MAX.number} value={p.number} onChange={(e) => setPhone(p.id, 'number', e.target.value)} aria-invalid={Boolean(num.err)} />
          </div>
          <div className="w-24 shrink-0" onFocus={() => ext.unsure && touch(`phone:${p.id}:ext`)}>
            <label className="label" htmlFor={ext.id}>Ext.</label>
            <input id={ext.id} className={inputClass(false, ext.err, ext.unsure)} inputMode="numeric" autoComplete="off" maxLength={PHONE_MAX.ext} value={p.ext} onChange={(e) => setPhone(p.id, 'ext', e.target.value)} aria-invalid={Boolean(ext.err)} />
          </div>
        </div>
        {(num.err || ext.err || label.err) && <p className="mt-1 text-xs text-red-600">{num.err || ext.err || label.err}</p>}
      </div>
    )
  }

  function renderCustom(def: CustomFieldDef) {
    const err = errors[`custom:${def.id}`]
    if (renaming?.id === def.id) {
      return (
        <div key={def.id} className="col-span-2 flex items-end gap-2">
          <div className="flex-1">
            <label className="label" htmlFor={`rename-${def.id}`}>Field name</label>
            <input id={`rename-${def.id}`} className="input py-2" maxLength={60} autoFocus value={renaming.label} onChange={(e) => setRenaming({ id: def.id, label: e.target.value })} />
          </div>
          <button type="button" className="btn-primary px-3 py-2 text-xs" onClick={saveRename}>Save</button>
          <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => setRenaming(null)}>Cancel</button>
        </div>
      )
    }
    return (
      <div key={def.id} className="col-span-2">
        <div className="mb-1 flex items-center justify-between">
          <label className="label mb-0" htmlFor={`custom-${def.id}`}>{def.label}</label>
          <span className="flex gap-3 text-xs">
            <button type="button" className="text-slate-500 underline" onClick={() => setRenaming({ id: def.id, label: def.label })}>Rename</button>
            <button type="button" className="text-red-600 underline" onClick={() => removeField(def)}>Remove</button>
          </span>
        </div>
        <input
          id={`custom-${def.id}`}
          className={inputClass(false, err)}
          type={def.kind === 'date' ? 'date' : 'text'}
          inputMode={def.kind === 'number' ? 'decimal' : undefined}
          autoComplete="off"
          maxLength={CUSTOM_VALUE_MAX}
          value={draft.custom[def.id] ?? ''}
          onChange={(e) => setCustom(def.id, e.target.value)}
        />
        {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
      </div>
    )
  }

  const idHighlight = (k: 'dob' | 'dl_number') => autoFilled.includes(k) && draft[k] === initial[k] && draft[k] !== ''

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <datalist id="address-labels">
        {labelSuggestions.map((l) => <option key={l} value={l} />)}
      </datalist>
      <datalist id="phone-labels">
        {STANDARD_PHONE_LABELS.map((l) => <option key={l} value={l} />)}
      </datalist>
      <datalist id="us-states">
        {US_STATES.map((s) => <option key={s} value={s} />)}
      </datalist>

      {draft.source === 'card' && autoFilled.length > 0 && (
        <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          Filled from a photo. Yellow fields were read automatically.
          {uncertain.length > 0 && (
            <strong className="mt-1 block text-orange-700">
              {uncertain.length} field{uncertain.length > 1 ? 's' : ''} marked “Check”: the readings didn’t agree or the value looks off.
            </strong>
          )}{' '}
          Website and any extra text are in Notes.
        </div>
      )}
      {draft.source === 'license' && autoFilled.length > 0 && (
        <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          Filled from a driver’s license. Highlighted fields need a quick check.
          {draft.dob || draft.dl_number ? ' Date of birth and license number were included because you opted in.' : ' The license number and birth date were not read.'}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {BASIC.map(renderField)}

        <Section title="Phones" note="The first number is the main one. Tap a label to change it.">
          {draft.phones.map(renderPhone)}
          {draft.phones.length < MAX_PHONES && (
            <button type="button" className="btn-secondary col-span-2 py-2 text-xs" onClick={addPhone}>+ Add phone number</button>
          )}
        </Section>

        <Section title="Addresses" note="Home and Work are standard. Tap a label to rename it.">
          {draft.addresses.map(renderAddress)}
          <div className="col-span-2 flex flex-wrap gap-2">
            {STANDARD_ADDRESS_LABELS.filter((l) => !labelsInUse.includes(l.toLowerCase())).map((l) => (
              <button key={l} type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => addAddr(l)}>+ {l} address</button>
            ))}
            {draft.addresses.length < 10 && (
              <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => addAddr('')}>+ Other address</button>
            )}
          </div>
        </Section>

        <Section title="Employment">{EMPLOYMENT.map(renderField)}</Section>

        <Section title="Identification" note="Sensitive. Never added to phone contacts; only exported to CSV if you choose.">
          <div className="col-span-1 min-w-0">
            <label className="label" htmlFor="dob">Date of birth</label>
            <input id="dob" type="date" className={inputClass(idHighlight('dob'), errors.dob, isUncertain('dob'))} onFocus={() => touch('dob')} autoComplete="off" value={draft.dob} onChange={(e) => set('dob', e.target.value)} />
            {errors.dob && <p className="mt-1 text-xs text-red-600">{errors.dob}</p>}
          </div>
          <div className="col-span-1 min-w-0">
            <label className="label" htmlFor="dl_number">Driver’s license #</label>
            <div className="relative">
              <input
                id="dl_number"
                onFocus={() => touch('dl_number')}
                className={`${inputClass(idHighlight('dl_number'), errors.dl_number, isUncertain('dl_number'))} pr-14 ${showDl ? '' : '[-webkit-text-security:disc]'}`}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={MAX_LENGTH.dl_number}
                value={draft.dl_number}
                onChange={(e) => set('dl_number', e.target.value)}
              />
              <button type="button" className="absolute inset-y-0 right-2 text-xs text-slate-500 underline" onClick={() => setShowDl((v) => !v)}>
                {showDl ? 'Hide' : 'Show'}
              </button>
            </div>
            {errors.dl_number && <p className="mt-1 text-xs text-red-600">{errors.dl_number}</p>}
          </div>
        </Section>

        <Section title="Physical description">{PHYSICAL.map(renderField)}</Section>

        <Section title="Custom fields" note="Fields you add here appear on every contact.">
          {defs.map(renderCustom)}
          {newField ? (
            <div className="col-span-2 space-y-2 rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="label" htmlFor="new-field-label">Field name</label>
                  <input id="new-field-label" className="input py-2" maxLength={60} autoFocus placeholder="e.g. Badge #, Referred by" value={newField.label} onChange={(e) => setNewField({ ...newField, label: e.target.value })} />
                </div>
                <div className="w-28">
                  <label className="label" htmlFor="new-field-kind">Type</label>
                  <select id="new-field-kind" className="input py-2" value={newField.kind} onChange={(e) => setNewField({ ...newField, kind: e.target.value as CustomFieldDef['kind'] })}>
                    <option value="text">Text</option>
                    <option value="number">Number</option>
                    <option value="date">Date</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" className="btn-primary flex-1 py-2 text-xs" onClick={addField}>Add field</button>
                <button type="button" className="btn-secondary flex-1 py-2 text-xs" onClick={() => { setNewField(null); setFieldError('') }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn-secondary col-span-2 py-2 text-xs" onClick={() => setNewField({ label: '', kind: 'text' })}>+ Add a custom field</button>
          )}
          {fieldError && <p className="col-span-2 text-xs text-red-600">{fieldError}</p>}
        </Section>

        <div className="col-span-2 mt-2 border-t border-slate-200 pt-4">
          <label className="label" htmlFor="notes">Notes</label>
          <textarea id="notes" className="input min-h-24" maxLength={MAX_LENGTH.notes} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
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
