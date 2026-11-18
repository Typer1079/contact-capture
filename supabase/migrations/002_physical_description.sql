-- Contact Capture update: adds sex and physical description to contacts.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once.

alter table public.contacts
  add column if not exists sex        text not null default '' check (char_length(sex)        <= 20),
  add column if not exists height     text not null default '' check (char_length(height)     <= 20),
  add column if not exists weight     text not null default '' check (char_length(weight)     <= 20),
  add column if not exists eye_color  text not null default '' check (char_length(eye_color)  <= 30),
  add column if not exists hair_color text not null default '' check (char_length(hair_color) <= 30);
