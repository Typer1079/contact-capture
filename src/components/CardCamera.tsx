import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { analyzeFrame, HINT_TEXT, hintFor, LIMITS, toGray, type Gray, type Hint, type Rect } from '../lib/frameCheck'

export interface Verdict {
  /** true = good enough, stop the camera. */
  done: boolean
  /** What to tell the person when the frame wasn't good enough. */
  message?: string
}

interface Props {
  /**
   * Called with a cropped photo of the card whenever the picture is sharp and steady.
   * The scanner reads it and answers whether the text was clear enough.
   */
  evaluate: (photo: Blob, progress: (p: number) => void, sideways: boolean) => Promise<Verdict>
  /** Manual shutter: use this photo no matter what. */
  onManual: (photo: Blob) => void
  onChoosePhoto: (file: File) => void
  onCancel: () => void
  /** Camera couldn't start (no permission / not supported). */
  onUnavailable: () => void
  /** The live picture is showing (a good moment to load the text reader). */
  onReady?: () => void
}

/** Card shape: between a business card (1.75) and an ID card (1.59). */
const CARD_ASPECT = 1.65
const ANALYSIS_WIDTH = 360
const TICK_MS = 140
/** Pause between attempts so the person has time to react to a message. */
const RETRY_PAUSE_MS = 900

/**
 * Guide rectangle as fractions (0–1) of the video picture.
 * By default the card's long edge runs along the picture's long edge, which gives the card
 * the most pixels: horizontal when the phone is sideways, tall when the phone is upright
 * (the card then lies sideways in the frame). `flipped` turns the frame the other way.
 */
function guideFractions(videoW: number, videoH: number, flipped: boolean): Rect {
  const longWays = videoW >= videoH ? CARD_ASPECT : 1 / CARD_ASPECT
  const aspect = flipped ? 1 / longWays : longWays
  let w = 0.9
  let h = (w * videoW) / aspect / videoH
  if (h > 0.84) {
    h = 0.84
    w = (h * videoH * aspect) / videoW
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

/** Full-resolution frame cropped to the guide (plus a small margin). */
function cropToGuide(video: HTMLVideoElement, vertical: boolean): Promise<Blob | null> {
  const vw = video.videoWidth
  const vh = video.videoHeight
  const g = guideFractions(vw, vh, vertical)
  const m = 0.04
  const sx = Math.max(0, (g.x - g.w * m) * vw)
  const sy = Math.max(0, (g.y - g.h * m) * vh)
  const sw = Math.min(vw - sx, g.w * (1 + 2 * m) * vw)
  const sh = Math.min(vh - sy, g.h * (1 + 2 * m) * vh)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(sw)
  canvas.height = Math.round(sh)
  canvas.getContext('2d')!.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95))
}

