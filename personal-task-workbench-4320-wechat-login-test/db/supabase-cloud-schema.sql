-- Run this once in the Supabase SQL Editor before the first cloud deployment.
-- The Node service uses its server-only service-role key. RLS still prevents
-- accidental direct browser access from reading another user's workspace.

create table if not exists public.notebook_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.notebook_states enable row level security;

drop policy if exists "users read their own notebook" on public.notebook_states;
create policy "users read their own notebook"
  on public.notebook_states for select
  using (auth.uid() = user_id);

drop policy if exists "users create their own notebook" on public.notebook_states;
create policy "users create their own notebook"
  on public.notebook_states for insert
  with check (auth.uid() = user_id);

drop policy if exists "users update their own notebook" on public.notebook_states;
create policy "users update their own notebook"
  on public.notebook_states for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No delete policy: records are not removable through the browser by default.
