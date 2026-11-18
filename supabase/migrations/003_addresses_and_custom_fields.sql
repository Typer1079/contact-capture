-- Contact Capture update: labeled addresses (Home / Work / your own), hire date, home state,
-- date of birth, driver's license number, and custom fields you define in the app.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to run more than once.

-- 1. New contact columns -------------------------------------------------------------------
alter table public.contacts
  add column if not exists addresses  jsonb not null default '[]'::jsonb,
  add column if not exists hire_date  date,
  add column if not exists home_state text  not null default '' check (char_length(home_state) <= 30),
  add column if not exists dob        date,
  add column if not exists dl_number  text  not null default '' check (char_length(dl_number) <= 30),
  add column if not exists custom     jsonb not null default '{}'::jsonb;

-- Keep the JSON columns the right shape and a sane size.
alter table public.contacts drop constraint if exists addresses_shape;
alter table public.contacts add constraint addresses_shape
  check (jsonb_typeof(addresses) = 'array' and jsonb_array_length(addresses) <= 10 and pg_column_size(addresses) <= 20000);
alter table public.contacts drop constraint if exists custom_shape;
alter table public.contacts add constraint custom_shape
  check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) <= 20000);

-- 2. Move existing single addresses into the labeled list ------------------------------------
-- License scans are Home addresses; business cards and typed contacts are Work addresses.
-- The old columns are left untouched as a backup (the app no longer uses them).
update public.contacts
set addresses = jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text,
      'label', case when source = 'license' then 'Home' else 'Work' end,
      'street', street, 'suite', '', 'city', city, 'region', region,
      'postal_code', postal_code, 'country', country))
where addresses = '[]'::jsonb
  and (street <> '' or city <> '' or region <> '' or postal_code <> '' or country <> '');

-- 3. Custom field definitions (each user's own list) ----------------------------------------
create table if not exists public.custom_field_defs (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  label      text not null check (char_length(label) between 1 and 60),
  kind       text not null default 'text' check (kind in ('text', 'number', 'date')),
  position   int  not null default 0,
  created_at timestamptz not null default now(),
  unique (owner_id, label)
);

alter table public.custom_field_defs enable row level security;
alter table public.custom_field_defs force row level security;
revoke all on public.custom_field_defs from anon;
grant select, insert, update, delete on public.custom_field_defs to authenticated;

drop policy if exists "own field defs: select" on public.custom_field_defs;
drop policy if exists "own field defs: insert" on public.custom_field_defs;
drop policy if exists "own field defs: update" on public.custom_field_defs;
drop policy if exists "own field defs: delete" on public.custom_field_defs;

create policy "own field defs: select" on public.custom_field_defs
  for select to authenticated using ((select auth.uid()) = owner_id);
create policy "own field defs: insert" on public.custom_field_defs
  for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "own field defs: update" on public.custom_field_defs
  for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "own field defs: delete" on public.custom_field_defs
  for delete to authenticated using ((select auth.uid()) = owner_id);
