/**
 * After an update is published, a phone can still be running the previous version of the app
 * while the files it would load next (the scanner screens) have been replaced. Loading one then
 * fails and the screen would go blank. When that happens, reload once to pick up the new version.
 */
const KEY = 'contact-capture.reloaded-for-update'
const RESUME = 'contact-capture.resume-screen'

/** Reload to the newest version, at most once a minute (so a real outage can't loop). */
export function reloadForUpdate(resume?: string): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0)
    if (Date.now() - last < 60_000) return false
    sessionStorage.setItem(KEY, String(Date.now()))
    if (resume) sessionStorage.setItem(RESUME, resume)
  } catch {
    // Private mode without storage: still reload once.
  }
  window.location.reload()
  return true
}

/** The screen to reopen after an update reload (read once). */
export function takeResumeScreen(): string | null {
  try {
    const v = sessionStorage.getItem(RESUME)
    sessionStorage.removeItem(RESUME)
    return v
  } catch {
    return null
  }
}

/** True for "couldn't fetch this part of the app" errors from any browser. */
export function isLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  return /dynamically imported module|Importing a module script failed|Failed to fetch|ChunkLoadError|Loading chunk|error loading dynamically|module script/i.test(msg)
}

/** import() that retries once, then reloads the app if the file is gone (new version published). */
export function loadFresh<T>(load: () => Promise<T>, resume?: string): () => Promise<T> {
  return () =>
    load().catch(
      (err) =>
        new Promise<T>((resolve, reject) => {
          // A brief network blip: try once more before deciding the version changed.
          window.setTimeout(() => {
            load().then(resolve, (err2) => {
              if (isLoadError(err2) && reloadForUpdate(resume)) return // the page is reloading
              reject(err2 ?? err)
            })
          }, 400)
        }),
    )
}
