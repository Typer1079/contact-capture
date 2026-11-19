import { editDistance } from './verify'
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
type Box = { x0: number; y0: number; x1: number; y1: number }

/**
 * Turns the photo upright, removes glare and shadows, and boosts the text.
 * With `crop` (fractions of the upright image), only that part is produced: much faster.
 */
function preprocess(src: ImageBitmap | HTMLImageElement, turns: number, maxDim: number, stretch: number, polarity: 1 | -1, crop?: Box): HTMLCanvasElement {
  const sw = 'naturalWidth' in src ? src.naturalWidth : src.width
  const sh = 'naturalHeight' in src ? src.naturalHeight : src.height
  const scale = Math.min(1, maxDim / Math.max(sw, sh))
  const sideways = turns % 2 === 1
  // Stretch is applied along the text's horizontal axis (after rotation).
  const w = Math.round(sw * scale * (sideways ? 1 : stretch))
  const h = Math.round(sh * scale * (sideways ? stretch : 1))
  const fullW = sideways ? h : w
  const fullH = sideways ? w : h
  const left = crop ? Math.max(0, Math.floor(crop.x0 * fullW)) : 0
  const top = crop ? Math.max(0, Math.floor(crop.y0 * fullH)) : 0
  const canvas = document.createElement('canvas')
  canvas.width = crop ? Math.max(1, Math.min(fullW, Math.ceil(crop.x1 * fullW)) - left) : fullW
  canvas.height = crop ? Math.max(1, Math.min(fullH, Math.ceil(crop.y1 * fullH)) - top) : fullH
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.translate(fullW / 2 - left, fullH / 2 - top)
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
  words?: { text: string; confidence: number }[]
  bbox: { x0: number; y0: number; x1: number; y1: number }
}
interface TesseractData {
  confidence: number
  blocks?: { paragraphs: { lines: TesseractLine[] }[] }[] | null
}

export interface ReadLine extends CardLine {
  confidence: number
  /** Each word with its own confidence, so two readings of a line can be compared word by word. */
  words?: { text: string; confidence: number }[]
  /** Where the line sits, as fractions (0–1) of the image width/height. */
  box?: Box
  /** Read from the negative (light text on a dark band); used when re-reading this line. */
  polarity?: 1 | -1
  /** The other pass read this line differently; kept so the dispute can be settled. */
  alt?: ReadLine
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
      box: imageWidth > 0 ? { x0: l.bbox.x0 / imageWidth, y0: l.bbox.y0 / imageHeight, x1: l.bbox.x1 / imageWidth, y1: l.bbox.y1 / imageHeight } : undefined,
      words: (l.words ?? []).filter((w) => w.text.trim()).map((w) => ({ text: w.text.trim(), confidence: w.confidence })),
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
/**
 * Adds the negative read's lines place by place: where the normal reads found nothing, its line
 * is added; where they found something in the same spot, the more confident reading wins.
 */
/** Characters in tokens that look like real card text: words, numbers, phone parts, emails. */
export function sensibleChars(text: string): number {
  let n = 0
  for (const raw of text.split(/\s+/)) {
    const t = raw.replace(/[,.;:)]+$/, '').replace(/^[(]/, '')
    if (
      /^[A-Z]?[a-z]{2,}(-[A-Z]?[a-z]+)*$/.test(t) || // Houston, Greenhouse, vice, Andrews-Harper
      /^[A-Z]{2,}$/.test(t) && t.length <= 5 || // TX, CEO (short caps only)
      /^\d{3,5}(-\d{4})?$/.test(t) || // 4949, 77084, 77084-1234
      /^\d{3}[/.\-]\d{3}[.\-]\d{4}$/.test(t) || // 281/856-7688
      /^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)
    )
      n += t.length
  }
  return n
}

