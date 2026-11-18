import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { analyzeFrame, sharpness, toGray, type Gray, type Hint, type Rect } from '../lib/frameCheck'

interface Props {
  /**
   * Called once with the captured photo (cropped to the frame, at full camera resolution).
   * `sideways` is true when the card lay sideways in a tall frame (phone held upright).
   */
  onCapture: (photo: Blob, sideways: boolean) => void
  onChoosePhoto: (file: File) => void
  onCancel: () => void
  /** Camera couldn't start and the person chose to use the camera app instead. */
  onUnavailable: () => void
  /** The live picture is showing (a good moment to load the text reader). */
  onReady?: () => void
}

/** Card shape: between a business card (1.75) and an ID card (1.59). */
const CARD_ASPECT = 1.65
const ANALYSIS_WIDTH = 320
const TICK_MS = 120
/** Don't auto-capture in the first moments: let the camera's autofocus start working. */
const SETTLE_MS = 600
/** Frames in a row that must pass before capturing (~0.25 s). */
const STEADY_FRAMES = 2
/** Until this long after the camera starts, also wait for the card to roughly fill the frame. */
const FILL_PREFERRED_MS = 2500
/**
 * Movement is measured on a very coarse copy of the picture (blocks of 4×4 preview pixels),
 * so hand tremor and sensor noise don't count, only real movement (sweeping the phone/card).
 */
const MOVING = 9
/**
 * Focus is judged on a full-resolution patch from the middle of the frame: a small preview
 * can't see the slight blur that ruins small print (tested: slight blur halves this score).
 * The score must reach this floor and be close to the best seen recently (focus has settled).
 */
const FOCUS_MIN = 2.5
const FOCUS_NEAR_BEST = 0.82
/** How much recent history "best focus" looks back over (frames, ~2 s). */
const FOCUS_WINDOW = 16
/** Burst: grab this many full-resolution frames and keep the sharpest. */
const BURST = 3
const BURST_GAP_MS = 90

interface Layout {
  /** Visible area of the camera box on screen. */
  boxW: number
  boxH: number
  /** How the video is scaled/cropped to fill the box ("cover"). */
  scale: number
  offX: number
  offY: number
  /** Guide rectangle on screen. */
  guide: Rect
}

/**
 * The guide is as big as the screen allows, with the card's long edge along the screen's long
 * edge (horizontal when the phone is sideways, tall when upright). `flipped` turns it.
 */
function computeLayout(boxW: number, boxH: number, videoW: number, videoH: number, flipped: boolean): Layout {
  const scale = Math.max(boxW / videoW, boxH / videoH)
  const offX = (boxW - videoW * scale) / 2
  const offY = (boxH - videoH * scale) / 2
  const longWays = boxW >= boxH ? CARD_ASPECT : 1 / CARD_ASPECT
  const aspect = flipped ? 1 / longWays : longWays
  let w = boxW * 0.92
  let h = w / aspect
  if (h > boxH * 0.88) {
    h = boxH * 0.88
    w = h * aspect
  }
  return { boxW, boxH, scale, offX, offY, guide: { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h } }
}

/** Guide (screen) -> rectangle in camera pixels, with a small margin, clamped to the picture. */
function guideInVideo(l: Layout, videoW: number, videoH: number, margin = 0.04): Rect {
  const g = l.guide
  const x0 = Math.max(0, (g.x - g.w * margin - l.offX) / l.scale)
  const y0 = Math.max(0, (g.y - g.h * margin - l.offY) / l.scale)
  const x1 = Math.min(videoW, (g.x + g.w * (1 + margin) - l.offX) / l.scale)
  const y1 = Math.min(videoH, (g.y + g.h * (1 + margin) - l.offY) / l.scale)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Averages 4×4 blocks: a coarse picture for measuring real movement, blind to tremor and noise. */
function coarse(g: Gray): Gray {
  const w = Math.floor(g.width / 4)
  const h = Math.floor(g.height / 4)
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) sum += g.data[(y * 4 + dy) * g.width + x * 4 + dx]
      data[y * w + x] = sum >> 4
    }
  return { data, width: w, height: h }
}

/** Average change between two coarse frames, ignoring an overall brightness shift (auto-exposure). */
function coarseMotion(a: Gray, b: Gray | null, r: Rect): number {
  if (!b || a.width !== b.width || a.height !== b.height) return 255
  const x0 = Math.max(0, Math.round(r.x))
  const x1 = Math.min(a.width, Math.round(r.x + r.w))
  const y0 = Math.max(0, Math.round(r.y))
  const y1 = Math.min(a.height, Math.round(r.y + r.h))
  let shift = 0
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    shift += a.data[y * a.width + x] - b.data[y * a.width + x]
    n++
  }
  if (!n) return 255
  shift /= n
  let sum = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += Math.abs(a.data[y * a.width + x] - b.data[y * a.width + x] - shift)
  return sum / n
}

