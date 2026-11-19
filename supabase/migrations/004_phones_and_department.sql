-- Contact Capture update: several labeled phone numbers per contact (Mobile, Work, Direct,
-- Fax, Toll-free, your own label), each with an optional extension, plus a Department field.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to run more than once.

-- 1. New columns -----------------------------------------------------------------------------
alter table public.contacts
  add column if not exists phones     jsonb not null default '[]'::jsonb,
  add column if not exists department text  not null default '' check (char_length(department) <= 200);

-- Keep the phone list the right shape and a sane size (up to 10 numbers).
alter table public.contacts drop constraint if exists phones_shape;
alter table public.contacts add constraint phones_shape
  check (jsonb_typeof(phones) = 'array' and jsonb_array_length(phones) <= 10 and pg_column_size(phones) <= 8000);

-- 2. Move each existing single phone number into the list ------------------------------------
-- Business-card numbers become "Work"; license and typed contacts become "Mobile".
-- The old "phone" column stays and keeps holding the main number.
update public.contacts
set phones = jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text,
      'label', case when source = 'card' then 'Work' else 'Mobile' end,
      'number', phone,
      'ext', ''))
where phones = '[]'::jsonb and phone <> '';
