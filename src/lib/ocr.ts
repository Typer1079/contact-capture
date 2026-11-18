import { createWorker, OEM, PSM, type Worker } from 'tesseract.js'
import type { CardLine } from './cardParser'

/**
 * On-device text recognition (Tesseract). The engine, its WebAssembly core, and the
 * English data are served from this site's /ocr/ folder (see vite.config.ts), so the
 * photo never leaves the phone and nothing loads from a third-party server.
 */

const base = import.meta.env.BASE_URL + 'ocr'

let workerPromise: Promise<Worker> | null = null
let onProgress: ((p: number, label: string) => void) | null = null

function getWorker(): Promise<Worker> {
  workerPromise ??= createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: `${base}/worker.min.js`,
    corePath: `${base}/core`,
    langPath: `${base}/lang`,
    workerBlobURL: false, // a blob: worker would be blocked by the Content Security Policy
    logger: (m) => {
      const label = m.status === 'recognizing text' ? 'Reading text…' : 'Loading text reader (first time only)…'
      onProgress?.(m.progress ?? 0, label)
    },
  }).then(async (w) => {
    await w.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT, // cards are scattered text, not paragraphs
      preserve_interword_spaces: '1',
    })
    return w
  })
  workerPromise.catch(() => (workerPromise = null))
  return workerPromise
}

export function warmUpOcr() {
  getWorker().catch(() => {})
}

/**
 * Prepares a photo for text reading:
 * - scales so the long side is `maxDim`, optionally stretched sideways by `stretch`
 *   (tall, narrow fonts like "DANIEL" on ID badges only read when widened),
 * - rotates by `turns` x 90°,
 * - removes glare and uneven lighting by subtracting a blurred copy (the local background),
 *   which leaves dark text on an even light background (`polarity` -1 for light-on-dark cards).
 */
function preprocess(src: ImageBitmap | HTMLImageElement, turns: number, maxDim: number, stretch: number, polarity: 1 | -1): HTMLCanvasElement {
  const sw = 'naturalWidth' in src ? src.naturalWidth : src.width
  const sh = 'naturalHeight' in src ? src.naturalHeight : src.height
  const scale = Math.min(1, maxDim / Math.max(sw, sh))
  const sideways = turns % 2 === 1
  // Stretch is applied along the text's horizontal axis (after rotation).
  const w = Math.round(sw * scale * (sideways ? 1 : stretch))
  const h = Math.round(sh * scale * (sideways ? stretch : 1))
  const canvas = document.createElement('canvas')
  canvas.width = sideways ? h : w
  canvas.height = sideways ? w : h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((turns * Math.PI) / 2)
  ctx.drawImage(src, -w / 2, -h / 2, w, h)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  // Background estimate: shrink a lot, then scale back up (a cheap, wide blur).
  const small = document.createElement('canvas')
  small.width = Math.max(1, Math.round(canvas.width / 28))
  small.height = Math.max(1, Math.round(canvas.height / 28))
  const sctx = small.getContext('2d')!
  sctx.imageSmoothingQuality = 'high'
  sctx.drawImage(canvas, 0, 0, small.width, small.height)
  const blur = document.createElement('canvas')
  blur.width = canvas.width
  blur.height = canvas.height
  const bctx = blur.getContext('2d', { willReadFrequently: true })!
  bctx.imageSmoothingQuality = 'high'
  bctx.drawImage(small, 0, 0, blur.width, blur.height)

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const bg = bctx.getImageData(0, 0, canvas.width, canvas.height).data
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
    const b = (bg[i] * 299 + bg[i + 1] * 587 + bg[i + 2] * 114) / 1000
    // polarity -1 flips a light-text-on-dark card into dark text on light.
    const v = Math.max(0, Math.min(255, polarity * (g - b) * 3 + 200))
    d[i] = d[i + 1] = d[i + 2] = v
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

interface TesseractLine {
  text: string
  confidence: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}
interface TesseractData {
  confidence: number
  blocks?: { paragraphs: { lines: TesseractLine[] }[] }[] | null
}

export interface ReadLine extends CardLine {
  confidence: number
}

/** Pulls lines out of Tesseract's result, with position and size scaled to 0–1000 of the image height. */
export function linesFromResult(
  data: TesseractData,
  imageHeight: number,
  imageWidth = 0,
): { lines: ReadLine[]; confidence: number; words: number; clarity: number } {
  const raw: TesseractLine[] = []
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) raw.push(l)
  const k = 1000 / Math.max(1, imageHeight)
  const kept = raw.filter((l) => l.confidence >= 50 && l.text.trim())
  // Clarity counts ALL text found, including lines too small or blurry to read well,
  // so tiny unreadable print pulls the score down instead of being silently skipped.
  // Text whose middle sits in the outer 6% of the photo is background around the card, not the card.
  const nearEdge = (l: TesseractLine) => {
    const cx = (l.bbox.x0 + l.bbox.x1) / 2
    const cy = (l.bbox.y0 + l.bbox.y1) / 2
    return imageWidth > 0 && (cx < imageWidth * 0.06 || cx > imageWidth * 0.94 || cy < imageHeight * 0.06 || cy > imageHeight * 0.94)
  }
  let sum = 0
  let n = 0
  for (const l of raw) {
    const len = l.text.replace(/[^A-Za-z0-9@]/g, '').length
    if (len < 3 || nearEdge(l)) continue
    sum += l.confidence * len
    n += len
  }
  return {
    clarity: n ? sum / n : 0,
    lines: kept.map((l) => ({
      text: l.text.replace(/\s+/g, ' ').trim(),
      height: (l.bbox.y1 - l.bbox.y0) * k,
      y: l.bbox.y0 * k,
      confidence: l.confidence,
    })),
    confidence: data.confidence,
    words: kept.reduce((n, l) => n + l.text.trim().split(/\s+/).length, 0),
  }
}