export default function CardCamera({ evaluate, onManual, onChoosePhoto, onCancel, onUnavailable, onReady }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const doneRef = useRef(false)
  const busyRef = useRef(false)
  const pauseUntil = useRef(0)
  const [flipped, setFlipped] = useState(false)
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 })
  const [display, setDisplay] = useState({ left: 0, top: 0, width: 0, height: 0 })
  const [hint, setHint] = useState<Hint | 'starting'>('starting')
  const [aligned, setAligned] = useState(false)
  const [checking, setChecking] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [attempts, setAttempts] = useState(0)
  const [cam, setCam] = useState<{ phase: 'requesting' | 'waiting' | 'live' | 'failed'; try: number; error?: string }>({ phase: 'requesting', try: 1 })
  /** Bump to restart the camera ("Try again"). */
  const [attempt, setAttempt] = useState(0)

  const flippedRef = useRef(flipped)
  useEffect(() => {
    flippedRef.current = flipped
  }, [flipped])

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  /** Take a frame and let the scanner judge it; keep the camera running if it isn't readable yet. */
  const tryFrame = useCallback(async () => {
    const video = videoRef.current
    if (!video || doneRef.current || busyRef.current || !video.videoWidth) return
    busyRef.current = true
    setChecking(0)
    try {
      const blob = await cropToGuide(video, flippedRef.current)
      if (!blob) return
      // Phone upright + default frame = the card is lying sideways in the picture.
      const sideways = video.videoHeight > video.videoWidth && !flippedRef.current
      const verdict = await evaluate(blob, (p) => setChecking(p), sideways)
      setAttempts((n) => n + 1)
      if (verdict.done) {
        doneRef.current = true
        stop()
      } else {
        setMessage(verdict.message ?? '')
        pauseUntil.current = Date.now() + RETRY_PAUSE_MS
      }
    } finally {
      busyRef.current = false
      setChecking(null)
    }
  }, [evaluate, stop])

  const manual = useCallback(async () => {
    const video = videoRef.current
    if (!video || doneRef.current || !video.videoWidth) return
    doneRef.current = true
    const blob = await cropToGuide(video, flippedRef.current)
    stop()
    if (blob) onManual(blob)
  }, [onManual, stop])

  // Start the camera as soon as the viewfinder opens. iPhones can be fussy, so: set the video
  // up the way iOS expects, try a few camera requests from best to simplest, and use a watchdog
  // in case a camera "starts" but never sends a picture.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let cancelled = false
    let watchdog: number | undefined
    video.muted = true
    video.setAttribute('muted', '')
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')

    const requests: MediaStreamConstraints[] = [
      // Same request the license scanner uses (known to work on iPhone); iOS turns it to
      // 1080x1920 when the phone is upright.
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: { facingMode: 'environment' }, audio: false },
      { video: true, audio: false },
    ]

    const start = async (i: number): Promise<void> => {
      window.clearTimeout(watchdog)
      stop()
      setCam({ phase: 'requesting', try: i + 1 })
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia(requests[i])
      } catch (err) {
        if (cancelled) return
        const e = err as DOMException
        if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
          setCam({ phase: 'failed', try: i + 1, error: 'denied' })
          return
        }
        if (i + 1 < requests.length) return start(i + 1)
        setCam({ phase: 'failed', try: i + 1, error: `${e?.name ?? 'Error'}: ${e?.message ?? 'camera unavailable'}` })
        return
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      setCam({ phase: 'waiting', try: i + 1 })
      video.srcObject = stream
      watchdog = window.setTimeout(() => {
        if (cancelled || video.videoWidth) return
        if (i + 1 < requests.length) void start(i + 1)
        else setCam({ phase: 'failed', try: i + 1, error: 'The camera turned on but sent no picture.' })
      }, 4000)
      try {
        await video.play()
      } catch {
        // A play() hiccup doesn't always mean failure; the watchdog decides.
      }
    }

    const live = () => {
      if (!video.videoWidth || cancelled) return
      window.clearTimeout(watchdog)
      setCam((c) => (c.phase === 'live' ? c : { phase: 'live', try: c.try }))
    }
    video.addEventListener('loadeddata', live)
    video.addEventListener('playing', live)
    video.addEventListener('resize', live)
    void start(0)
    return () => {
      cancelled = true
      window.clearTimeout(watchdog)
      video.removeEventListener('loadeddata', live)
      video.removeEventListener('playing', live)
      video.removeEventListener('resize', live)
      stop()
    }
  }, [attempt, stop])

  // Load the text reader only once the picture is live, so it doesn't slow the camera start.
  useEffect(() => {
    if (cam.phase !== 'live') return
    const t = window.setTimeout(() => onReady?.(), 250)
    return () => window.clearTimeout(t)
  }, [cam.phase, onReady])

  // Track the picture's size (it flips when the phone rotates).
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const update = () => video.videoWidth && setVideoSize({ w: video.videoWidth, h: video.videoHeight })
    video.addEventListener('loadedmetadata', update)
    video.addEventListener('resize', update)
    return () => {
      video.removeEventListener('loadedmetadata', update)
      video.removeEventListener('resize', update)
    }
  }, [])

  // Where the picture sits on screen (letterboxed to fit), so the guide lines up with it.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || !videoSize.w) return
    const place = () => {
      const scale = Math.min(box.clientWidth / videoSize.w, box.clientHeight / videoSize.h)
      const width = videoSize.w * scale
      const height = videoSize.h * scale
      setDisplay({ left: (box.clientWidth - width) / 2, top: (box.clientHeight - height) / 2, width, height })
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(box)
    return () => ro.disconnect()
  }, [videoSize])

  // Watch frames. When sharp, steady and well lit, hand one to the text reader.
  useEffect(() => {
    if (!videoSize.w) return
    const small = document.createElement('canvas')
    const ctx = small.getContext('2d', { willReadFrequently: true })!
    let previous: Gray | null = null
    let good = 0
    const recent: number[] = []
    const timer = window.setInterval(() => {
      const video = videoRef.current
      if (!video || doneRef.current || !video.videoWidth) return
      small.width = ANALYSIS_WIDTH
      small.height = Math.round((ANALYSIS_WIDTH * video.videoHeight) / video.videoWidth)
      ctx.drawImage(video, 0, 0, small.width, small.height)
      const gray = toGray(ctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height)
      const f = guideFractions(video.videoWidth, video.videoHeight, flippedRef.current)
      const guide = { x: f.x * small.width, y: f.y * small.height, w: f.w * small.width, h: f.h * small.height }
      const report = analyzeFrame(gray, guide, previous)
      previous = gray
      recent.push(report.sharpness)
      if (recent.length > 14) recent.shift()
      const h = hintFor(report, Math.max(...recent), false)
      setHint(h)
      setAligned(report.aligned)
      good = h === 'ok' ? good + 1 : 0
      if (good >= LIMITS.goodFramesNeeded && !busyRef.current && Date.now() > pauseUntil.current) {
        good = 0
        void tryFrame()
      }
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [videoSize.w, tryFrame])

  const g = videoSize.w ? guideFractions(videoSize.w, videoSize.h, flipped) : null
  const portrait = videoSize.h > videoSize.w
  // Phone upright with the default tall frame: everything is meant to be read with the phone sideways.
  const sidewaysUi = portrait && !flipped

  const status =
    cam.phase === 'requesting'
      ? cam.try > 1
        ? `Retrying the camera (${cam.try}/3)…`
        : 'Asking for the camera…'
      : cam.phase === 'waiting'
        ? 'Starting camera…'
        : cam.phase === 'failed'
          ? 'Camera unavailable'
          : hint === 'starting'
            ? 'Starting camera…'
      : checking !== null
        ? 'Reading the text…'
        : message && hint === 'ok'
          ? message
          : hint === 'ok'
            ? 'Hold still…'
            : HINT_TEXT[hint]

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white" role="dialog" aria-label="Card camera">
      <div className="flex items-center justify-between px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button className="text-sm font-medium" onClick={() => { stop(); onCancel() }}>Cancel</button>
        <span className="text-sm font-semibold">Scan card</span>
        <button
          className="rounded-full bg-white/15 px-3 py-1 text-xs"
          onClick={() => {
            setFlipped((v) => !v)
            setMessage('')
          }}
          aria-pressed={flipped}
          title="Turn the frame for a vertical badge"
        >
          ⟲ Rotate frame
        </button>
      </div>

      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden">
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-contain" playsInline muted autoPlay />
        {cam.phase === 'failed' && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-4 text-sm text-slate-900">
              <h2 className="text-base font-semibold">The camera didn’t start</h2>
              {cam.error === 'denied' ? (
                <p>
                  Camera access is turned off for this app. On iPhone open <strong>Settings → Apps → Safari → Camera</strong> (older iOS:{' '}
                  <strong>Settings → Safari → Camera</strong>) and choose <strong>Allow</strong> or <strong>Ask</strong>, then close and reopen the app.
                </p>
              ) : (
                <p>
                  Close other apps that might be using the camera, then try again.
                  <span className="mt-1 block text-xs text-slate-500">Details: {cam.error}</span>
                </p>
              )}
              <div className="flex gap-2">
                <button className="btn-primary flex-1 py-2" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
                <button className="btn-secondary flex-1 py-2" onClick={() => { stop(); onUnavailable() }}>Use camera app</button>
              </div>
            </div>
          </div>
        )}
        {g && (
          <div className="pointer-events-none absolute" style={{ left: display.left, top: display.top, width: display.width, height: display.height }}>
            <div
              className={`absolute rounded-2xl border-[3px] transition-colors duration-150 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] ${
                checking !== null ? 'border-sky-400' : aligned ? 'border-emerald-400' : 'border-white/90'
              }`}
              style={{ left: `${g.x * 100}%`, top: `${g.y * 100}%`, width: `${g.w * 100}%`, height: `${g.h * 100}%` }}
            >
              {sidewaysUi && (
                // Sits on the frame's left edge, which is the bottom once the phone is turned sideways.
                <div className="absolute inset-y-0 left-0 flex w-0 items-center justify-center">
                  <div className="w-max rotate-90 whitespace-nowrap rounded-full bg-black/70 px-4 py-1.5 text-center text-xs font-semibold">
                    {checking !== null ? 'Reading…' : 'Turn phone sideways · fill the frame with the card'}
                  </div>
                </div>
              )}
              {checking !== null && (
                <div className="absolute inset-x-0 bottom-0 h-1 origin-left bg-sky-400 transition-transform" style={{ transform: `scaleX(${Math.max(0.05, checking)})` }} />
              )}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <p className={`min-h-10 text-center text-sm font-medium ${checking !== null ? 'text-sky-300' : ''}`} aria-live="polite">
          {status}
        </p>
        <div className="flex items-center justify-between">
          <label className="w-24 cursor-pointer text-xs text-white/80 underline">
            Choose photo
            <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { stop(); onChoosePhoto(f) } }} />
          </label>
          <button
            className="size-16 rounded-full border-4 border-white bg-white/20 active:bg-white/60"
            onClick={manual}
            aria-label="Take photo now"
            disabled={!videoSize.w}
          />
          <span className="w-24 text-right text-xs text-white/60">{attempts > 0 ? `Tries: ${attempts}` : 'Auto-capture on'}</span>
        </div>
      </div>
    </div>
  )
}