/** Two readings of the same text: most of the shorter one's characters line up with the longer. */
function similar(a: string, b: string): boolean {
  const p = squash(a)
  const q = squash(b)
  const [short, long] = p.length < q.length ? [p, q] : [q, p]
  // A small fragment inside a longer line ("5-5125" in a whole phone line) isn't the same text.
  if (short.length < 4 || short.length < long.length * 0.4) return false
  if (long.includes(short)) return true
  // Best-matching stretch of the longer text, compared with the shorter one.
  let best = 99
  for (let i = 0; i + short.length <= long.length; i += 1) best = Math.min(best, editDistance(short, long.slice(i, i + short.length)))
  return best <= short.length * 0.25
}

/** Real-looking characters in `text` whose tokens appear in none of `lines`. */
function newChars(text: string, lines: ReadLine[]): number {
  const known = new Set(lines.flatMap((l) => l.text.toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z0-9@./-]/g, ''))))
  return text
    .split(/\s+/)
    .filter((t) => !known.has(t.toLowerCase().replace(/[^a-z0-9@./-]/g, '')))
    .reduce((n, t) => n + sensibleChars(t), 0)
}

export function mergeByPlace(lines: ReadLine[], extra: ReadLine[]) {
  // Same spot: the line's middle sits within the other's height, and they overlap sideways.
  const overlaps = (a: Box, b: Box) => {
    const mid = (a.y0 + a.y1) / 2
    return mid > b.y0 && mid < b.y1 && Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0)
  }
  for (const e of extra) {
    if (!e.box || squash(e.text).length < 2) continue
    const here = lines.filter((l) => l.box && overlaps(l.box, e.box!))
    if (!here.length) {
      // Only fairly confident text where nothing was found (not specks of the background).
      if (e.confidence >= 70 && sensibleChars(e.text) >= 4) lines.push(e)
      continue
    }
    // Just another reading of text already found ("Senior Investigaio", "946-8536"): skip.
    if (here.some((l) => similar(l.text, e.text))) continue
    // Confidence alone can't tell junk from text ("83" can score 96%). Take the negative's
    // line when it adds real-looking text (words, numbers, phones, emails) that no other line
    // has, and holds about as much of it as what's in this spot now.
    const mine = sensibleChars(e.text)
    const theirs = here.reduce((n, l) => n + sensibleChars(l.text), 0)
    if (e.confidence >= 50 && newChars(e.text, lines) >= 8 && mine >= theirs * 0.8) {
      // Drop the junk it replaces; keep anything meaningful that happens to overlap.
      for (const l of here) if (sensibleChars(l.text) < 10) lines.splice(lines.indexOf(l), 1)
      lines.push(e)
    }
  }
  lines.sort((a, b) => (a.y ?? 0) - (b.y ?? 0))
}

export function mergeLines(passes: ReadLine[][]): ReadLine[] {
  const out: ReadLine[] = []
  for (const line of passes.flat()) {
    const q = squash(line.text)
    if (q.length < 2) continue
    const same = out.findIndex((o) => {
      const p = squash(o.text)
      if (p === q) return true
      const [short, long] = p.length < q.length ? [p, q] : [q, p]
      const near = Math.abs((o.y ?? 0) - (line.y ?? 0)) < 40
      if (short.length >= 4 && long.includes(short) && near) return true
      // Same line read slightly differently by the two passes ("223 E." vs "923 E.").
      return near && short.length >= 6 && editDistance(p, q) <= Math.max(1, Math.floor(long.length * 0.1))
    })
    if (same < 0) out.push(line)
    else {
      const o = out[same]
      const a = squash(line.text)
      const b = squash(o.text)
      // A fragment never replaces the whole line it's part of ("Debbi" vs "Debbie Andrews-Harper").
      const better = a.length > b.length + 2 || (a.length > b.length && a.includes(b)) ? line : b.length > a.length + 2 || b.includes(a) ? o : line.confidence > o.confidence ? line : o
      const other = better === line ? o : line
      // Same length but different characters: a real disagreement worth a closer look.
      out[same] = squash(other.text) !== squash(better.text) && Math.abs(squash(other.text).length - squash(better.text).length) <= 2
        ? { ...better, box: better.box ?? other.box, alt: other }
        : better
    }
  }
  return out.sort((a, b) => (a.y ?? 0) - (b.y ?? 0))
}

