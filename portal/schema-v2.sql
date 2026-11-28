-- Marino Group - upgrade 2: seller leads, listing status, showings, feedback, offers, document checklist
-- Run AFTER schema.sql, once, in Supabase > SQL Editor.

-- ---------- 1. Seller leads from /sell ("What's my home worth?") ----------
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  name text not null,
  email text,
  phone text,
  address text not null,
  property_type text,
  beds numeric,
  baths numeric,
  sqft int,
  year_built int,
  condition text,
  timeline text,
  reason text,
  language text default 'English',
  source text default 'website',
  status text not null default 'New' check (status in ('New','CMA sent','Appointment','Listed','Not now','Lost')),
  est_low numeric,
  est_high numeric,
  cma_url text,
  agent_email text references team_members(email),
  notes text
);
alter table leads enable row level security;
-- Anyone can submit the form; only the team can read or change leads.
create policy "public submit lead" on leads for insert to anon, authenticated
  with check (status = 'New' and cma_url is null and est_low is null and est_high is null);
create policy "agents leads" on leads for all to authenticated using (is_agent()) with check (is_agent());

-- ---------- 2. Listing details on seller deals ----------
alter table deals add column if not exists mls_number text;
alter table deals add column if not exists list_price numeric;
alter table deals add column if not exists list_date date;
alter table deals add column if not exists listing_status text default 'Coming soon';
alter table deals add column if not exists showings_open boolean default false;      -- listed on /book for agents
alter table deals add column if not exists showing_approval text default 'seller';  -- 'auto' | 'seller' | 'agent'
alter table deals add column if not exists showing_notes text;                       -- shown to the booking agent after confirmation (lockbox, pets...)
alter table deals add column if not exists photo_url text;

-- Sellers may approve or decline showings on their own listing (see showings policies below).

-- ---------- 3. Showings ----------
create table if not exists showings (
  id uuid primary key default gen_random_uuid(),
  token uuid not null default gen_random_uuid(),     -- private link for the booking agent (status + feedback)
  deal_id uuid not null references deals(id) on delete cascade,
  start_at timestamptz not null,
  minutes int not null default 30,
  status text not null default 'Requested' check (status in ('Requested','Confirmed','Declined','Cancelled')),
  agent_name text not null,
  agent_email text,
  agent_phone text,
  brokerage text,
  license_no text,
  buyer_name text,
  note text,
  fb_interest int check (fb_interest between 1 and 5),
  fb_price text check (fb_price in ('Too high','About right','A good value')),
  fb_comment text,
  fb_at timestamptz,
  created_at timestamptz default now()
);
alter table showings enable row level security;
create policy "agents showings" on showings for all to authenticated using (is_agent()) with check (is_agent());
create policy "seller reads showings" on showings for select to authenticated
  using (exists (select 1 from deals d where d.id = deal_id and lower(d.client_email) = my_email()));
create policy "seller decides showings" on showings for update to authenticated
  using (exists (select 1 from deals d where d.id = deal_id and lower(d.client_email) = my_email() and d.showing_approval = 'seller'))
  with check (status in ('Confirmed','Declined'));

-- Public: listings open for showings (street address, price, photo only)
create or replace function public_listings()
returns table(id uuid, address text, list_price numeric, photo_url text, mls_number text)
language sql stable security definer set search_path = public as $$
  select id, address, coalesce(list_price, price), photo_url, mls_number
  from deals where side = 'seller' and showings_open and stage <> 'Closed'
  order by address;
$$;

-- Public: times already taken for one listing (no names)
create or replace function busy_times(p_deal uuid)
returns table(start_at timestamptz, minutes int)
language sql stable security definer set search_path = public as $$
  select start_at, minutes from showings
  where deal_id = p_deal and status in ('Requested','Confirmed') and start_at > now() - interval '1 day';
$$;

