import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
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

/** Reads a PDF417 barcode on-device. Returns the raw text, or null if none was found. */
export async function readPdf417(input: ImageData | Blob): Promise<string | null> {
  await initBarcodeReader()
  const results = await readBarcodes(input, {
    formats: ['PDF417'],
    tryHarder: true,
    tryRotate: true,
    textMode: 'Plain', // keep real line breaks; the default "HRI" mode turns them into <LF>
    maxNumberOfSymbols: 1,
  })
  const hit = results.find((r) => r.isValid && r.text)
  return hit ? hit.text : null
}
