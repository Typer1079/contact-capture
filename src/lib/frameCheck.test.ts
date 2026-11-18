import { describe, expect, it } from 'vitest'
import { analyzeFrame, hintFor, type Gray, type Rect } from './frameCheck'

/** Draws a light "card" with dark text-like marks on a background. */
function scene(card: Rect, opts: { background?: 'dark' | 'noise'; blur?: boolean; shift?: number } = {}): Gray {
  const width = 360
  const height = 640
  const data = new Uint8Array(width * height)
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = opts.background === 'noise' ? (rand() < 0.15 ? 200 : 60) : 40
      const cx = x - (opts.shift ?? 0)
      if (cx >= card.x && cx < card.x + card.w && y >= card.y && y < card.y + card.h) {
        v = 225
        // "text": short dark strokes in rows, with a margin like a real card
        if ((y - card.y) % 14 < 4 && (cx - card.x) % 9 < 5 && cx > card.x + 10 && cx < card.x + card.w - 10 && y > card.y + 10 && y < card.y + card.h - 10) v = 30
      }
      data[y * width + x] = v
    }
  }
  if (opts.blur) {
    const out = new Uint8Array(data.length)
    for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
      let s = 0
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += data[(y + dy) * width + x + dx]
      out[y * width + x] = s / 25
    }
    return { data: out, width, height }
  }
  return { data, width, height }
}

const guide: Rect = { x: 18, y: 220, w: 324, h: 200 }

describe('frame check', () => {
  it('sees a card that fills the guide', () => {
    const r = analyzeFrame(scene(guide), guide, null)
    expect(r.aligned).toBe(true)
  })

  it('tolerates the card being a little off the guide', () => {
    expect(analyzeFrame(scene({ x: 24, y: 228, w: 316, h: 190 }), guide, null).aligned).toBe(true)
  })

  it('says "closer" when the card is too small in the frame', () => {
    const small = { x: 100, y: 270, w: 160, h: 100 }
    const r = analyzeFrame(scene(small), guide, null)
    expect(r.aligned).toBe(false)
    expect(hintFor(r, 0)).toBe('closer')
  })

  it('is not fooled by a busy background with no card', () => {
    const r = analyzeFrame(scene({ x: 0, y: 0, w: 0, h: 0 }, { background: 'noise' }), guide, null)
    expect(r.aligned).toBe(false)
  })

  it('waits for the phone to be steady, then for focus', () => {
    const a = scene(guide)
    const moved = scene(guide, { shift: 6 })
    expect(hintFor(analyzeFrame(moved, guide, a), 0)).toBe('steady')
    const still = analyzeFrame(a, guide, a)
    expect(hintFor(still, 0)).toBe('ok')
    // Same frame, but blurry compared with a sharp one seen moments ago -> keep focusing.
    const blurry = scene(guide, { blur: true })
    const rb = analyzeFrame(blurry, guide, blurry)
    expect(rb.sharpness).toBeLessThan(still.sharpness)
    expect(hintFor(rb, still.sharpness)).toBe('focus')
  })

  it('asks for more light when it is dark', () => {
    const g = scene(guide)
    g.data.forEach((v, i) => (g.data[i] = v / 6))
    expect(hintFor(analyzeFrame(g, guide, g), 0)).toBe('dark')
  })
})