/** Detail score of the middle of the guide at full camera resolution. */
function fineFocus(video: HTMLVideoElement, r: Rect, canvas: HTMLCanvasElement): number {
  const w = Math.min(900, Math.round(r.w * 0.5))
  const h = Math.min(600, Math.round(r.h * 0.5))
  if (w < 20 || h < 20) return 0
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(video, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h, 0, 0, w, h)
  const g = toGray(ctx.getImageData(0, 0, w, h).data, w, h)
  return sharpness(g, { x: 0, y: 0, w, h })
}

export default function CardCamera({ onCapture, onChoosePhoto, onCancel, onUnavailable, onReady }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const doneRef = useRef(false)
  const liveSince = useRef(0)
  const [flipped, setFlipped] = useState(false)
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 })
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [hint, setHint] = useState<Hint | 'starting'>('starting')
  const [steady, setSteady] = useState(0)
  const [capturing, setCapturing] = useState(false)
  const [cam, setCam] = useState<{ phase: 'requesting' | 'waiting' | 'live' | 'failed'; try: number; error?: string }>({ phase: 'requesting', try: 1 })
  /** Bump to restart the camera ("Try again"). */
  const [attempt, setAttempt] = useState(0)
  // Hidden diagnostics: tap the status text 3 times to show live focus/movement numbers.
  const [debug, setDebug] = useState('')
  const debugRef = useRef(false)
  const taps = useRef<number[]>([])
  const tapStatus = () => {
    const now = Date.now()
    taps.current = [...taps.current.filter((t) => now - t < 1500), now]
    if (taps.current.length >= 3) {
      debugRef.current = !debugRef.current
      setDebug(debugRef.current ? '…' : '')
      taps.current = []
    }
  }

  const layout = videoSize.w && box.w ? computeLayout(box.w, box.h, videoSize.w, videoSize.h, flipped) : null
  const layoutRef = useRef(layout)
  useEffect(() => {
    layoutRef.current = layout
  })

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  /** Burst of full-resolution frames cropped to the guide; keeps the sharpest one. */
  const capture = useCallback(async () => {
    const video = videoRef.current
    const l = layoutRef.current
    if (!video || !l || doneRef.current || !video.videoWidth) return
    doneRef.current = true
    setCapturing(true)
    const vw = video.videoWidth
    const vh = video.videoHeight
    const r = guideInVideo(l, vw, vh)
    const shots: { canvas: HTMLCanvasElement; score: number }[] = []
    const probe = document.createElement('canvas')
    for (let i = 0; i < BURST; i++) {
      if (i) await new Promise((res) => setTimeout(res, BURST_GAP_MS))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(r.w)
      canvas.height = Math.round(r.h)
      canvas.getContext('2d')!.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height)
      // Score sharpness on a reduced copy.
      probe.width = 480
      probe.height = Math.max(1, Math.round((480 * canvas.height) / canvas.width))
      const pctx = probe.getContext('2d', { willReadFrequently: true })!
      pctx.drawImage(canvas, 0, 0, probe.width, probe.height)
      const g = toGray(pctx.getImageData(0, 0, probe.width, probe.height).data, probe.width, probe.height)
      shots.push({ canvas, score: sharpness(g, { x: 0, y: 0, w: g.width, h: g.height }) })
    }
    const best = shots.sort((a, b) => b.score - a.score)[0].canvas
    const sideways = l.boxH > l.boxW && !flipped
    stop()
    best.toBlob((blob) => blob && onCapture(blob, sideways), 'image/jpeg', 0.95)
  }, [flipped, onCapture, stop])

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

  // Track the picture's size (it flips when the phone rotates) and the on-screen box size.
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
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (cam.phase === 'live' && !liveSince.current) liveSince.current = Date.now()
  }, [cam.phase])

  // Auto-capture: no text reading here, just wait until the picture is steady and the camera's
  // own autofocus has settled (sharpness stops improving), then take the photo.
  useEffect(() => {
    if (!videoSize.w) return
    const small = document.createElement('canvas')
    const ctx = small.getContext('2d', { willReadFrequently: true })!
    const patch = document.createElement('canvas')
    let previous: Gray | null = null
    let good = 0
    const recentFocus: number[] = []
    const timer = window.setInterval(() => {
      const video = videoRef.current
      const l = layoutRef.current
      if (!video || !l || doneRef.current || !video.videoWidth) return
      small.width = ANALYSIS_WIDTH
      small.height = Math.round((ANALYSIS_WIDTH * video.videoHeight) / video.videoWidth)
      ctx.drawImage(video, 0, 0, small.width, small.height)
      const gray = toGray(ctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height)
      const r = guideInVideo(l, video.videoWidth, video.videoHeight, 0)
      const k = small.width / video.videoWidth
      const guide = { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k }
      const report = analyzeFrame(gray, guide, null)
      const c = coarse(gray)
      const motion = coarseMotion(c, previous, { x: guide.x / 4, y: guide.y / 4, w: guide.w / 4, h: guide.h / 4 })
      previous = c
      const focus = fineFocus(video, r, patch)
      recentFocus.push(focus)
      if (recentFocus.length > FOCUS_WINDOW) recentFocus.shift()
      const best = Math.max(...recentFocus)
      // The card roughly fills the frame. A real card edge near the frame line scores 0.85–1.0
      // per side; busy backgrounds stay low. Only required during the first moments.
      const filled = report.sides.filter((v) => v >= 0.6).length >= 3 || report.sides.filter((v) => v >= 0.8).length >= 2
      const age = liveSince.current ? Date.now() - liveSince.current : 0

      let h: Hint
      if (report.brightness < 40) h = 'dark'
      else if (motion > MOVING) h = 'steady'
      else if (focus < FOCUS_MIN || focus < best * FOCUS_NEAR_BEST) h = 'focus'
      else if (!filled && age < FILL_PREFERRED_MS) h = 'closer'
      else h = 'ok'
      setHint(h)
      if (debugRef.current) {
        setDebug(`focus ${focus.toFixed(1)} / best ${best.toFixed(1)} · move ${motion.toFixed(1)} · sides ${report.sides.map((v) => v.toFixed(1)).join(' ')} · light ${report.brightness.toFixed(0)}`)
      }
      good = h === 'ok' && age > SETTLE_MS ? good + 1 : 0
      setSteady(good)
      if (good >= STEADY_FRAMES) void capture()
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [videoSize.w, capture])

  const sidewaysUi = box.h > box.w && !flipped
  const status =
    cam.phase === 'requesting'
      ? cam.try > 1
        ? `Retrying the camera (${cam.try}/3)…`
        : 'Asking for the camera…'
      : cam.phase === 'failed'
        ? 'Camera unavailable'
        : capturing
          ? 'Got it'
          : hint === 'starting' || cam.phase === 'waiting'
            ? 'Starting camera…'
            : hint === 'ok'
              ? 'Hold still…'
              : hint === 'steady'
                ? 'Hold steady'
                : hint === 'focus'
                  ? 'Focusing…'
                  : hint === 'dark'
                    ? 'Too dark: find more light'
                    : hint === 'bright'
                      ? 'Glare: tilt the card slightly'
                      : 'Move closer: fill the frame with the card'
  const progress = Math.min(1, steady / STEADY_FRAMES)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white landscape:flex-row" role="dialog" aria-label="Card camera">
      {/* Camera fills all space not used by the controls. */}
      <div ref={boxRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted autoPlay />
        {layout && (
          <div
            className={`pointer-events-none absolute rounded-2xl border-[3px] shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] transition-colors ${
              capturing ? 'border-sky-400' : hint === 'ok' ? 'border-emerald-400' : 'border-white/90'
            }`}
            style={{ left: layout.guide.x, top: layout.guide.y, width: layout.guide.w, height: layout.guide.h }}
          >
            {progress > 0 && !capturing && (
              <div className="absolute inset-x-0 bottom-0 h-1 origin-left bg-emerald-400" style={{ transform: `scaleX(${progress})` }} />
            )}
            {sidewaysUi && (
              // On the frame's left edge, which is the bottom once the phone is turned sideways.
              <div className="absolute inset-y-0 left-0 flex w-0 items-center justify-center">
                <div className="w-max rotate-90 whitespace-nowrap rounded-full bg-black/70 px-4 py-1.5 text-xs font-semibold">
                  Turn phone sideways · fill the frame with the card
                </div>
              </div>
            )}
          </div>
        )}
        {capturing && <div className="pointer-events-none absolute inset-0 animate-pulse bg-white/30" />}
        {debug && (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 rounded bg-black/70 px-2 py-1 font-mono text-[10px] leading-tight text-emerald-300">{debug}</div>
        )}

        {/* Top bar floats over the picture so it doesn't take space. */}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent px-4 pb-6 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <button className="text-sm font-medium" onClick={() => { stop(); onCancel() }}>Cancel</button>
          <button
            className="rounded-full bg-white/15 px-3 py-1 text-xs"
            onClick={() => setFlipped((v) => !v)}
            aria-pressed={flipped}
            title="Turn the frame for a vertical badge"
          >
            ⟲ Rotate frame
          </button>
        </div>

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
      </div>

      {/* Controls: a bottom bar when upright, a side column when sideways. */}
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 landscape:w-36 landscape:flex-col landscape:justify-center landscape:px-3 landscape:pb-3 landscape:pr-[max(0.75rem,env(safe-area-inset-right))]">
        <label className="w-20 cursor-pointer text-xs text-white/80 underline landscape:order-3 landscape:w-auto">
          Choose photo
          <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { stop(); onChoosePhoto(f) } }} />
        </label>
        <button
          className="size-16 shrink-0 rounded-full border-4 border-white bg-white/20 active:bg-white/60 landscape:order-2"
          onClick={() => void capture()}
          aria-label="Take photo now"
          disabled={!videoSize.w || capturing}
        />
        <p className="w-20 text-right text-xs font-medium landscape:order-1 landscape:w-auto landscape:text-center" aria-live="polite" onClick={tapStatus}>
          {status}
        </p>
      </div>
    </div>
  )
}