/**
 * When the two passes read a line differently ("223 E." vs "923 E.", "4840" vs "4340"), read just
 * that line once more from a full-resolution crop and keep the version the third read agrees with.
 */
const VALID_PHONE = /\(?\b\d{3}\)?[\s.\-–/]*\d{3}[\s.\-–]*\d{4}\b/g
const phoneCount = (t: string) => (t.match(VALID_PHONE) ?? []).length
/** Something shaped like a phone number that isn't a valid one ("832/14 5-5125"). */
const brokenPhone = (t: string) => /\b\d{3}\s*[/.\-)]\s*[\d\s]{2,5}[\s.\-–]\s*\d{3,4}\b/.test(t.replace(VALID_PHONE, ' '))

/** Crop around one line, at full resolution, and read just that line. */
async function rereadLine(worker: Worker, photo: ImageBitmap | HTMLImageElement, turns: number, polarity: 1 | -1, b: Box, stretch: number) {
  const padY = (b.y1 - b.y0) * 0.35
  const padX = (b.y1 - b.y0) * 0.8
  const band = (b.y1 - b.y0) * 2.5
  const crop = { x0: Math.max(0, b.x0 - padX - band), y0: Math.max(0, b.y0 - band), x1: Math.min(1, b.x1 + padX + band), y1: Math.min(1, b.y1 + band) }
  const canvas = preprocess(photo, turns, 2600, stretch, polarity, crop)
  const cw = crop.x1 - crop.x0
  const ch = crop.y1 - crop.y0
  const left = Math.max(0, Math.floor(((b.x0 - padX - crop.x0) / cw) * canvas.width))
  const top = Math.max(0, Math.floor(((b.y0 - padY - crop.y0) / ch) * canvas.height))
  const width = Math.min(canvas.width - left, Math.ceil(((b.x1 - b.x0 + 2 * padX) / cw) * canvas.width))
  const height = Math.min(canvas.height - top, Math.ceil(((b.y1 - b.y0 + 2 * padY) / ch) * canvas.height))
  if (width < 8 || height < 8) return ''
  const { data } = await worker.recognize(canvas, { rectangle: { left, top, width, height } })
  return ((data as { text?: string }).text ?? '').trim()
}

/** Lines with a misread phone number ("Cell: 832/14 5-5125"): read again up close, keep the better one. */
async function repairPhones(worker: Worker, photo: ImageBitmap | HTMLImageElement, turns: number, polarity: 1 | -1, lines: ReadLine[]) {
  const broken = lines.filter((l) => l.box && brokenPhone(l.text)).slice(0, 4)
  for (const l of broken) {
    for (const stretch of [1.3, 1]) {
      // The crop may hold a neighboring line too: keep the line with the most valid numbers.
      const text = await rereadLine(worker, photo, turns, l.polarity ?? polarity, l.box!, stretch)
      const bestLine = text.split('\n').map((t) => t.trim().replace(/\s+/g, ' ')).sort((a, b) => phoneCount(b) - phoneCount(a))[0] ?? ''
      if (phoneCount(bestLine) > phoneCount(l.text)) l.text = bestLine
      if (!brokenPhone(l.text)) break
    }
  }
}

