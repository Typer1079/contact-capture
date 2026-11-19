/**
 * Keeps the camera connected for a few minutes after a scan, so the next scan (or a Retake)
 * reuses it instead of asking for the camera again. iPhone Home Screen apps can't remember
 * camera permission, so every new camera request shows the "Allow camera?" prompt.
 *
 * The camera is turned off when the time is up, when the app goes to the background
 * (switching apps, locking the phone) and on sign out.
 */
const KEEP_MS = 3 * 60_000

let parked: MediaStream | null = null
let timer: number | undefined

function isLive(s: MediaStream | null): boolean {
  return Boolean(s && s.getVideoTracks().length && s.getVideoTracks().every((t) => t.readyState === 'live'))
}

/** Hand the camera back when a scanner closes; it stays on for a few minutes in case it's needed again. */
export function parkCamera(stream: MediaStream | null) {
  if (!stream) return
  if (parked && parked !== stream) stopParkedCamera()
  if (!isLive(stream)) {
    stream.getTracks().forEach((t) => t.stop())
    return
  }
  parked = stream
  window.clearTimeout(timer)
  timer = window.setTimeout(stopParkedCamera, KEEP_MS)
}

/** The parked camera, if it's still running (and now owned by the caller). */
export function takeParkedCamera(): MediaStream | null {
  window.clearTimeout(timer)
  const s = parked
  parked = null
  if (s && isLive(s)) return s
  s?.getTracks().forEach((t) => t.stop())
  return null
}

/** Turn the parked camera off now. */
export function stopParkedCamera() {
  window.clearTimeout(timer)
  parked?.getTracks().forEach((t) => t.stop())
  parked = null
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopParkedCamera()
  })
  window.addEventListener('pagehide', stopParkedCamera)
}
