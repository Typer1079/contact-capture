import type { Session } from '@supabase/supabase-js'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import Auth from './components/Auth'
import ContactForm from './components/ContactForm'
import ContactList from './components/ContactList'
import type { LicenseContact } from './lib/aamva'
import { splitSuite, type CardContact } from './lib/cardParser'
import type { IdConsent } from './components/CardScanner'
import { deleteContacts, listContacts, listFieldDefs, saveContact } from './lib/contactsApi'
import { shareOrDownload } from './lib/download'
import { isConfigured, supabase } from './lib/supabase'
import { emptyAddress, emptyDraft, isBlankAddress, type Contact, type ContactDraft, type CustomFieldDef } from './lib/types'
import { toVCard, vcardFileName } from './lib/vcard'

// The scanners load separately from the main app. The card scanner's screen is fetched in the
// background shortly after sign-in so the camera opens instantly when tapped; the large text
// reader itself still only downloads once the camera is showing.
const loadCardScanner = () => import('./components/CardScanner')
const LicenseScanner = lazy(() => import('./components/LicenseScanner'))
const CardScanner = lazy(loadCardScanner)

type View =
  | { name: 'home' }
  | { name: 'list' }
  | { name: 'scan' }
  | { name: 'card' }
  | { name: 'form'; draft: ContactDraft; editing?: Contact; autoFilled?: string[]; uncertain?: string[] }

const ADDRESS_KEYS = ['street', 'suite', 'city', 'region', 'postal_code', 'country']

/** Scanner field names -> form keys (address parts live inside the address block). */
function formKeys(fields: string[], draft: ContactDraft): string[] {
  const addrId = draft.addresses[0]?.id
  return fields.map((f) => (ADDRESS_KEYS.includes(f) && addrId ? `addr:${addrId}:${f}` : f))
}

