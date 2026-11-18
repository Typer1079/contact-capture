import { prepareZXingModule, readBarcodes, type ReaderOptions } from 'zxing-wasm/reader'
// Self-host the WebAssembly file instead of loading it from a CDN (keeps the CSP tight
// and means no third party sees when a scan happens).
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

let ready: Promise<unknown> | null = null

export function initBarcodeReader() {
  ready ??= prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
    },
    fireImmediately: true,
  })
  return ready
}

/**
 * Dense license barcodes stop decoding once they're tilted about 3° in the image, and
 * hand-held photos almost always are. So each image is retried straightened at these
 * angles (tested: recovers tilts up to ±15°).
 */
export const DESKEW_ANGLES = [0, -3, 3, -6, 6, -9, 9, -12, 12, -15, 15]

const PDF417_OPTS: ReaderOptions = {
  formats: ['PDF417'],
  tryHarder: true,
  textMode: 'Plain', // keep real line breaks; the default "HRI" mode turns them into <LF>
  maxNumberOfSymbols: 1,
}

export interface ScanResult {
  /** Raw PDF417 text, or null. Contains the full license data: never store or send it. */
  text: string | null
  /** True when only the small 1D barcode was found (it holds no name/address). */
  sawSmallBarcode: boolean
}

type Region = { x: number; y: number; w: number; h: number }

const work = document.createElement('canvas')

/** Draws `source` (optionally cropped and scaled to `maxDim`) rotated by `angle` degrees. */
function prepare(source: CanvasImageSource, region: Region, angle: number, maxDim: number): ImageData {
  const scale = Math.min(1, maxDim / Math.max(region.w, region.h))
  const w = Math.round(region.w * scale)
  const h = Math.round(region.h * scale)
  const rad = (angle * Math.PI) / 180
  const cw = Math.round(Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad)))
  const ch = Math.round(Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)))
  work.width = cw
  work.height = ch
  const ctx = work.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, cw, ch)
  ctx.translate(cw / 2, ch / 2)
  ctx.rotate(rad)
  ctx.drawImage(source, region.x, region.y, region.w, region.h, -w / 2, -h / 2, w, h)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  return ctx.getImageData(0, 0, cw, ch)
}

/**
 * Tries to read the license barcode from an image, straightening it at each angle given.
 * The first pass also looks for the small 1D barcode so we can tell the user they scanned
 * the wrong one. Its contents are ignored.
 */
export async function scanImage(
  source: CanvasImageSource,
  region: Region,
  angles: number[] = DESKEW_ANGLES,
  maxDim = 2400,
): Promise<ScanResult> {
  await initBarcodeReader()
  let sawSmallBarcode = false
  for (const angle of angles) {
    const img = prepare(source, region, angle, maxDim)
    const first = angle === angles[0]
    const results = await readBarcodes(img, first ? { ...PDF417_OPTS, formats: ['PDF417', 'Code39', 'Code128'], maxNumberOfSymbols: 3 } : PDF417_OPTS)
    const hit = results.find((r) => r.isValid && r.format === 'PDF417' && r.text)
    if (hit) return { text: hit.text, sawSmallBarcode: false }
    if (first && results.some((r) => r.isValid && r.format !== 'PDF417')) sawSmallBarcode = true
  }
  return { text: null, sawSmallBarcode }
}

/** Loads a photo (respecting the phone's orientation) and scans it. */
export async function scanPhoto(file: File): Promise<ScanResult> {
  let bitmap: ImageBitmap | HTMLImageElement
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
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
  try {
    const w = 'naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width
    const h = 'naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height
    const full = { x: 0, y: 0, w, h }
    let result = await scanImage(bitmap, full, DESKEW_ANGLES, 2400)
    // A barcode that fills only part of a 12 MP photo can lose detail when scaled down; retry larger.
    if (!result.text) {
      const larger = await scanImage(bitmap, full, DESKEW_ANGLES, 3600)
      result = { text: larger.text, sawSmallBarcode: result.sawSmallBarcode || larger.sawSmallBarcode }
    }
    return result
  } finally {
    if ('close' in bitmap) bitmap.close()
  }
}