async function settleDisputes(worker: Worker, photo: ImageBitmap | HTMLImageElement, turns: number, polarity: 1 | -1, lines: ReadLine[]) {
  const disputed = lines.filter((l) => l.alt && l.box).slice(0, 8)
  if (!disputed.length) return
  // Two extra looks at each disputed line: as-is and slightly widened (each fixes different slips).
  const votes = new Map<ReadLine, [number, number]>(disputed.map((l) => [l, [0, 0]]))
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE })
  try {
    for (const stretch of [1, 1.3]) {
      for (const l of disputed) {
        const b = l.box!
        const padY = (b.y1 - b.y0) * 0.35
        const padX = (b.y1 - b.y0) * 0.8
        // A band around the line, tall enough for the glare removal to see the card around the text.
        const band = (b.y1 - b.y0) * 2.5
        const crop = { x0: Math.max(0, b.x0 - padX - band), y0: Math.max(0, b.y0 - band), x1: Math.min(1, b.x1 + padX + band), y1: Math.min(1, b.y1 + band) }
        const canvas = preprocess(photo, turns, 2600, stretch, l.polarity ?? polarity, crop)
        const cw = crop.x1 - crop.x0
        const ch = crop.y1 - crop.y0
        const left = Math.max(0, Math.floor(((b.x0 - padX - crop.x0) / cw) * canvas.width))
        const top = Math.max(0, Math.floor(((b.y0 - padY - crop.y0) / ch) * canvas.height))
        const width = Math.min(canvas.width - left, Math.ceil(((b.x1 - b.x0 + 2 * padX) / cw) * canvas.width))
        const height = Math.min(canvas.height - top, Math.ceil(((b.y1 - b.y0 + 2 * padY) / ch) * canvas.height))
        if (width < 8 || height < 8) continue
        const { data } = await worker.recognize(canvas, { rectangle: { left, top, width, height } })
        const third = squash((data as { text?: string }).text ?? '')
        const v = votes.get(l)!
        v[0] += editDistance(squash(l.text), third)
        v[1] += editDistance(squash(l.alt!.text), third)
      }
    }
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT })
  }
  for (const l of disputed) {
    const alt = l.alt!
    const [dMain, dAlt] = votes.get(l)!
    const useAlt = dAlt < dMain || (dAlt === dMain && differingConfidence(alt, l) > differingConfidence(l, alt))
    if (useAlt) Object.assign(l, { ...alt, box: l.box, y: l.y, height: l.height })
  }
  for (const l of lines) delete l.alt
}

/** Average confidence of the words in `a` that `b` read differently. */
function differingConfidence(a: ReadLine, b: ReadLine): number {
  const other = new Set((b.words ?? []).map((w) => w.text))
  const diff = (a.words ?? []).filter((w) => !other.has(w.text))
  return diff.length ? diff.reduce((n, w) => n + w.confidence, 0) / diff.length : a.confidence
}

/**
 * True when a sizable part of the picture (but not all of it) is dark: a colored band that
 * probably holds light text. Checked on a tiny copy, so it costs almost nothing.
 */
function hasDarkBand(photo: ImageBitmap | HTMLImageElement): boolean {
  const c = document.createElement('canvas')
  c.width = 48
  c.height = 48
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(photo, 0, 0, 48, 48)
  const d = ctx.getImageData(10, 10, 28, 28).data // middle of the picture (mostly the card)
  let dark = 0
  for (let i = 0; i < d.length; i += 4) if ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < DARK_BACKGROUND) dark++
  const share = dark / (d.length / 4)
  return share > 0.2 && share < 0.85
}

/** Background brightness (0–255) below which an area counts as dark. */
const DARK_BACKGROUND = 110

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
        // Only try the light-text-on-dark version when this way found almost nothing.
        if (score >= 12) break
      }
    }
    if (!best) return { turns: 0, lines: [], clarity: 0, rawText: '' }
    if (opts.quick) return { turns: best.turns, lines: best.result.lines, clarity: best.result.clarity, rawText: best.result.rawText }
    const wide = await run(best.turns, 1200, 1.6, best.polarity)
    const passes = [best.result.lines, wide.lines]
    // Cards with both dark-on-light and light-on-dark parts (a white name panel and a blue
    // contact band): also read the negative, which turns the band's light text dark.
    if (hasDarkBand(photo)) {
      const flip = best.polarity === 1 ? -1 : 1
      const neg = await run(best.turns, 1600, 1, flip)
      passes.push(neg.lines.map((l) => ({ ...l, polarity: flip })))
    }
    const lines = mergeLines(passes.slice(0, 2))
    if (passes[2]) mergeByPlace(lines, passes[2])
    await settleDisputes(worker, photo, best.turns, best.polarity, lines)
    await repairPhones(worker, photo, best.turns, best.polarity, lines)
    return {
      turns: best.turns,
      lines,
      clarity: best.result.clarity,
      rawText: best.result.rawText + '\n' + wide.rawText,
    }
  } finally {
    if ('close' in photo) photo.close()
    onProgress = null
  }
}
