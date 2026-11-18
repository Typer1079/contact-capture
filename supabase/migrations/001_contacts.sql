-- Contact Capture: contacts table with row-level security.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.

create table if not exists public.contacts (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  first_name   text not null default '' check (char_length(first_name)  <= 100),
  last_name    text not null default '' check (char_length(last_name)   <= 100),
  company      text not null default '' check (char_length(company)     <= 200),
  title        text not null default '' check (char_length(title)       <= 200),
  email        text not null default '' check (char_length(email)       <= 254),
  phone        text not null default '' check (char_length(phone)       <= 40),
  street       text not null default '' check (char_length(street)      <= 200),
  city         text not null default '' check (char_length(city)        <= 100),
  region       text not null default '' check (char_length(region)      <= 100),
  postal_code  text not null default '' check (char_length(postal_code) <= 20),
  country      text not null default '' check (char_length(country)     <= 100),
  notes        text not null default '' check (char_length(notes)       <= 2000),
  source       text not null default 'manual' check (source in ('manual', 'license', 'card', 'voice')),
  -- When the person whose license was scanned gave consent. Required for license scans.
  consent_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint has_a_name check (first_name <> '' or last_name <> '' or company <> ''),
  constraint license_needs_consent check (source <> 'license' or consent_at is not null)
);

create index if not exists contacts_owner_created_idx on public.contacts (owner_id, created_at desc);

-- Keep updated_at current.
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists contacts_set_updated_at on public.contacts;
create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

-- Row-level security: every user can only see and change their own rows.
alter table public.contacts enable row level security;
alter table public.contacts force row level security;

revoke all on public.contacts from anon;
grant select, insert, update, delete on public.contacts to authenticated;

drop policy if exists "own contacts: select" on public.contacts;
drop policy if exists "own contacts: insert" on public.contacts;
drop policy if exists "own contacts: update" on public.contacts;
drop policy if exists "own contacts: delete" on public.contacts;

create policy "own contacts: select" on public.contacts
  for select to authenticated using ((select auth.uid()) = owner_id);

create policy "own contacts: insert" on public.contacts
  for insert to authenticated with check ((select auth.uid()) = owner_id);

create policy "own contacts: update" on public.contacts
  for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create policy "own contacts: delete" on public.contacts
  for delete to authenticated using ((select auth.uid()) = owner_id);
