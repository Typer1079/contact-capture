import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  dismissOffer,
  markPasskeyOnDevice,
  offerDismissed,
  passkeyMessage,
  passkeysSupported,
  registerPasskey,
  wasCancelled,
} from '../lib/passkeys'

type PasskeyItem = { id: string; friendly_name?: string; created_at: string; last_used_at?: string }

async function listPasskeys(): Promise<PasskeyItem[] | null> {
  const { data, error } = await supabase.auth.passkey.list()
  return error ? null : ((data as PasskeyItem[] | null) ?? [])
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '')

/** Home-screen offer: "Sign in with Face ID next time?" Shown until set up or dismissed. */
export function PasskeyOffer({ onManage }: { onManage: () => void }) {
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)

  useEffect(() => {
    if (!passkeysSupported() || offerDismissed()) return
    let live = true
    // Hidden when passkeys are off in Supabase (list fails) or the account already has one.
    void listPasskeys().then((list) => live && setShow(list !== null && list.length === 0))
    return () => {
      live = false
    }
  }, [])

  if (!show) return null

  async function setUp() {
    setBusy(true)
    setMessage(null)
    const { error } = await registerPasskey()
    setBusy(false)
    if (!error) {
      setMessage({ kind: 'info', text: 'Done. Next time, tap “Sign in with Face ID”.' })
      window.setTimeout(() => setShow(false), 2500)
    } else if (!wasCancelled(error)) setMessage({ kind: 'error', text: passkeyMessage(error, 'setup') })
  }

  return (
    <div className="card space-y-2 border-sky-200 bg-sky-50">
      <p className="font-semibold text-slate-900">Sign in with Face ID next time?</p>
      <p className="text-sm text-slate-600">Sets up a passkey for this app in Apple Passwords. No password to type, and it works in the Home Screen app.</p>
      {message && <p className={`text-sm ${message.kind === 'error' ? 'text-red-700' : 'text-emerald-700'}`}>{message.text}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-secondary flex-1"
          onClick={() => {
            dismissOffer()
            setShow(false)
          }}
        >
          Not now
        </button>
        <button type="button" className="btn-primary flex-1" disabled={busy} onClick={setUp}>
          {busy ? 'Waiting for Face ID…' : 'Set up Face ID'}
        </button>
      </div>
      <button type="button" className="text-xs text-slate-500 underline" onClick={onManage}>
        Manage sign-in options
      </button>
    </div>
  )
}

/** Settings screen: list, add and remove passkeys. */
export function PasskeySettings() {
  const [items, setItems] = useState<PasskeyItem[] | null | 'loading'>('loading')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)

  const refresh = () => void listPasskeys().then(setItems)
  useEffect(refresh, [])

  async function add() {
    setBusy(true)
    setMessage(null)
    const { error } = await registerPasskey()
    setBusy(false)
    if (!error) setMessage({ kind: 'info', text: 'Face ID sign-in is set up on this device.' })
    else if (!wasCancelled(error)) setMessage({ kind: 'error', text: passkeyMessage(error, 'setup') })
    refresh()
  }

  async function remove(p: PasskeyItem) {
    if (!window.confirm(`Remove “${p.friendly_name || 'this passkey'}”? You can still sign in with your password.`)) return
    const { error } = await supabase.auth.passkey.delete({ passkeyId: p.id })
    if (error) setMessage({ kind: 'error', text: `Couldn’t remove it: ${error.message}` })
    else {
      setMessage({ kind: 'info', text: 'Removed. You can also delete it from the Passwords app on your phone.' })
      markPasskeyOnDevice(false)
    }
    refresh()
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-2">
        <h2 className="font-semibold">Face ID sign-in (passkeys)</h2>
        <p className="text-sm text-slate-600">
          A passkey lets you sign in with Face ID instead of typing your password. It’s saved in Apple Passwords and synced with iCloud Keychain, so your other Apple devices can use it too.
          Your password still works as a backup.
        </p>
        {!passkeysSupported() && <p className="text-sm text-amber-700">This browser doesn’t support passkeys.</p>}
      </div>

      {message && (
        <p role="alert" className={`rounded-lg px-3 py-2 text-sm ${message.kind === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>
          {message.text}
        </p>
      )}

      <div className="card space-y-3">
        <h3 className="text-sm font-semibold text-slate-700">Your passkeys</h3>
        {items === 'loading' && <p className="text-sm text-slate-500">Loading…</p>}
        {items === null && <p className="text-sm text-amber-700">Passkeys aren’t turned on for this app yet (Supabase → Authentication → Passkeys).</p>}
        {Array.isArray(items) && items.length === 0 && <p className="text-sm text-slate-500">None yet.</p>}
        {Array.isArray(items) &&
          items.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3 first:border-0 first:pt-0">
              <div className="min-w-0">
                <p className="truncate font-medium">{p.friendly_name || 'Passkey'}</p>
                <p className="text-xs text-slate-500">
                  Added {when(p.created_at)}
                  {p.last_used_at ? ` · last used ${when(p.last_used_at)}` : ''}
                </p>
              </div>
              <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => remove(p)}>
                Remove
              </button>
            </div>
          ))}
        {passkeysSupported() && items !== null && (
          <button type="button" className="btn-primary w-full" disabled={busy} onClick={add}>
            {busy ? 'Waiting for Face ID…' : '+ Set up Face ID on this device'}
          </button>
        )}
      </div>
    </div>
  )
}
