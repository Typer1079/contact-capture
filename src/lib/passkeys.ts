/**
 * Passkeys (Face ID / Touch ID sign-in) through Supabase Auth.
 * The private key never leaves the phone (it lives in Apple Passwords / iCloud Keychain);
 * Supabase stores only the public key. Requires "Passkeys" to be turned on in the Supabase dashboard.
 */
import { supabase } from './supabase'

const USED_KEY = 'contact-capture.passkey-on-this-device'
const DISMISS_KEY = 'contact-capture.passkey-offer-dismissed'

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window && Boolean(navigator.credentials)
}

/** Remember that this device has a passkey, so sign-in shows the Face ID button first. */
export function markPasskeyOnDevice(on: boolean) {
  try {
    if (on) localStorage.setItem(USED_KEY, '1')
    else localStorage.removeItem(USED_KEY)
  } catch {
    /* storage unavailable */
  }
}
export function passkeyOnDevice(): boolean {
  try {
    return localStorage.getItem(USED_KEY) === '1'
  } catch {
    return false
  }
}

export function offerDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}
export function dismissOffer() {
  try {
    localStorage.setItem(DISMISS_KEY, '1')
  } catch {
    /* storage unavailable */
  }
}

type AnyError = { code?: string; name?: string; message?: string; cause?: unknown } | null | undefined

/** True when the person just closed the Face ID sheet: not worth an error message. */
export function wasCancelled(err: AnyError): boolean {
  if (!err) return false
  const name = (err.cause as { name?: string } | undefined)?.name ?? err.name
  return err.code === 'ERROR_CEREMONY_ABORTED' || name === 'NotAllowedError' || name === 'AbortError'
}

/** A plain-language message for a passkey error. */
export function passkeyMessage(err: AnyError, during: 'signin' | 'setup'): string {
  const code = err?.code ?? ''
  switch (code) {
    case 'passkey_disabled':
      return 'Face ID sign-in isn’t turned on for this app yet (Supabase → Authentication → Passkeys).'
    case 'webauthn_credential_not_found':
      return 'That passkey isn’t linked to an account here anymore. Sign in with your password, then set up Face ID again.'
    case 'webauthn_credential_exists':
    case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
      return 'This device already has Face ID sign-in set up for your account.'
    case 'too_many_passkeys':
      return 'Your account has the maximum number of passkeys. Remove one first.'
    case 'webauthn_challenge_expired':
      return 'That took a little too long. Please try again.'
    case 'ERROR_INVALID_DOMAIN':
    case 'ERROR_INVALID_RP_ID':
      return 'Passkey settings in Supabase don’t match this site’s address (check the Relying Party ID and Origins).'
    case 'email_not_confirmed':
      return 'Confirm your email first, then try again.'
  }
  return during === 'signin'
    ? 'Face ID sign-in didn’t work. You can sign in with your password instead.'
    : `Couldn’t set up Face ID sign-in${err?.message ? `: ${err.message}` : '.'}`
}

export async function signInWithPasskey() {
  const { data, error } = await supabase.auth.signInWithPasskey()
  if (!error) markPasskeyOnDevice(true)
  return { data, error }
}

export async function registerPasskey() {
  const { data, error } = await supabase.auth.registerPasskey()
  if (!error) {
    markPasskeyOnDevice(true)
    // Name it after the device so the list is readable.
    const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Mac/.test(navigator.userAgent) ? 'Mac' : ''
    if (name && data && !data.friendly_name) await supabase.auth.passkey.update({ passkeyId: data.id, friendlyName: name })
  }
  return { data, error }
}