/** Scanned fields -> a draft with one labeled address; returns which fields to highlight. */
function draftFromScan(
  source: ContactDraft['source'],
  fields: Partial<ContactDraft> & { street?: string; suite?: string; city?: string; region?: string; postal_code?: string; country?: string },
  addressLabel: string,
): { draft: ContactDraft; autoFilled: string[] } {
  const { street: rawStreet = '', suite: rawSuite = '', city = '', region = '', postal_code = '', country = '', ...rest } = fields
  // "100 Example St Apt 4" -> street + suite
  const [street, suite] = rawSuite ? [rawStreet, rawSuite] : splitSuite(rawStreet)
  const address = { ...emptyAddress(addressLabel), street, suite, city, region, postal_code, country }
  const draft: ContactDraft = { ...emptyDraft(source), ...rest, addresses: isBlankAddress(address) ? [] : [address] }
  const autoFilled = Object.entries(rest)
    .filter(([k, v]) => k !== 'notes' && typeof v === 'string' && v)
    .map(([k]) => k)
  if (!isBlankAddress(address)) autoFilled.push(`addr:${address.id}`)
  return { draft, autoFilled }
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [view, setView] = useState<View>({ name: 'home' })
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<{ text: string; contact?: Contact } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [defs, setDefs] = useState<CustomFieldDef[]>([])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (!s) {
        // never leave one user's data on screen after sign-out
        setContacts([])
        setDefs([])
      }
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const [cs, ds] = await Promise.all([listContacts(), listFieldDefs()])
      setContacts(cs)
      setDefs(ds)
    } catch {
      setLoadError('Couldn’t load contacts. Check your connection.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (session) refresh()
  }, [session, refresh])

  useEffect(() => {
    if (!session) return
    const t = window.setTimeout(() => void loadCardScanner().catch(() => {}), 1200)
    return () => window.clearTimeout(t)
  }, [session])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 6000)
    return () => window.clearTimeout(t)
  }, [toast])

  async function handleSave(draft: ContactDraft, editing?: Contact) {
    const saved = await saveContact(draft, editing?.id)
    setContacts((cs) => (editing ? cs.map((c) => (c.id === saved.id ? saved : c)) : [saved, ...cs]))
    setToast({ text: editing ? 'Changes saved.' : 'Contact saved.', contact: saved })
    setView({ name: 'list' })
  }

  async function handleDelete(ids: string[]) {
    await deleteContacts(ids)
    setContacts((cs) => cs.filter((c) => !ids.includes(c.id)))
    setToast({ text: `Deleted ${ids.length}.` })
  }

  function handleLicense(result: LicenseContact, consentAt: string, includedSensitive: boolean) {
    const fields = includedSensitive ? result : { ...result, dob: '', dl_number: '' }
    const { draft, autoFilled } = draftFromScan('license', { ...fields, consent_at: consentAt }, 'Home')
    setView({ name: 'form', draft, autoFilled })
  }

  function handleCard(result: CardContact, consent: IdConsent | undefined, uncertain: string[]) {
    // is_id is only a flag; it isn't saved.
    const { is_id: isId, ...fields } = result
    if (isId && consent) {
      const f = consent.includeSensitive ? fields : { ...fields, dob: '', dl_number: '' }
      const { draft, autoFilled } = draftFromScan('license', { ...f, consent_at: consent.consentAt }, 'Home')
      setView({ name: 'form', draft, autoFilled, uncertain: formKeys(uncertain, draft) })
      return
    }
    const { draft, autoFilled } = draftFromScan('card', { ...fields, dob: '', dl_number: '' }, 'Work')
    setView({ name: 'form', draft, autoFilled, uncertain: formKeys(uncertain, draft) })
  }

  if (!isConfigured) {
    return (
      <div className="mx-auto max-w-md p-6 text-sm">
        <h1 className="text-xl font-bold">Almost there</h1>
        <p className="mt-2">
          Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to a <code>.env.local</code> file (local) or to the
          repository’s Actions variables (GitHub Pages). See README.md.
        </p>
      </div>
    )
  }

  if (authLoading) return <div className="p-6 text-center text-sm text-slate-500">Loading…</div>
  if (!session) return <Auth />

  const title =
    view.name === 'home' ? 'Contact Capture' : view.name === 'list' ? 'Saved contacts' : view.name === 'scan' ? 'Scan license' : view.name === 'card' ? 'Scan business card' : view.editing ? 'Edit contact' : 'New contact'

  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-slate-50/95 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
        {view.name === 'home' ? (
          <span className="w-14" />
        ) : (
          <button className="w-14 text-left text-sm font-medium text-slate-600" onClick={() => setView({ name: 'home' })}>‹ Home</button>
        )}
        <h1 className="text-base font-semibold">{title}</h1>
        <button className="w-14 text-right text-sm text-slate-500" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>

      <main className="flex-1 px-4 py-4">
        {view.name === 'home' && (
          <div className="space-y-3">
            <button className="card flex w-full items-center gap-4 text-left hover:bg-slate-50" onClick={() => setView({ name: 'scan' })}>
              <span className="flex size-12 items-center justify-center rounded-xl bg-slate-900 text-xl text-white" aria-hidden>▤</span>
              <span>
                <span className="block font-semibold">Scan license</span>
                <span className="block text-sm text-slate-500">Barcode · with the holder’s consent</span>
              </span>
            </button>
            <button className="card flex w-full items-center gap-4 text-left hover:bg-slate-50" onClick={() => setView({ name: 'form', draft: emptyDraft() })}>
              <span className="flex size-12 items-center justify-center rounded-xl bg-slate-900 text-xl text-white" aria-hidden>✎</span>
              <span>
                <span className="block font-semibold">Type a contact</span>
                <span className="block text-sm text-slate-500">Enter details by hand</span>
              </span>
            </button>
            <button className="card flex w-full items-center gap-4 text-left hover:bg-slate-50" onClick={() => setView({ name: 'card' })}>
              <span className="flex size-12 items-center justify-center rounded-xl bg-slate-900 text-xl text-white" aria-hidden>▭</span>
              <span>
                <span className="block font-semibold">Scan business card</span>
                <span className="block text-sm text-slate-500">Photo of a card, badge or license front</span>
              </span>
            </button>
            <div className="card flex w-full items-center gap-4 opacity-60">
              <span className="flex size-12 items-center justify-center rounded-xl bg-slate-300 text-xl text-white" aria-hidden>🎙</span>
              <span>
                <span className="block font-semibold">Voice</span>
                <span className="block text-sm text-slate-500">Coming next</span>
              </span>
            </div>
            <button className="btn-secondary w-full" onClick={() => setView({ name: 'list' })}>
              Saved contacts ({contacts.length})
            </button>
            <p className="pt-2 text-center text-xs text-slate-400">Test version · no CRM sync · license number and birth date only with opt-in</p>
          </div>
        )}

        {view.name === 'list' && (
          <>
            {loadError && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}
            <ContactList
              contacts={contacts}
              defs={defs}
              loading={loading}
              onEdit={(c) => setView({ name: 'form', draft: { ...c }, editing: c })}
              onDelete={handleDelete}
            />
          </>
        )}

        {view.name === 'scan' && (
          <Suspense fallback={<p className="py-8 text-center text-sm text-slate-500">Loading scanner…</p>}>
            <LicenseScanner onResult={handleLicense} onCancel={() => setView({ name: 'home' })} />
          </Suspense>
        )}

        {view.name === 'card' && (
          <Suspense fallback={<p className="py-8 text-center text-sm text-slate-500">Loading scanner…</p>}>
            <CardScanner onResult={handleCard} onCancel={() => setView({ name: 'home' })} />
          </Suspense>
        )}

        {view.name === 'form' && (
          <ContactForm
            key={view.editing?.id ?? 'new'}
            initial={view.draft}
            autoFilled={view.autoFilled}
            uncertain={view.uncertain}
            isEdit={Boolean(view.editing)}
            defs={defs}
            onDefsChange={setDefs}
            onSave={(d) => handleSave(d, view.editing)}
            onCancel={() => setView(view.editing ? { name: 'list' } : { name: 'home' })}
          />
        )}
      </main>

      {toast && (
        <div className="fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-20 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-lg">
          <span>{toast.text}</span>
          {toast.contact && (
            <button
              className="rounded-lg bg-white/15 px-3 py-1.5 font-semibold"
              onClick={() => shareOrDownload(toVCard(toast.contact!, defs), vcardFileName(toast.contact!), 'text/vcard')}
            >
              Add to phone
            </button>
          )}
        </div>
      )}
    </div>
  )
}
