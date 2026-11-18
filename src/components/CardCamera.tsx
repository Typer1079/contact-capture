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

  // Start the camera as soon as the viewfinder opens.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // ~1920 px on the long side starts much faster than 4K on phones, and with the card along
          // the long edge it still gives ~1,600 pixels across the card. Same ideal for width and
          // height so the camera keeps its natural shape in either orientation.
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1920 } },
          audio: false,
        })
        if (cancelled) return stream.getTracks().forEach((t) => t.stop())
        streamRef.current = stream
        const track = stream.getVideoTracks()[0]
        track?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {})
        const video = videoRef.current!
        video.srcObject = stream
        await video.play()
        // Load the text reader only once the picture is up, so it doesn't slow the camera start.
        if (!cancelled) window.setTimeout(() => onReady?.(), 250)
      } catch {
        if (!cancelled) onUnavailable()
      }
    })()
    return () => {
      cancelled = true
      stop()
    }
  }, [onUnavailable, onReady, stop])

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
    hint === 'starting'
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
