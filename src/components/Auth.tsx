import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { passkeyMessage, passkeyOnDevice, passkeysSupported, signInWithPasskey, wasCancelled } from '../lib/passkeys'

type Mode = 'signin' | 'signup' | 'reset'

export default function Auth() {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)

  const canPasskey = passkeysSupported()

  async function passkeySignIn() {
    setBusy(true)
    setMessage(null)
    const { error } = await signInWithPasskey()
    setBusy(false)
    // Success: the app switches to the home screen by itself (auth state change).
    if (error && !wasCancelled(error)) setMessage({ kind: 'error', text: passkeyMessage(error, 'signin') })
  }

  const redirectTo = window.location.origin + import.meta.env.BASE_URL

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        // Same message for every failure so the form doesn't reveal which emails have accounts.
        if (error) throw new Error('Email or password is incorrect, or the email isn’t confirmed yet.')
      } else if (mode === 'signup') {
        if (password.length < 12) throw new Error('Use a password of at least 12 characters.')
        const { error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } })
        if (error) throw error
        setMessage({ kind: 'info', text: 'Check your email for a confirmation link, then sign in.' })
        setMode('signin')
      } else {
        await supabase.auth.resetPasswordForEmail(email, { redirectTo })
        setMessage({ kind: 'info', text: 'If that email has an account, a reset link is on its way.' })
      }
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Something went wrong.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-bold">Contact Capture</h1>
      <p className="mt-1 text-sm text-slate-500">
        {mode === 'signin' ? 'Sign in to your saved contacts.' : mode === 'signup' ? 'Create your account.' : 'Reset your password.'}
      </p>

      {mode === 'signin' && canPasskey && (
        <>
          <button type="button" className={`${passkeyOnDevice() ? 'btn-primary' : 'btn-secondary'} mt-6 w-full`} disabled={busy} onClick={passkeySignIn}>
            Sign in with Face ID
          </button>
          <div className="mt-6 flex items-center gap-3 text-xs text-slate-400">
            <span className="h-px flex-1 bg-slate-200" />
            or use your password
            <span className="h-px flex-1 bg-slate-200" />
          </div>
        </>
      )}

      <form onSubmit={submit} method="post" action="#" className="mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="email">Email</label>
          {/* name + autocomplete="username" is what Apple Passwords (and other password managers) look for. */}
          <input
            id="email"
            name="email"
            className="input"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        {mode !== 'reset' && (
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              className="input"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              minLength={mode === 'signup' ? 12 : undefined}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        )}
        {message && (
          <p role="alert" className={`rounded-lg px-3 py-2 text-sm ${message.kind === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>
            {message.text}
          </p>
        )}
        <button className={`${mode === 'signin' && canPasskey && passkeyOnDevice() ? 'btn-secondary' : 'btn-primary'} w-full`} disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
        </button>
      </form>

      <div className="mt-6 flex justify-between text-sm">
        {mode === 'signin' ? (
          <>
            <button className="text-slate-600 underline" onClick={() => setMode('signup')}>Create account</button>
            <button className="text-slate-600 underline" onClick={() => setMode('reset')}>Forgot password?</button>
          </>
        ) : (
          <button className="text-slate-600 underline" onClick={() => setMode('signin')}>Back to sign in</button>
        )}
      </div>
    </div>
  )
}
