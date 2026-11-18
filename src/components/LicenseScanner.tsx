import { useCallback, useEffect, useRef, useState } from 'react'
import { parseAamva, type LicenseContact } from '../lib/aamva'
import { DESKEW_ANGLES, initBarcodeReader, scanImage, scanPhoto, type ScanResult } from '../lib/barcode'

interface Props {
  onResult: (contact: LicenseContact, consentAt: string) => void
  onCancel: () => void
}

type Stage = 'consent' | 'scanning'

export default function LicenseScanner({ onResult, onCancel }: Props) {
  const [stage, setStage] = useState<Stage>('consent')
  const [requested, setRequested] = useState(false)
  const [personalUse, setPersonalUse] = useState(false)
  const [consentAt, setConsentAt] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [showHint, setShowHint] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const doneRef = useRef(false)

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const handleRaw = useCallback(
    (result: ScanResult) => {
      if (doneRef.current || !consentAt) return false
      const raw = result.text
      if (!raw) {
        if (result.sawSmallBarcode) setError('That’s the small barcode. Aim at the large, wide barcode on the back of the license.')
        return false
      }
      const parsed = parseAamva(raw)
      // `raw` holds the full license data; it goes out of scope here and is never stored or sent.
      if (!parsed) {
        setError('Found a barcode, but it isn’t a readable driver’s license. Try again.')
        return false
      }
      doneRef.current = true
      stopCamera()
      onResult(parsed, consentAt)
      return true
    },
    [consentAt, onResult, stopCamera],
  )

  // Live camera scanning loop.
  useEffect(() => {
    if (stage !== 'scanning') return
    let cancelled = false
    let timer: number | undefined

    async function start() {
      setStatus('Starting camera…')
      try {
        await initBarcodeReader()
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current!
        video.srcObject = stream
        await video.play()
        setStatus('Fit the large barcode inside the frame and hold steady.')
        tick()
      } catch {
        setStatus('')
        setError('Camera unavailable. Allow camera access, or use “Take a photo instead” below.')
      }
    }

    let frame = 0
    async function tick() {
      if (cancelled || doneRef.current) return
      const video = videoRef.current
      if (video && video.videoWidth) {
        // Only look inside the card guide (88% of the width, card-shaped), with some margin.
        const vw = video.videoWidth
        const vh = video.videoHeight
        const w = Math.round(vw * 0.94)
        const h = Math.min(vh, Math.round((w / 1.586) * 1.15))
        const region = { x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), w, h }
        // Each frame: straight, plus one tilt angle, cycling through the list.
        const angle = DESKEW_ANGLES[1 + (frame % (DESKEW_ANGLES.length - 1))]
        frame++
        try {
          if (handleRaw(await scanImage(video, region, [0, angle], 1920))) return
        } catch {
          /* keep scanning */
        }
      }
      timer = window.setTimeout(tick, 120)
    }

    const hintTimer = window.setTimeout(() => setShowHint(true), 8000)
    start()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearTimeout(hintTimer)
      stopCamera()
    }
  }, [stage, handleRaw, stopCamera])

  async function onPhoto(file: File | undefined) {
    if (!file) return
    setError('')
    setStatus('Reading photo…')
    try {
      const result = await scanPhoto(file)
      if (!handleRaw(result) && !result.sawSmallBarcode && !result.text) {
        setError('No license barcode found in that photo. Fill the frame with the large barcode, keep it sharp, and avoid glare.')
      }
    } catch {
      setError('Couldn’t read that photo.')
    } finally {
      setStatus('')
    }
  }

  if (stage === 'consent') {
    const ok = requested && personalUse
    return (
      <div className="space-y-4">
        <div className="card space-y-3 text-sm">
          <h2 className="text-base font-semibold">Before you scan</h2>
          <p>
            The barcode is read <strong>on this device</strong>. Only the person’s <strong>name and address</strong> are kept. The license
            number, birth date and physical details are discarded right away and never saved or sent anywhere.
          </p>
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={requested} onChange={(e) => setRequested(e.target.checked)} />
            <span>The license holder voluntarily asked me to scan their license and agreed to me saving their name and address.</span>
          </label>
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={personalUse} onChange={(e) => setPersonalUse(e.target.checked)} />
            <span>I won’t use this for marketing, solicitation, or send it to a CRM.</span>
          </label>
        </div>
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onCancel}>Cancel</button>
          <button
            className="btn-primary flex-1"
            disabled={!ok}
            onClick={() => {
              setConsentAt(new Date().toISOString())
              setStage('scanning')
            }}
          >
            Start scanning
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-2xl bg-black">
        <video ref={videoRef} className="aspect-[4/3] w-full object-cover" playsInline muted />
        {/* Card-shaped guide */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="aspect-[1.586] w-[88%] rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
        </div>
      </div>

      <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">
        Turn the license over. Scan the <strong>large, wide barcode</strong>, not the small one.
      </p>
      {status && <p className="text-center text-sm text-slate-600">{status}</p>}
      {showHint && !error && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Having trouble? Tap <strong>Take a photo instead</strong>. Your phone’s camera focuses better up close and usually reads it on the first try.
        </p>
      )}
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex gap-3">
        <button className="btn-secondary flex-1" onClick={onCancel}>Cancel</button>
        <label className="btn-secondary flex-1 cursor-pointer text-center">
          Take a photo instead
          <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onPhoto(e.target.files?.[0])} />
        </label>
      </div>
      <p className="text-center text-xs text-slate-500">
        The photo option opens your camera app. Take the picture, tap <strong>Use Photo</strong>, and you’ll come back here. The photo isn’t saved.
      </p>
    </div>
  )
}
