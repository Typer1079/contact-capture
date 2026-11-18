import type { Session } from '@supabase/supabase-js'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import Auth from './components/Auth'
import ContactForm from './components/ContactForm'
import ContactList from './components/ContactList'
import type { LicenseContact } from './lib/aamva'
import { deleteContacts, listContacts, saveContact } from './lib/contactsApi'
import { shareOrDownload } from './lib/download'
import { isConfigured, supabase } from './lib/supabase'
import { emptyDraft, type Contact, type ContactDraft, type TextField } from './lib/types'
import { toVCard, vcardFileName } from './lib/vcard'

// The barcode reader (WebAssembly) only downloads when someone opens the scanner.
const LicenseScanner = lazy(() => import('./components/LicenseScanner'))

type View =
  | { name: 'home' }
  | { name: 'list' }
  | { name: 'scan' }
  | { name: 'form'; draft: ContactDraft; editing?: Contact; autoFilled?: TextField[] }

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [view, setView] = useState<View>({ name: 'home' })
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<{ text: string; contact?: Contact } | null>(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (!s) setContacts([]) // never leave one user's data on screen after sign-out
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      setContacts(await listContacts())
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

  function handleLicense(result: LicenseContact, consentAt: string) {
    const draft: ContactDraft = { ...emptyDraft('license'), ...result, consent_at: consentAt }
    const autoFilled = (Object.keys(result) as TextField[]).filter((k) => result[k as keyof LicenseContact])
    setView({ name: 'form', draft, autoFilled })
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
    view.name === 'home' ? 'Contact Capture' : view.name === 'list' ? 'Saved contacts' : view.name === 'scan' ? 'Scan license' : view.editing ? 'Edit contact' : 'New contact'

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
                <span className="block text-sm text-slate-500">With the holder’s consent · name & address only</span>
              </span>
            </button>
            <button className="card flex w-full items-center gap-4 text-left hover:bg-slate-50" onClick={() => setView({ name: 'form', draft: emptyDraft() })}>
              <span className="flex size-12 items-center justify-center rounded-xl bg-slate-900 text-xl text-white" aria-hidden>✎</span>
              <span>
                <span className="block font-semibold">Type a contact</span>
                <span className="block text-sm text-slate-500">Enter details by hand</span>
              </span>
            </button>
            <div className="card flex w-full items-center gap-4 opacity-60">
              <span className="flex size-12 items-center justify-center rounded-xl bg-slate-300 text-xl text-white" aria-hidden>▭</span>
              <span>
                <span className="block font-semibold">Business card · Voice</span>
                <span className="block text-sm text-slate-500">Coming next</span>
              </span>
            </div>
            <button className="btn-secondary w-full" onClick={() => setView({ name: 'list' })}>
              Saved contacts ({contacts.length})
            </button>
            <p className="pt-2 text-center text-xs text-slate-400">Test version · no CRM sync · license data never leaves this device except name & address you save</p>
          </div>
        )}

        {view.name === 'list' && (
          <>
            {loadError && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}
            <ContactList
              contacts={contacts}
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

        {view.name === 'form' && (
          <ContactForm
            key={view.editing?.id ?? 'new'}
            initial={view.draft}
            autoFilled={view.autoFilled}
            isEdit={Boolean(view.editing)}
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
              onClick={() => shareOrDownload(toVCard(toast.contact!), vcardFileName(toast.contact!), 'text/vcard')}
            >
              Add to phone
            </button>
          )}
        </div>
      )}
    </div>
  )
}
