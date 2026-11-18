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

/** Grayscale + stretch contrast + scale so the long side is ~2000px. Rotates by `turns` × 90°. */
function preprocess(src: ImageBitmap | HTMLImageElement, turns: number): HTMLCanvasElement {
  const sw = 'naturalWidth' in src ? src.naturalWidth : src.width
  const sh = 'naturalHeight' in src ? src.naturalHeight : src.height
  const scale = Math.min(1, 2000 / Math.max(sw, sh))
  const w = Math.round(sw * scale)
  const h = Math.round(sh * scale)
  const sideways = turns % 2 === 1
  const canvas = document.createElement('canvas')
  canvas.width = sideways ? h : w
  canvas.height = sideways ? w : h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((turns * Math.PI) / 2)
  ctx.drawImage(src, -w / 2, -h / 2, w, h)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data
  // Find the 2nd and 98th percentile brightness, then stretch that range to full black→white.
  const hist = new Uint32Array(256)
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
    d[i] = g
    hist[g | 0]++
  }
  const total = d.length / 4
  const cutoff = total * 0.02
  let lo = 0
  let hi = 255
  let below = hist[0]
  while (lo < 254 && below < cutoff) below += hist[++lo]
  let above = hist[255]
  while (hi > lo + 1 && above < cutoff) above += hist[--hi]
  const range = Math.max(1, hi - lo)
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range))
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

/** Pulls lines (with text height) out of Tesseract's result, top to bottom. */
export function linesFromResult(data: TesseractData): { lines: CardLine[]; confidence: number; words: number } {
  const raw: TesseractLine[] = []
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) raw.push(l)
  const kept = raw
    .filter((l) => l.confidence >= 35 && l.text.trim())
    .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
  return {
    lines: kept.map((l) => ({ text: l.text.replace(/\s+/g, ' ').trim(), height: l.bbox.y1 - l.bbox.y0 })),
    confidence: data.confidence,
    words: kept.reduce((n, l) => n + l.text.trim().split(/\s+/).length, 0),
  }
}

async function loadPhoto(file: File): Promise<ImageBitmap | HTMLImageElement> {
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

/**
 * Reads the text on a business card photo. If the result looks poor (the card may be
 * sideways in the photo), it retries rotated and keeps the best reading.
 */
export async function readCard(file: File, progress?: (p: number, label: string) => void): Promise<CardLine[]> {
  onProgress = progress ?? null
  const worker = await getWorker()
  const photo = await loadPhoto(file)
  try {
    let best: ReturnType<typeof linesFromResult> | null = null
    for (const turns of [0, 1, 3, 2]) {
      const { data } = await worker.recognize(preprocess(photo, turns), {}, { blocks: true, text: false })
      const result = linesFromResult(data as unknown as TesseractData)
      if (!best || result.confidence * Math.min(result.words, 15) > best.confidence * Math.min(best.words, 15)) best = result
      if (best.confidence >= 70 && best.words >= 5) break
    }
    return best?.lines ?? []
  } finally {
    if ('close' in photo) photo.close()
    onProgress = null
  }
}
