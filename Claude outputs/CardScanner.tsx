import { useCallback, useEffect, useState } from 'react'
import { parseBusinessCard, type CardContact } from '../lib/cardParser'
import { readCard, warmUpOcr } from '../lib/ocr'
import { suspiciousFields } from '../lib/verify'
import CardCamera from './CardCamera'

export interface IdConsent {
  consentAt: string
  includeSensitive: boolean
}

interface Props {
  /**
   * `consent` is set when the photo was a driver's license / ID and the user agreed.
   * `uncertain` lists fields the person should double-check.
   */
  onResult: (contact: CardContact, consent: IdConsent | undefined, uncertain: string[]) => void
  onCancel: () => void
}

/** Below this text-reading confidence (0–100) the photo was probably blurry or too small. */
const LOW_CLARITY = 55

export default function CardScanner({ onResult, onCancel }: Props) {
  // Opens straight into the viewfinder; falls back to photo buttons if there's no camera.
  const [camera, setCamera] = useState<'open' | 'closed' | 'unavailable'>('open')
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ p: 0, label: '' })
  const [error, setError] = useState('')
  // A photo of a driver's license needs the same consent as a barcode scan.
  const [pendingId, setPendingId] = useState<{ contact: CardContact; uncertain: string[] } | null>(null)
  const [requested, setRequested] = useState(false)
  const [personalUse, setPersonalUse] = useState(false)
  const [includeSensitive, setIncludeSensitive] = useState(false)

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  /** One careful read of the photo, then the accuracy checks. */
  const read = useCallback(
    async (photo: Blob, sideways = false) => {
      setCamera((c) => (c === 'unavailable' ? c : 'closed'))
      setPreview(URL.createObjectURL(photo))
      setBusy(true)
      setError('')
      setProgress({ p: 0, label: 'Reading the card…' })
      try {
        const { lines, clarity } = await readCard(photo, (p, label) => setProgress({ p, label: p < 1 && label.startsWith('Loading') ? label : 'Reading the card…' }), {
          // A card lying sideways in a tall frame reads after a quarter turn.
          turnOrder: sideways ? [1, 3, 0, 2] : [0, 1, 3, 2],
        })
        const contact = parseBusinessCard(lines)
        const found = [contact.first_name, contact.last_name, contact.company, contact.email, contact.phone].some(Boolean)
        if (!found) {
          setError('Couldn’t find contact details. Retake with the card filling the frame, in good light.')
          return
        }
        const uncertain = suspiciousFields(contact)
        // A blurry photo: flag every text field that was filled so nothing is trusted blindly.
        if (clarity < LOW_CLARITY) {
          for (const k of ['first_name', 'last_name', 'company', 'title', 'email', 'phone', 'street', 'city', 'postal_code'] as const) {
            if (contact[k] && !uncertain.includes(k)) uncertain.push(k)
          }
        }
        if (contact.is_id) setPendingId({ contact, uncertain })
        else onResult(contact, undefined, uncertain)
      } catch {
        setError('Couldn’t read that photo. Try again, or type the contact in.')
      } finally {
        setBusy(false)
      }
    },
    [onResult],
  )

  const cameraUnavailable = useCallback(() => setCamera('unavailable'), [])

  if (camera === 'open') {
    return (
      <CardCamera
        onCapture={(photo, sideways) => void read(photo, sideways)}
        onChoosePhoto={(file) => void read(file)}
        onCancel={onCancel}
        onUnavailable={cameraUnavailable}
        onReady={warmUpOcr}
      />
    )
  }

  if (pendingId) {
    const c = pendingId.contact
    const found = [c.dob && 'date of birth', c.dl_number && 'license number'].filter(Boolean).join(' and ')
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
          {found && (
            <label className="flex items-start gap-3 border-t border-slate-200 pt-3">
              <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={includeSensitive} onChange={(e) => setIncludeSensitive(e.target.checked)} />
              <span>
                <strong>Optional:</strong> also fill in the <strong>{found}</strong> found on the license. The holder agreed to me saving it too.
              </span>
            </label>
          )}
        </div>
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onCancel}>Cancel</button>
          <button
            className="btn-primary flex-1"
            disabled={!requested || !personalUse}
            onClick={() => onResult(c, { consentAt: new Date().toISOString(), includeSensitive }, pendingId.uncertain)}
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
          <p>
            Take a photo of the front of a business card or badge (or a driver’s license front). The text is read <strong>on this device</strong>; the
            photo isn’t uploaded or saved.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-slate-600">
            <li>Turn your phone sideways and fill the photo with the card</li>
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
            <input type="file" accept="image/*" capture="environment" className="hidden" disabled={busy} onChange={(e) => e.target.files?.[0] && void read(e.target.files[0])} />
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
          <input type="file" accept="image/*" className="hidden" disabled={busy} onChange={(e) => e.target.files?.[0] && void read(e.target.files[0])} />
        </label>
        <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      <p className="text-center text-xs text-slate-500">The first scan downloads the text reader (about 7 MB). After that it works offline.</p>
    </div>
  )
}
