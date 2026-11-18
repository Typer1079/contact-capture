import { useCallback, useEffect, useState } from 'react'
import { parseBusinessCard, type CardContact } from '../lib/cardParser'
import CardCamera from './CardCamera'
import { readCard, warmUpOcr } from '../lib/ocr'

export interface IdConsent {
  consentAt: string
  includeSensitive: boolean
}

interface Props {
  /** `consent` is set when the photo was a driver's license / ID and the user agreed. */
  onResult: (contact: CardContact, consent?: IdConsent) => void
  onCancel: () => void
}

export default function CardScanner({ onResult, onCancel }: Props) {
  // Opens straight into the live viewfinder; falls back to photo buttons if there's no camera.
  const [camera, setCamera] = useState<'open' | 'closed' | 'unavailable'>('open')
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ p: 0, label: '' })
  const [error, setError] = useState('')
  // A photo of a driver's license needs the same consent as a barcode scan.
  const [pendingId, setPendingId] = useState<CardContact | null>(null)
  const [requested, setRequested] = useState(false)
  const [personalUse, setPersonalUse] = useState(false)
  const [includeSensitive, setIncludeSensitive] = useState(false)

  // Start loading the text reader while the person lines up the photo.
  useEffect(() => warmUpOcr(), [])
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  async function onPhoto(file: Blob | undefined) {
    if (!file) return
    setCamera((c) => (c === 'unavailable' ? c : 'closed'))
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
      if (contact.is_id) setPendingId(contact)
      else onResult(contact)
    } catch {
      setError('Couldn’t read that photo. Try again, or type the contact in.')
    } finally {
      setBusy(false)
    }
  }

  const cameraUnavailable = useCallback(() => setCamera('unavailable'), [])

  if (camera === 'open') {
    return <CardCamera onCapture={onPhoto} onChoosePhoto={onPhoto} onCancel={onCancel} onUnavailable={cameraUnavailable} />
  }

  if (pendingId) {
    const found = [pendingId.dob && 'date of birth', pendingId.dl_number && 'license number'].filter(Boolean).join(' and ')
    return (
      <div className="space-y-4">
        <div className="card space-y-3 text-sm">
          <h2 className="text-base font-semibold">This looks like a driver’s license</h2>
          <p>The photo was read on this device. Before saving anything from a license, confirm consent.</p>
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={requested} onChange={(e) => setRequested(e.target.checked)} />
            <span>The license holder voluntarily asked me to scan their license and agreed to me saving their details.</span>
          </label>
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={personalUse} onChange={(e) => setPersonalUse(e.target.checked)} />
            <span>I won’t use this for marketing, solicitation, or send it to a CRM.</span>
          </label>
          <label className="flex items-start gap-3 border-t border-slate-200 pt-3">
            <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={includeSensitive} onChange={(e) => setIncludeSensitive(e.target.checked)} />
            <span>
              <strong>Optional:</strong> also fill in the <strong>{found}</strong> found on the license. The holder agreed to me saving it too.
            </span>
          </label>
        </div>
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onCancel}>Cancel</button>
          <button
            className="btn-primary flex-1"
            disabled={!requested || !personalUse}
            onClick={() => onResult(pendingId, { consentAt: new Date().toISOString(), includeSensitive })}
          >
            Continue
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {!preview && (
      <div className="card space-y-2 text-sm">
        <h2 className="text-base font-semibold">Scan a business card</h2>
        <p>Take a photo of the front of a business card or badge (or a driver’s license front). The text is read <strong>on this device</strong>; the photo isn’t uploaded or saved.</p>
        <ul className="list-disc space-y-1 pl-5 text-slate-600">
          <li>Lay the card flat, fill most of the photo with it</li>
          <li>Good light, no glare or shadows across the text</li>
        </ul>
        {camera === 'unavailable' && <p className="text-amber-800">The live camera isn’t available, so use your camera app instead.</p>}
      </div>
      )}

      {preview && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <img src={preview} alt="Captured card" className="max-h-72 w-full object-contain" />
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
        {camera === 'unavailable' ? (
          <label className={`btn-primary col-span-2 cursor-pointer text-center ${busy ? 'pointer-events-none opacity-50' : ''}`}>
            {preview ? 'Retake photo' : 'Take photo of card'}
            <input type="file" accept="image/*" capture="environment" className="hidden" disabled={busy} onChange={(e) => onPhoto(e.target.files?.[0])} />
          </label>
        ) : (
          <button
            className="btn-primary col-span-2"
            disabled={busy}
            onClick={() => {
              setPreview(null)
              setError('')
              setCamera('open')
            }}
          >
            Retake
          </button>
        )}
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
