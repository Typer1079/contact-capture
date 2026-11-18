import { useCallback, useEffect, useRef, useState } from 'react'
import { parseBusinessCard, type CardContact } from '../lib/cardParser'
import { readCard, warmUpOcr, type ReadLine } from '../lib/ocr'
import { mergeReadings, suspiciousFields } from '../lib/verify'
import CardCamera, { type Verdict } from './CardCamera'

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

/**
 * Text read at least this confidently counts as clear (0–100, over ALL text on the card,
 * including logos and fine print, so a sharp close-up of a real card scores ~70).
 * Tested: card close & sharp ≈ 70–72, too far ≈ 49, moving / focusing ≈ 36–56.
 */
const CLEAR = 62
/** One reading this clear (with name + phone/email) is enough on its own. */
const VERY_CLEAR = 80
/** After this many readings with only one clear one, use it rather than keep waiting. */
const MAX_TRIES = 5

const FIELDS = [
  'first_name', 'last_name', 'company', 'title', 'email', 'phone', 'street', 'suite', 'city', 'region', 'postal_code',
  'country', 'hire_date', 'home_state', 'dob', 'dl_number', 'sex', 'height', 'eye_color',
] as const satisfies readonly (keyof CardContact)[]

interface Reading {
  photo: Blob
  lines: ReadLine[]
  contact: CardContact
  clarity: number
  hasKeyFields: boolean
}

/** Complete enough: a name plus a way to reach them, and no email that was seen but not read. */
function hasKeyFields(c: CardContact, rawText: string): boolean {
  const name = Boolean(c.first_name || c.last_name || c.company)
  const emailSeenNotRead = rawText.includes('@') && !c.email
  return name && Boolean(c.email || c.phone || c.dl_number) && !emailSeenNotRead
}

export default function CardScanner({ onResult, onCancel }: Props) {
  // Opens straight into the live viewfinder; falls back to photo buttons if there's no camera.
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
  const readings = useRef<Reading[]>([])

  // Start loading the text reader while the person lines up the card.
  useEffect(() => warmUpOcr(), [])
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  /** Careful read of the best photo, combined with the quick readings, then accuracy checks. */
  const finish = useCallback(
    async (best: Reading, others: Reading[]) => {
      setCamera((c) => (c === 'unavailable' ? c : 'closed'))
      setPreview(URL.createObjectURL(best.photo))
      setBusy(true)
      setError('')
      setProgress({ p: 0, label: 'Checking the details…' })
      try {
        const { lines } = await readCard(best.photo, (p) => setProgress({ p, label: 'Checking the details…' }))
        const careful = parseBusinessCard(lines)
        // Vote across readings: the careful one (counts double) plus the other clear quick ones.
        const quick = [best, ...others].filter((r) => r.clarity >= CLEAR && r.lines.length).map((r) => r.contact)
        const voters = quick.length ? [careful, careful, ...quick] : [careful]
        const { merged, disputed } = voters.length > 1 ? mergeReadings(voters, careful, [...FIELDS]) : { merged: careful, disputed: [] }
        const contact: CardContact = { ...merged, notes: careful.notes, is_id: voters.some((v) => v.is_id) }
        const found = [contact.first_name, contact.last_name, contact.company, contact.email, contact.phone].some(Boolean)
        if (!found) {
          setError('Couldn’t find contact details. Retake in good light, with the card filling the frame.')
          return
        }
        const uncertain = [...new Set([...disputed, ...suspiciousFields(contact)])]
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

  /** Live camera: quick-read a frame and decide whether the text is clear enough. */
  const evaluate = useCallback(
    async (photo: Blob, report: (p: number) => void): Promise<Verdict> => {
      const { lines, clarity, rawText } = await readCard(photo, (p) => report(p), { quick: true })
      const contact = parseBusinessCard(lines)
      const reading: Reading = { photo, lines, contact, clarity, hasKeyFields: hasKeyFields(contact, rawText) }
      readings.current.push(reading)
      const all = readings.current
      const clear = all.filter((r) => r.clarity >= CLEAR && r.hasKeyFields)
      const best = [...(clear.length ? clear : all)].sort((a, b) => b.clarity - a.clarity)[0]
      // Never settle for unclear text: keep the camera going until at least one clear reading.
      const enough = clear.length >= 2 || (clear.length === 1 && (reading.clarity >= VERY_CLEAR || all.length >= MAX_TRIES))
      if (enough) {
        void finish(best, all.filter((r) => r !== best))
        return { done: true }
      }
      if (reading.clarity >= CLEAR && reading.hasKeyFields) return { done: false, message: 'Good, one more to double-check… hold still' }
      if (reading.clarity >= CLEAR) return { done: false, message: 'Some details aren’t readable yet: fit the whole card in the frame, avoid glare' }
      if (lines.length === 0) return { done: false, message: 'No text found yet: fill the frame with the card' }
      if (all.length >= MAX_TRIES) return { done: false, message: 'Still can’t read the small text. Turn your phone sideways and move closer, or tap the button to use this photo.' }
      return { done: false, message: 'Text is too small or fuzzy: move closer, or turn your phone sideways' }
    },
    [finish],
  )

  /** Manual shutter or a chosen photo: one careful read. */
  const single = useCallback(
    (photo: Blob) => {
      readings.current = []
      void finish({ photo, lines: [], contact: parseBusinessCard([]), clarity: 0, hasKeyFields: false }, [])
    },
    [finish],
  )

  const cameraUnavailable = useCallback(() => setCamera('unavailable'), [])

  if (camera === 'open') {
    return <CardCamera evaluate={evaluate} onManual={single} onChoosePhoto={single} onCancel={onCancel} onUnavailable={cameraUnavailable} />
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
            <input type="file" accept="image/*" capture="environment" className="hidden" disabled={busy} onChange={(e) => e.target.files?.[0] && single(e.target.files[0])} />
          </label>
        ) : (
          <button
            className="btn-primary col-span-2"
            disabled={busy}
            onClick={() => {
              readings.current = []
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
          <input type="file" accept="image/*" className="hidden" disabled={busy} onChange={(e) => e.target.files?.[0] && single(e.target.files[0])} />
        </label>
        <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      <p className="text-center text-xs text-slate-500">The first scan downloads the text reader (about 7 MB). After that it works offline.</p>
    </div>
  )
}
