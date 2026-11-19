import { useMemo, useState } from 'react'
import { CSV_PRESETS, toCsv } from '../lib/csv'
import { downloadBlob, shareOrDownload } from '../lib/download'
import { displayName, type Contact, type CustomFieldDef } from '../lib/types'
import { toVCard, vcardFileName } from '../lib/vcard'

interface Props {
  contacts: Contact[]
  defs: CustomFieldDef[]
  loading: boolean
  onEdit: (c: Contact) => void
  onDelete: (ids: string[]) => Promise<void>
}

const SOURCE_LABEL: Record<Contact['source'], string> = {
  manual: 'Typed',
  license: 'License',
  card: 'Card',
  voice: 'Voice',
}

export default function ContactList({ contacts, defs, loading, onEdit, onDelete }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [presetId, setPresetId] = useState(CSV_PRESETS[0].id)
  const [deleting, setDeleting] = useState(false)
  const [includeSensitive, setIncludeSensitive] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts
    return contacts.filter((c) =>
      [c.first_name, c.last_name, c.company, c.email, ...c.phones.map((p) => p.number), c.title, c.department, ...c.addresses.flatMap((a) => [a.city, a.street, a.label]), ...Object.values(c.custom)]
        .some((v) => (v ?? '').toLowerCase().includes(q)),
    )
  }, [contacts, query])

  const allVisibleSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.id))

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(filtered.map((c) => c.id)))
  }

  function exportCsv() {
    const rows = selected.size ? contacts.filter((c) => selected.has(c.id)) : filtered
    const preset = CSV_PRESETS.find((p) => p.id === presetId) ?? CSV_PRESETS[0]
    const stamp = new Date().toISOString().slice(0, 10)
    if (includeSensitive && !window.confirm('This file will include dates of birth and license numbers. Store and share it carefully. Continue?')) return
    downloadBlob(new Blob([toCsv(rows, preset, { includeSensitive, customDefs: defs })], { type: 'text/csv;charset=utf-8' }), `contacts-${preset.id}-${stamp}.csv`)
  }

  async function removeSelected() {
    if (!selected.size) return
    if (!window.confirm(`Delete ${selected.size} contact${selected.size > 1 ? 's' : ''}? This can’t be undone.`)) return
    setDeleting(true)
    try {
      await onDelete([...selected])
      setSelected(new Set())
    } finally {
      setDeleting(false)
    }
  }

  const exportCount = selected.size || filtered.length

  return (
    <div className="space-y-3">
      <input className="input" type="search" placeholder="Search name, company, email…" value={query} onChange={(e) => setQuery(e.target.value)} />

      <div className="card space-y-3">
        <div className="flex items-center gap-2">
          <select className="input flex-1" value={presetId} onChange={(e) => setPresetId(e.target.value)} aria-label="CSV format">
            {CSV_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>CSV: {p.label}</option>
            ))}
          </select>
          <button className="btn-primary shrink-0" onClick={exportCsv} disabled={exportCount === 0}>
            Export {exportCount}
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" className="size-4" checked={includeSensitive} onChange={(e) => setIncludeSensitive(e.target.checked)} />
          Include date of birth & license number
        </label>
        <div className="flex items-center justify-between text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4" checked={allVisibleSelected} onChange={toggleAll} />
            {selected.size ? `${selected.size} selected` : 'Select all'}
          </label>
          {selected.size > 0 && (
            <button className="btn-danger py-1.5" onClick={removeSelected} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          )}
        </div>
      </div>

      {loading && <p className="py-8 text-center text-sm text-slate-500">Loading…</p>}
      {!loading && filtered.length === 0 && (
        <p className="py-8 text-center text-sm text-slate-500">{contacts.length ? 'No matches.' : 'No contacts yet. Scan or type one in.'}</p>
      )}

      <ul className="space-y-2">
        {filtered.map((c) => (
          <li key={c.id} className="card flex items-center gap-3 p-3">
            <input type="checkbox" className="size-5 shrink-0" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${displayName(c)}`} />
            <button className="min-w-0 flex-1 text-left" onClick={() => onEdit(c)}>
              <div className="truncate font-semibold">{displayName(c)}</div>
              <div className="truncate text-sm text-slate-500">
                {[c.title, c.company].filter(Boolean).join(' · ') || c.email || c.phones[0]?.number || [c.addresses[0]?.city, c.addresses[0]?.region].filter(Boolean).join(', ')}
              </div>
              <span className="mt-1 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{SOURCE_LABEL[c.source]}</span>
            </button>
            <button
              className="btn-secondary shrink-0 px-3 py-2 text-xs"
              onClick={() => shareOrDownload(toVCard(c, defs), vcardFileName(c), 'text/vcard')}
              title="Add to phone contacts"
            >
              + Phone
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
