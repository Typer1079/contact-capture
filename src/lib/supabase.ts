import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
// The publishable ("anon") key is designed to be public. Row-level security in
// supabase/migrations/001_contacts.sql is what keeps each user's data private.
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && key)

export const supabase = createClient(url ?? 'https://not-configured.supabase.co', key ?? 'not-configured', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
})
