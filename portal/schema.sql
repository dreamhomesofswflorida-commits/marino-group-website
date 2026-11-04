-- Marino Group Client Portal - database setup for Supabase
-- Run this once in Supabase: Project > SQL Editor > New query > paste > Run.

-- 1. Team members (agents). Anyone listed here sees every deal.
create table if not exists team_members (
  email text primary key,
  full_name text not null,
  phone text
);

-- 2. Deals (one per buyer or seller transaction)
create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  side text not null check (side in ('buyer','seller')),
  stage text not null default 'Active',
  client_name text,
  client_email text,
  agent_email text references team_members(email),
  price numeric,
  contract_date date,
  closing_date date,
  notes text,
  created_at timestamptz default now()
);

-- 3. Milestones on each deal's timeline
create table if not exists milestones (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  name text not null,
  due_date date,
  done boolean default false,
  client_visible boolean default true,
  sort int default 0
);

-- 4. Tasks (owner = agent or client)
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  title text not null,
  owner text not null default 'agent' check (owner in ('agent','client')),
  due_date date,
  done boolean default false
);

-- 5. Documents (files live in the storage bucket "deal-docs")
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  name text not null,
  path text not null,
  client_visible boolean default true,
  uploaded_at timestamptz default now()
);

-- 6. Homes owned by past clients (homeowner dashboard)
create table if not exists homes (
  id uuid primary key default gen_random_uuid(),
  client_name text,
  client_email text not null,
  address text not null,
  purchase_price numeric,
  purchase_date date,
  current_value numeric,
  value_updated date,
  insurance_renewal date,
  agent_email text references team_members(email),
  notes text
);

-- Helper: is the signed-in user on the team?
create or replace function is_agent() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where lower(email) = lower(auth.jwt() ->> 'email'));
$$;

create or replace function my_email() returns text
language sql stable as $$ select lower(auth.jwt() ->> 'email') $$;

alter table team_members enable row level security;
alter table deals enable row level security;
alter table milestones enable row level security;
alter table tasks enable row level security;
alter table documents enable row level security;
alter table homes enable row level security;

-- Team list: signed-in users can read it (clients see their agent's name and phone)
create policy "read team" on team_members for select to authenticated using (true);

-- Agents: full access to everything
create policy "agents deals" on deals for all to authenticated using (is_agent()) with check (is_agent());
create policy "agents milestones" on milestones for all to authenticated using (is_agent()) with check (is_agent());
create policy "agents tasks" on tasks for all to authenticated using (is_agent()) with check (is_agent());
create policy "agents documents" on documents for all to authenticated using (is_agent()) with check (is_agent());
create policy "agents homes" on homes for all to authenticated using (is_agent()) with check (is_agent());

-- Clients: only their own deals and homes
create policy "client deals" on deals for select to authenticated using (lower(client_email) = my_email());
create policy "client milestones" on milestones for select to authenticated
  using (client_visible and exists (select 1 from deals d where d.id = deal_id and lower(d.client_email) = my_email()));
create policy "client tasks read" on tasks for select to authenticated
  using (exists (select 1 from deals d where d.id = deal_id and lower(d.client_email) = my_email()));
create policy "client tasks tick" on tasks for update to authenticated
  using (owner = 'client' and exists (select 1 from deals d where d.id = deal_id and lower(d.client_email) = my_email()))
  with check (owner = 'client');
create policy "client documents" on documents for select to authenticated
  using (client_visible and exists (select 1 from deals d where d.id = deal_id and lower(d.client_email) = my_email()));
create policy "client homes" on homes for select to authenticated using (lower(client_email) = my_email());

-- File storage for deal documents (private bucket)
insert into storage.buckets (id, name, public) values ('deal-docs', 'deal-docs', false)
  on conflict (id) do nothing;
create policy "agents files" on storage.objects for all to authenticated
  using (bucket_id = 'deal-docs' and is_agent()) with check (bucket_id = 'deal-docs' and is_agent());
create policy "client files" on storage.objects for select to authenticated
  using (bucket_id = 'deal-docs' and exists (
    select 1 from documents doc join deals d on d.id = doc.deal_id
    where doc.path = storage.objects.name and doc.client_visible and lower(d.client_email) = my_email()));

-- 7. Add your team (edit, then run). Only these emails get the agent view.
insert into team_members (email, full_name, phone) values
  ('dhomeswfl@gmail.com', 'Jorge Marino', '(239) 776-2393')
on conflict (email) do nothing;
