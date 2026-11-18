/**
 * Decides, from a small grayscale copy of the camera frame, whether a card is lined up
 * inside the on-screen guide and the picture is good enough to capture automatically.
 *
 * Four checks, all cheap enough to run several times a second on a phone:
 * - edges:  the card's outline sits along the guide (on at least 3 of the 4 sides)
 * - sharp:  enough fine detail inside the guide (not blurry / still focusing)
 * - steady: barely any change since the previous frame (hands are still)
 * - light:  not too dark, not blown out
 */

export interface Gray {
  data: Uint8Array // one byte per pixel
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface FrameReport {
  /** Fraction (0–1) of each side's length where a strong edge was found near the guide: top, right, bottom, left. */
  sides: [number, number, number, number]
  aligned: boolean
  sharpness: number
  brightness: number
  /** Mean absolute change vs. the previous frame inside the guide (0–255), or null for the first frame. */
  motion: number | null
}

export type Hint = 'ok' | 'closer' | 'steady' | 'focus' | 'dark' | 'bright'

export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Gray {
  const data = new Uint8Array(width * height)
  for (let i = 0, p = 0; p < data.length; i += 4, p++) data[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8
  return { data, width, height }
}

const at = (g: Gray, x: number, y: number) => g.data[Math.min(g.height - 1, Math.max(0, y)) * g.width + Math.min(g.width - 1, Math.max(0, x))]

/** Strength of a horizontal (or vertical) edge at a point: brightness step across it. */
function step(g: Gray, x: number, y: number, horizontalEdge: boolean): number {
  return horizontalEdge ? Math.abs(at(g, x, y + 2) - at(g, x, y - 2)) : Math.abs(at(g, x + 2, y) - at(g, x - 2, y))
}

/**
 * For each guide side, walks along it and looks across a band for the card's edge.
 * A real card edge is one straight line, so a side only scores where the strongest edge
 * sits at (nearly) the same distance from the guide as along the rest of that side.
 * Busy backgrounds (maps, wood grain) have edges at random distances and score low.
 * `band` is how far (fraction of the guide size) the card edge may sit from the guide line.
 */
export function sideCoverage(g: Gray, r: Rect, band = 0.07, threshold = 28): [number, number, number, number] {
  const samples = 32
  const bandX = Math.max(2, Math.round(r.w * band))
  const bandY = Math.max(2, Math.round(r.h * band))
  const score = (along: (t: number) => [number, number], across: [number, number], horizontalEdge: boolean, reach: number) => {
    const offsets: number[] = []
    for (let s = 1; s < samples; s++) {
      const [x0, y0] = along(s / samples)
      const vals: number[] = []
      let best = 0
      let bestD = 0
      for (let d = -reach; d <= reach; d++) {
        const v = step(g, Math.round(x0 + across[0] * d), Math.round(y0 + across[1] * d), horizontalEdge)
        vals.push(v)
        if (v > best) {
          best = v
          bestD = d
        }
      }
      if (best < threshold) continue
      // Texture and noise have many separate spots almost as strong -> not a card edge.
      // (A few is fine: printed text near the card's edge.)
      // Count separate groups of strong pixels (one edge spans a few neighboring pixels).
      let groups = 0
      for (let k = 0; k < vals.length; k++) if (vals[k] >= best * 0.8 && (k === 0 || vals[k - 1] < best * 0.8)) groups++
      if (groups > 3) continue
      // The card's edge is the strong edge closest to the guide line (text sits further inside).
      let pick = bestD
      for (let k = 0; k < vals.length; k++) {
        const d = k - reach
        if (vals[k] >= Math.max(threshold, best * 0.6) && Math.abs(d) < Math.abs(pick)) pick = d
      }
      offsets.push(pick)
    }
    if (offsets.length < 3) return 0
    const sorted = [...offsets].sort((a, b) => a - b)
    const median = sorted[sorted.length >> 1]
    // Allow a slight tilt: tolerance grows a little with the band size.
    const tol = Math.max(2, Math.round(reach * 0.25))
    const straight = offsets.filter((d) => Math.abs(d - median) <= tol).length
    return straight / (samples - 1)
  }
  return [
    score((t) => [r.x + r.w * t, r.y], [0, 1], true, bandY),
    score((t) => [r.x + r.w, r.y + r.h * t], [1, 0], false, bandX),
    score((t) => [r.x + r.w * t, r.y + r.h], [0, 1], true, bandY),
    score((t) => [r.x, r.y + r.h * t], [1, 0], false, bandX),
  ]
}

/** Average fine detail (Laplacian) inside the rect. Blurry or out-of-focus frames score low. */
export function sharpness(g: Gray, r: Rect): number {
  let sum = 0
  let n = 0
  const x1 = Math.min(g.width - 2, Math.round(r.x + r.w))
  const y1 = Math.min(g.height - 2, Math.round(r.y + r.h))
  for (let y = Math.max(1, Math.round(r.y)); y < y1; y += 2) {
    for (let x = Math.max(1, Math.round(r.x)); x < x1; x += 2) {
      const i = y * g.width + x
      const lap = 4 * g.data[i] - g.data[i - 1] - g.data[i + 1] - g.data[i - g.width] - g.data[i + g.width]
      sum += Math.abs(lap)
      n++
    }
  }
  return n ? sum / n : 0
}

function meanInside(g: Gray, r: Rect): number {
  let sum = 0
  let n = 0
  for (let y = Math.round(r.y); y < r.y + r.h; y += 3) for (let x = Math.round(r.x); x < r.x + r.w; x += 3) {
    sum += at(g, x, y)
    n++
  }
  return n ? sum / n : 0
}

function motion(a: Gray, b: Gray, r: Rect): number {
  if (a.width !== b.width || a.height !== b.height) return 255
  let sum = 0
  let n = 0
  for (let y = Math.round(r.y); y < r.y + r.h; y += 3) for (let x = Math.round(r.x); x < r.x + r.w; x += 3) {
    const i = Math.min(a.height - 1, y) * a.width + Math.min(a.width - 1, x)
    sum += Math.abs(a.data[i] - b.data[i])
    n++
  }
  return n ? sum / n : 255
}

export function analyzeFrame(g: Gray, guide: Rect, previous: Gray | null): FrameReport {
  const sides = sideCoverage(g, guide)
  const strongSides = sides.filter((s) => s >= 0.6).length
  return {
    sides,
    aligned: strongSides >= 3,
    sharpness: sharpness(g, guide),
    brightness: meanInside(g, guide),
    motion: previous ? motion(g, previous, guide) : null,
  }
}

export const LIMITS = {
  minBrightness: 45,
  maxBrightness: 235,
  maxMotion: 7,
  /** Absolute floor for detail; a lined-up card with readable text is well above this. */
  minSharpness: 8,
  /** A frame must be at least this fraction as sharp as the sharpest recent frame. */
  relativeSharpness: 0.75,
  /** How many good frames in a row before capturing. */
  goodFramesNeeded: 2,
}

/**
 * Picks the single most useful instruction for the person holding the phone.
 * With `requireAlignment: false` the card doesn't have to line up with the guide exactly:
 * the text reader decides whether the picture is good enough (see CardScanner).
 */
export function hintFor(r: FrameReport, recentMaxSharpness: number, requireAlignment = true): Hint {
  if (r.brightness < LIMITS.minBrightness) return 'dark'
  if (r.brightness > LIMITS.maxBrightness) return 'bright'
  if (requireAlignment && !r.aligned) return 'closer'
  if (r.motion === null || r.motion > LIMITS.maxMotion) return 'steady'
  if (r.sharpness < LIMITS.minSharpness || r.sharpness < recentMaxSharpness * LIMITS.relativeSharpness) return 'focus'
  return 'ok'
}

export const HINT_TEXT: Record<Hint, string> = {
  ok: 'Hold still…',
  closer: 'Move closer until the card’s edges line up with the frame',
  steady: 'Hold steady',
  focus: 'Focusing…',
  dark: 'Too dark: find more light',
  bright: 'Too bright: tilt the card to avoid glare',
}
