import { useCallback, useEffect, useRef, useState } from 'react'
import { parseAamva, type LicenseContact } from '../lib/aamva'
import { initBarcodeReader, readPdf417 } from '../lib/barcode'

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

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const doneRef = useRef(false)

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const handleRaw = useCallback(
    (raw: string | null) => {
      if (!raw || doneRef.current || !consentAt) return false
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
        setStatus('Hold the back of the license flat, filling the frame.')
        tick()
      } catch {
        setStatus('')
        setError('Camera unavailable. Allow camera access, or use “Take a photo” below.')
      }
    }

    async function tick() {
      if (cancelled || doneRef.current) return
      const video = videoRef.current
      const canvas = canvasRef.current
      if (video && canvas && video.videoWidth) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(video, 0, 0)
        try {
          const raw = await readPdf417(ctx.getImageData(0, 0, canvas.width, canvas.height))
          if (handleRaw(raw)) return
        } catch {
          /* keep scanning */
        }
      }
      timer = window.setTimeout(tick, 250)
    }

    start()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      stopCamera()
    }
  }, [stage, handleRaw, stopCamera])

  async function onPhoto(file: File | undefined) {
    if (!file) return
    setError('')
    setStatus('Reading photo…')
    try {
      const raw = await readPdf417(file)
      if (!raw) setError('No license barcode found in that photo. Get closer and avoid glare.')
      else handleRaw(raw)
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
      <canvas ref={canvasRef} className="hidden" />

      {status && <p className="text-center text-sm text-slate-600">{status}</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex gap-3">
        <button className="btn-secondary flex-1" onClick={onCancel}>Cancel</button>
        <label className="btn-secondary flex-1 cursor-pointer">
          Take a photo
          <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onPhoto(e.target.files?.[0])} />
        </label>
      </div>
      <p className="text-center text-xs text-slate-500">Tip: a still photo often works better in low light or with glare.</p>
    </div>
  )
}
