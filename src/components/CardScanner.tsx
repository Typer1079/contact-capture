import { useEffect, useState } from 'react'
import { parseBusinessCard, type CardContact } from '../lib/cardParser'
import { readCard, warmUpOcr } from '../lib/ocr'

interface Props {
  onResult: (contact: CardContact) => void
  onCancel: () => void
}

export default function CardScanner({ onResult, onCancel }: Props) {
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ p: 0, label: '' })
  const [error, setError] = useState('')

  // Start loading the text reader while the person lines up the photo.
  useEffect(() => warmUpOcr(), [])
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  async function onPhoto(file: File | undefined) {
    if (!file) return
    setError('')
    setPreview(URL.createObjectURL(file))
    setBusy(true)
    setProgress({ p: 0, label: 'Starting…' })
    try {
      const lines = await readCard(file, (p, label) => setProgress({ p, label }))
      const contact = parseBusinessCard(lines)
      const found = [contact.first_name, contact.last_name, contact.company, contact.email, contact.phone].some(Boolean)
      if (!found) {
        setError('Couldn’t find contact details on that photo. Fill the frame with the card, in good light, and try again.')
        return
      }
      onResult(contact)
    } catch {
      setError('Couldn’t read that photo. Try again, or type the contact in.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-2 text-sm">
        <h2 className="text-base font-semibold">Scan a business card</h2>
        <p>Take a photo of the front of the card. The text is read <strong>on this device</strong>; the photo isn’t uploaded or saved.</p>
        <ul className="list-disc space-y-1 pl-5 text-slate-600">
          <li>Lay the card flat, fill most of the photo with it</li>
          <li>Good light, no glare or shadows across the text</li>
        </ul>
      </div>

      {preview && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <img src={preview} alt="Business card photo" className="max-h-64 w-full object-contain" />
        </div>
      )}

      {busy && (
        <div className="space-y-2" aria-live="polite">
          <div className="h-2 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full bg-slate-900 transition-all" style={{ width: `${Math.round(progress.p * 100)}%` }} />
          </div>
          <p className="text-center text-sm text-slate-600">{progress.label}</p>
        </div>
      )}

      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="grid grid-cols-2 gap-3">
        <label className={`btn-primary col-span-2 cursor-pointer text-center ${busy ? 'pointer-events-none opacity-50' : ''}`}>
          {preview ? 'Retake photo' : 'Take photo of card'}
          <input type="file" accept="image/*" capture="environment" className="hidden" disabled={busy} onChange={(e) => onPhoto(e.target.files?.[0])} />
        </label>
        <label className={`btn-secondary cursor-pointer text-center ${busy ? 'pointer-events-none opacity-50' : ''}`}>
          Choose photo
          <input type="file" accept="image/*" className="hidden" disabled={busy} onChange={(e) => onPhoto(e.target.files?.[0])} />
        </label>
        <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      <p className="text-center text-xs text-slate-500">The first scan downloads the text reader (about 7 MB). After that it works offline.</p>
    </div>
  )
}
