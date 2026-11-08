-- Marino Showings - database setup (run AFTER portal/schema.sql, in the same Supabase project)
-- Supabase > SQL Editor > New query > paste > Run.
-- Admins = the emails in team_members (from portal/schema.sql). They approve licenses and are free.

create table if not exists sh_agents (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text,
  phone text,
  brokerage text,
  license_no text,
  license_state text default 'FL',
  license_type text default 'sa',
  license_exp date,
  proof_path text,
  langs text[] default '{en}',
  available boolean default true,
  status text not null default 'pending' check (status in ('pending','verified','rejected')),
  reject_reason text,
  member_until date,          -- paid membership end date, set by an admin
  rating_sum int default 0,
  rating_count int default 0,
  created_at timestamptz default now()
);

create table if not exists sh_jobs (
  id uuid primary key default gen_random_uuid(),
  requester uuid not null references sh_agents(id),
  assignee uuid references sh_agents(id),
  kind text not null check (kind in ('showing','openhouse')),
  task text not null default 'showing',
  date date not null,
  time time not null,
  end_time time,
  tz text default 'ET',
  address text not null,
  unit text,
  city text not null,
  state text default 'FL',
  zip text,
  mls text,
  lang text default 'en',
  buyer_met boolean,
  agr_type text,
  agr_path text,
  agr_attest boolean default false,
  signs text,
  kit boolean,
  notes text,
  pay numeric not null,
  status text not null default 'open' check (status in ('open','accepted','confirmed','checkedin','completed','cancelled')),
  checked_in_at timestamptz,
  fb_interest int, fb_price text, fb_notes text, fb_visitors int, fb_leads int,
  rating int,
  created_at timestamptz default now()
);

create table if not exists sh_signins (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references sh_jobs(id) on delete cascade,
  name text not null,
  phone text,
  email text,
  has_agent text,
  timeline text,
  notes text,
  created_at timestamptz default now()
);

alter table sh_agents enable row level security;
alter table sh_jobs enable row level security;
alter table sh_signins enable row level security;

-- Profiles: any signed-in user can read; you can create/edit only your own row,
-- and you cannot change your own license status, membership or rating.
create policy "read agents" on sh_agents for select to authenticated using (true);
create policy "insert own" on sh_agents for insert to authenticated with check (id = auth.uid() and status = 'pending' and member_until is null and rating_count = 0);
create policy "update own" on sh_agents for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
revoke update on sh_agents from authenticated;
grant update (name, phone, brokerage, license_no, license_state, license_type, license_exp, proof_path, langs, available) on sh_agents to authenticated;

-- Changing license details sends the profile back for review.
create or replace function sh_relicense() returns trigger language plpgsql as $$
begin
  if (new.license_no, new.license_state, new.license_type, new.license_exp, new.proof_path)
     is distinct from (old.license_no, old.license_state, old.license_type, old.license_exp, old.proof_path)
     and not is_agent() then
    new.status := 'pending'; new.reject_reason := null;
  end if;
  return new;
end $$;
drop trigger if exists sh_relicense on sh_agents;
create trigger sh_relicense before update on sh_agents for each row execute function sh_relicense();

create or replace function sh_verified() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from sh_agents where id = auth.uid() and status = 'verified' and (license_exp is null or license_exp >= current_date));
$$;

-- Jobs
create policy "read jobs" on sh_jobs for select to authenticated using (true);
create policy "post jobs" on sh_jobs for insert to authenticated with check (requester = auth.uid() and status = 'open' and assignee is null and sh_verified());
create policy "edit own jobs" on sh_jobs for update to authenticated using (auth.uid() in (requester, assignee)) with check (auth.uid() in (requester, assignee) or assignee is null);

-- Accepting is first-come: only succeeds if the job is still open.
create or replace function sh_accept(job uuid) returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not sh_verified() then raise exception 'License not approved'; end if;
  update sh_jobs set assignee = auth.uid(), status = 'accepted'
   where id = job and status = 'open' and assignee is null and requester <> auth.uid();
  get diagnostics n = row_count; return n = 1;
end $$;

-- Rating the covering agent (requester only, once).
create or replace function sh_rate(job uuid, stars int) returns void language plpgsql security definer set search_path = public as $$
declare a uuid;
begin
  update sh_jobs set rating = stars where id = job and requester = auth.uid() and rating is null and status = 'completed' and stars between 1 and 5
  returning assignee into a;
  if a is not null then update sh_agents set rating_sum = rating_sum + stars, rating_count = rating_count + 1 where id = a; end if;
end $$;

-- Admin: approve or reject a license, set membership.
create or replace function sh_review(agent uuid, new_status text, reason text default null) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_agent() then raise exception 'Admins only'; end if;
  update sh_agents set status = new_status, reject_reason = reason where id = agent;
end $$;
create or replace function sh_set_member(agent uuid, until date) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_agent() then raise exception 'Admins only'; end if;
  update sh_agents set member_until = until where id = agent;
end $$;

-- Open house sign-ins: anyone at the door can sign in (no login); only the two agents on the job can read them.
create policy "visitor sign in" on sh_signins for insert to anon, authenticated
  with check (exists (select 1 from sh_jobs j where j.id = job_id and j.kind = 'openhouse' and j.status <> 'cancelled'));
create policy "agents read signins" on sh_signins for select to authenticated
  using (exists (select 1 from sh_jobs j where j.id = job_id and auth.uid() in (j.requester, j.assignee)));
-- Visitors need the address of the open house they are signing in to.
create or replace function sh_public_job(job uuid) returns table(address text, city text, kind text, status text)
language sql stable security definer set search_path = public as $$
  select address, city, kind, status from sh_jobs where id = job;
$$;
grant execute on function sh_public_job(uuid) to anon, authenticated;

-- Private files: license proofs and buyer agreements, each in the owner's folder.
insert into storage.buckets (id, name, public) values ('showings', 'showings', false) on conflict (id) do nothing;
create policy "own files write" on storage.objects for insert to authenticated
  with check (bucket_id = 'showings' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own files read" on storage.objects for select to authenticated
  using (bucket_id = 'showings' and ((storage.foldername(name))[1] = auth.uid()::text or is_agent()));