const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Combines lines from several readings of the same card. When two readings saw the same
 * line, keeps the more complete / more confident one. Result is sorted top to bottom.
 */
export function mergeLines(passes: ReadLine[][]): ReadLine[] {
  const out: ReadLine[] = []
  for (const line of passes.flat()) {
    const q = squash(line.text)
    if (q.length < 2) continue
    const same = out.findIndex((o) => {
      const p = squash(o.text)
      if (p === q) return true
      const [short, long] = p.length < q.length ? [p, q] : [q, p]
      return short.length >= 4 && long.includes(short) && Math.abs((o.y ?? 0) - (line.y ?? 0)) < 40
    })
    if (same < 0) out.push(line)
    else {
      const o = out[same]
      const better = squash(line.text).length > squash(o.text).length + 2 ? line : line.confidence > o.confidence + 5 ? line : o
      out[same] = better
    }
  }
  return out.sort((a, b) => (a.y ?? 0) - (b.y ?? 0))
}

async function loadPhoto(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        URL.revokeObjectURL(url)
        resolve(img)
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('Could not open photo'))
      }
      img.src = url
    })
  }
}

export interface CardReading {
  /** Quarter-turns that made the text upright (0 = as photographed). */
  turns: number
  lines: ReadLine[]
  /** How clearly the text was read: confidence 0–100 over all text found (see linesFromResult). */
  clarity: number
  /** Raw text seen, including lines too unclear to use (to notice e.g. an "@" that wasn't read). */
  rawText: string
}

/**
 * Reads the text on a business card photo:
 * 1. finds the right way up (tries rotations if the first reading looks poor),
 * 2. reads it a second time widened, which catches tall narrow fonts,
 * 3. merges both readings.
 */
export async function readCard(
  file: Blob,
  progress?: (p: number, label: string) => void,
  opts: {
    quick?: boolean
    /** Rotations to try, best guess first (quarter-turns clockwise). */
    turnOrder?: number[]
  } = {},
): Promise<CardReading> {
  onProgress = progress ?? null
  const worker = await getWorker()
  const photo = await loadPhoto(file)
  const run = async (turns: number, maxDim: number, stretch: number, polarity: 1 | -1) => {
    const canvas = preprocess(photo, turns, maxDim, stretch, polarity)
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true })
    return { ...linesFromResult(data as unknown as TesseractData, canvas.height, canvas.width), rawText: (data as { text?: string }).text ?? '' }
  }
  try {
    let best: { turns: number; polarity: 1 | -1; result: Awaited<ReturnType<typeof run>> } | null = null
    // Score a reading by how much confidently-read text it found.
    const quality = (r: Awaited<ReturnType<typeof run>>) =>
      r.lines.reduce((sum, l) => sum + l.confidence * l.text.replace(/[^A-Za-z0-9]/g, '').length, 0) / 100
    let bestScore = -1
    // Try each way up, and dark-on-light then light-on-dark, until one reads cleanly.
    // Quick check (used while the camera is live) tries only the likely rotations.
    const order = opts.turnOrder ?? [0, 1, 3, 2]
    search: for (const turns of opts.quick ? order.slice(0, 3) : [...new Set([...order, 0, 1, 3, 2])]) {
      for (const polarity of [1, -1] as const) {
        const result = await run(turns, 1600, 1, polarity)
        const score = quality(result)
        if (score > bestScore) {
          bestScore = score
          best = { turns, polarity, result }
        }
        if (score >= 40) break search // plenty of clean text: this is the right way up
      }
    }
    if (!best) return { turns: 0, lines: [], clarity: 0, rawText: '' }
    if (opts.quick) return { turns: best.turns, lines: best.result.lines, clarity: best.result.clarity, rawText: best.result.rawText }
    const wide = await run(best.turns, 1200, 1.6, best.polarity)
    return {
      turns: best.turns,
      lines: mergeLines([best.result.lines, wide.lines]),
      clarity: best.result.clarity,
      rawText: best.result.rawText + '\n' + wide.rawText,
    }
  } finally {
    if ('close' in photo) photo.close()
    onProgress = null
  }
}
