import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { analyzeFrame, HINT_TEXT, hintFor, LIMITS, toGray, type Gray, type Hint, type Rect } from '../lib/frameCheck'

interface Props {
  /** Called with the cropped photo of just the card. */
  onCapture: (photo: Blob) => void
  onChoosePhoto: (file: File) => void
  onCancel: () => void
  /** Camera couldn't start (no permission / not supported). */
  onUnavailable: () => void
}

/** Card shape: between a business card (1.75) and an ID card (1.59). */
const CARD_ASPECT = 1.65
const ANALYSIS_WIDTH = 360
const TICK_MS = 140

/** Guide rectangle as fractions (0–1) of the video picture. */
function guideFractions(videoW: number, videoH: number, vertical: boolean): Rect {
  const aspect = vertical ? 1 / CARD_ASPECT : CARD_ASPECT
  let w = 0.9
  let h = (w * videoW) / aspect / videoH
  if (h > 0.8) {
    h = 0.8
    w = (h * videoH * aspect) / videoW
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

export default function CardCamera({ onCapture, onChoosePhoto, onCancel, onUnavailable }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const doneRef = useRef(false)
  const [vertical, setVertical] = useState(false)
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 })
  const [display, setDisplay] = useState({ left: 0, top: 0, width: 0, height: 0 })
  const [hint, setHint] = useState<Hint | 'starting'>('starting')
  const [progress, setProgress] = useState(0)
  const [flash, setFlash] = useState(false)

  const verticalRef = useRef(vertical)
  useEffect(() => {
    verticalRef.current = vertical
  }, [vertical])

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  /** Grabs a full-resolution frame and crops it to the guide (plus a small margin). */
  const capture = useCallback(() => {
    const video = videoRef.current
    if (!video || doneRef.current || !video.videoWidth) return
    doneRef.current = true
    setFlash(true)
    const vw = video.videoWidth
    const vh = video.videoHeight
    const g = guideFractions(vw, vh, verticalRef.current)
    const m = 0.03
    const sx = Math.max(0, (g.x - g.w * m) * vw)
    const sy = Math.max(0, (g.y - g.h * m) * vh)
    const sw = Math.min(vw - sx, g.w * (1 + 2 * m) * vw)
    const sh = Math.min(vh - sy, g.h * (1 + 2 * m) * vh)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(sw)
    canvas.height = Math.round(sh)
    canvas.getContext('2d')!.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    stop()
    canvas.toBlob((blob) => blob && onCapture(blob), 'image/jpeg', 0.95)
  }, [onCapture, stop])

  // Start the camera as soon as the viewfinder opens.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
          audio: false,
        })
        if (cancelled) return stream.getTracks().forEach((t) => t.stop())
        streamRef.current = stream
        // Ask for continuous autofocus where the browser supports it.
        const track = stream.getVideoTracks()[0]
        track?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {})
        const video = videoRef.current!
        video.srcObject = stream
        await video.play()
      } catch {
        if (!cancelled) onUnavailable()
      }
    })()
    return () => {
      cancelled = true
      stop()
    }
  }, [onUnavailable, stop])

  // Keep track of the picture's size (it flips when the phone rotates).
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

  // Where the picture actually sits on screen (it's letterboxed to fit), so the guide lines up.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || !videoSize.w) return
    const place = () => {
      const bw = box.clientWidth
      const bh = box.clientHeight
      const scale = Math.min(bw / videoSize.w, bh / videoSize.h)
      const width = videoSize.w * scale
      const height = videoSize.h * scale
      setDisplay({ left: (bw - width) / 2, top: (bh - height) / 2, width, height })
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(box)
    return () => ro.disconnect()
  }, [videoSize])

  // Watch the frames and capture automatically once the card is lined up, sharp and steady.
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
      const f = guideFractions(video.videoWidth, video.videoHeight, verticalRef.current)
      const guide = { x: f.x * small.width, y: f.y * small.height, w: f.w * small.width, h: f.h * small.height }
      const report = analyzeFrame(gray, guide, previous)
      previous = gray
      if (report.aligned) {
        recent.push(report.sharpness)
        if (recent.length > 14) recent.shift()
      }
      const h = hintFor(report, recent.length ? Math.max(...recent) : 0)
      good = h === 'ok' ? good + 1 : 0
      setHint(h)
      setProgress(Math.min(1, good / LIMITS.goodFramesNeeded))
      if (good >= LIMITS.goodFramesNeeded) capture()
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [videoSize.w, capture])

  const g = videoSize.w ? guideFractions(videoSize.w, videoSize.h, vertical) : null
  const portrait = videoSize.h > videoSize.w
  const ready = hint === 'ok'

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white" role="dialog" aria-label="Card camera">
      <div className="flex items-center justify-between px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button className="text-sm font-medium" onClick={() => { stop(); onCancel() }}>Cancel</button>
        <span className="text-sm font-semibold">Scan card</span>
        <button className="rounded-full bg-white/15 px-3 py-1 text-xs" onClick={() => {
            setVertical((v) => !v)
            setProgress(0)
          }} aria-pressed={vertical}>
          {vertical ? 'Vertical card' : 'Horizontal card'}
        </button>
      </div>

      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden">
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-contain" playsInline muted autoPlay />
        {g && (
          <div className="pointer-events-none absolute" style={{ left: display.left, top: display.top, width: display.width, height: display.height }}>
            <div
              className={`absolute rounded-2xl border-[3px] transition-colors duration-150 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] ${ready ? 'border-emerald-400' : 'border-white/90'}`}
              style={{ left: `${g.x * 100}%`, top: `${g.y * 100}%`, width: `${g.w * 100}%`, height: `${g.h * 100}%` }}
            >
              {ready && <div className="absolute inset-x-0 bottom-0 h-1 origin-left bg-emerald-400 transition-transform" style={{ transform: `scaleX(${progress})` }} />}
            </div>
          </div>
        )}
        {flash && <div className="pointer-events-none absolute inset-0 bg-white/80" />}
      </div>

      <div className="space-y-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <p className={`text-center text-sm font-medium ${ready ? 'text-emerald-300' : ''}`} aria-live="polite">
          {hint === 'starting' ? 'Starting camera…' : HINT_TEXT[hint]}
        </p>
        {portrait && !vertical && hint === 'closer' && (
          <p className="text-center text-xs text-white/70">Tip: turn your phone sideways for a bigger, sharper picture.</p>
        )}
        <div className="flex items-center justify-between">
          <label className="w-24 cursor-pointer text-xs text-white/80 underline">
            Choose photo
            <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { stop(); onChoosePhoto(f) } }} />
          </label>
          <button
            className="size-16 rounded-full border-4 border-white bg-white/20 active:bg-white/60"
            onClick={capture}
            aria-label="Take photo now"
            disabled={!videoSize.w}
          />
          <span className="w-24 text-right text-xs text-white/60">Auto-capture on</span>
        </div>
      </div>
    </div>
  )
}
