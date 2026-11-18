export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * On phones, opens the share sheet so the user can tap "Contacts" and add the card.
 * Falls back to a regular download (which iOS/Android also offer to import).
 */
export async function shareOrDownload(content: string, filename: string, mime: string) {
  const file = new File([content], filename, { type: mime })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] })
      return
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return // user closed the sheet
    }
  }
  downloadBlob(file, filename)
}