-- Public: request a showing. Returns the private token for the status page.
create or replace function request_showing(p_deal uuid, p_start timestamptz, p_minutes int,
  p_name text, p_email text, p_phone text, p_brokerage text, p_license text, p_buyer text, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare d deals; s showings;
begin
  select * into d from deals where id = p_deal and showings_open and side = 'seller' and stage <> 'Closed';
  if not found then raise exception 'This home is not taking showing requests right now.'; end if;
  if p_start < now() then raise exception 'Pick a time in the future.'; end if;
  if p_minutes not in (15,30,45,60) then raise exception 'Pick 15, 30, 45 or 60 minutes.'; end if;
  if coalesce(trim(p_name),'') = '' or (coalesce(trim(p_email),'') = '' and coalesce(trim(p_phone),'') = '') then
    raise exception 'Name and an email or phone are required.'; end if;
  if exists (select 1 from showings x where x.deal_id = p_deal and x.status in ('Requested','Confirmed')
             and tstzrange(x.start_at, x.start_at + make_interval(mins => x.minutes)) && tstzrange(p_start, p_start + make_interval(mins => p_minutes))) then
    raise exception 'That time was just taken. Please pick another.'; end if;
  insert into showings(deal_id, start_at, minutes, status, agent_name, agent_email, agent_phone, brokerage, license_no, buyer_name, note)
  values (p_deal, p_start, p_minutes, case when d.showing_approval = 'auto' then 'Confirmed' else 'Requested' end,
          left(p_name,120), left(p_email,160), left(p_phone,40), left(p_brokerage,120), left(p_license,40), left(p_buyer,120), left(p_note,500))
  returning * into s;
  return s.token;
end $$;

-- Public: the booking agent's status page (by private token)
create or replace function showing_status(p_token uuid)
returns table(address text, start_at timestamptz, minutes int, status text, showing_notes text, fb_done boolean)
language sql stable security definer set search_path = public as $$
  select d.address, s.start_at, s.minutes, s.status,
         case when s.status = 'Confirmed' then d.showing_notes else null end,
         s.fb_at is not null
  from showings s join deals d on d.id = s.deal_id where s.token = p_token;
$$;

-- Public: cancel or leave feedback (by private token)
create or replace function cancel_showing(p_token uuid) returns void
language sql security definer set search_path = public as $$
  update showings set status = 'Cancelled' where token = p_token and status in ('Requested','Confirmed');
$$;
create or replace function submit_feedback(p_token uuid, p_interest int, p_price text, p_comment text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update showings set fb_interest = p_interest, fb_price = p_price, fb_comment = left(p_comment,1000), fb_at = now()
  where token = p_token and status = 'Confirmed' and start_at < now() + interval '1 hour';
  if not found then raise exception 'Feedback opens after the showing.'; end if;
end $$;

grant execute on function public_listings(), busy_times(uuid), request_showing(uuid,timestamptz,int,text,text,text,text,text,text,text),
  showing_status(uuid), cancel_showing(uuid), submit_feedback(uuid,int,text,text) to anon, authenticated;

-- ---------- 4. Offers ----------
create table if not exists offers (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  received_at date default current_date,
  buyer_agent text,
  price numeric,
  financing text,
  escrow_deposit numeric,
  closing_date date,
  contingencies text,
  status text not null default 'Received' check (status in ('Received','Countered','Accepted','Rejected','Withdrawn')),
  notes text
);
alter table offers enable row level security;
create policy "agents offers" on offers for all to authenticated using (is_agent()) with check (is_agent());
create policy "seller offers" on offers for select to authenticated
  using (exists (select 1 from deals d where d.id = deal_id and lower(d.client_email) = my_email()));

-- ---------- 5. Document checklist (what each file needs, and signatures) ----------
create table if not exists checklist (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  name text not null,
  status text not null default 'Needed' check (status in ('Needed','Sent for signature','Signed','Received','Not needed')),
  who text default 'agent' check (who in ('agent','client','other')),
  due_date date,
  sign_url text,          -- link to sign (e.g. Authentisign, DocuSign, Dotloop) shown to the client
  document_id uuid references documents(id) on delete set null,
  sort int default 0
);
alter table checklist enable row level security;
create policy "agents checklist" on checklist for all to authenticated using (is_agent()) with check (is_agent());
create policy "client checklist" on checklist for select to authenticated
  using (exists (select 1 from deals d where d.id = deal_id and lower(d.client_email) = my_email()));
