-- Marino Group - upgrade 3: buyer & renter leads, saved homes and searches, reviews,
-- virtual tours, automatic emails (outbox) and follow-up sequences.
-- Run AFTER schema.sql and schema-v2.sql, once, in Supabase > SQL Editor.

-- ---------- 1. Leads of every kind ----------
alter table leads alter column address drop not null;
alter table leads add column if not exists lead_type text default 'seller';
alter table leads add column if not exists listing_id text;          -- home the lead asked about (tour / rental)
alter table leads add column if not exists details jsonb;            -- extra answers (budget, move date, income...)
alter table leads add column if not exists token uuid default gen_random_uuid();
alter table leads add column if not exists unsubscribed boolean default false;
alter table leads drop constraint if exists leads_lead_type_check;
alter table leads add constraint leads_lead_type_check check (lead_type in ('seller','buyer','tour','preapproval','renter'));
drop policy if exists "public submit lead" on leads;
create policy "public submit lead" on leads for insert to anon, authenticated
  with check (status = 'New' and cma_url is null and est_low is null and est_high is null and unsubscribed = false);

-- ---------- 2. Saved homes and saved searches (buyer accounts) ----------
create table if not exists favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  email text default my_email(),
  listing_id text not null,
  address text,
  price numeric,
  created_at timestamptz default now(),
  unique (user_id, listing_id)
);
alter table favorites enable row level security;
create policy "own favorites" on favorites for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "agents see favorites" on favorites for select to authenticated using (is_agent());

create table if not exists saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  email text default my_email(),
  name text,
  criteria jsonb not null default '{}',
  frequency text not null default 'daily' check (frequency in ('instant','daily','weekly','off')),
  created_at timestamptz default now(),
  last_sent timestamptz
);
alter table saved_searches enable row level security;
create policy "own searches" on saved_searches for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "agents see searches" on saved_searches for select to authenticated using (is_agent());

-- ---------- 3. Client reviews ----------
create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  name text not null,
  email text,
  rating int not null check (rating between 1 and 5),
  body text not null,
  role text check (role in ('Buyer','Seller','Renter','Landlord','Other')),
  city text,
  agent_email text,
  approved boolean not null default false
);
alter table reviews enable row level security;
create policy "public submit review" on reviews for insert to anon, authenticated with check (approved = false);
create policy "agents reviews" on reviews for all to authenticated using (is_agent()) with check (is_agent());
create or replace function public_reviews()
returns table(name text, rating int, body text, role text, city text, created_at timestamptz, agent text)
language sql stable security definer set search_path = public as $$
  select split_part(r.name,' ',1) || coalesce(' ' || left(nullif(split_part(r.name,' ',2),''),1) || '.', ''),
         r.rating, r.body, r.role, r.city, r.created_at, t.full_name
  from reviews r left join team_members t on lower(t.email) = lower(r.agent_email)
  where r.approved order by r.created_at desc limit 100;
$$;
grant execute on function public_reviews() to anon, authenticated;

-- ---------- 4. Virtual tours on listings ----------
alter table deals add column if not exists virtual_tour_url text;
drop function if exists public_listings();
create or replace function public_listings()
returns table(id uuid, address text, list_price numeric, photo_url text, mls_number text, virtual_tour_url text)
language sql stable security definer set search_path = public as $$
  select id, address, coalesce(list_price, price), photo_url, mls_number, virtual_tour_url
  from deals where side = 'seller' and showings_open and stage <> 'Closed'
  order by address;
$$;
-- (the return type changed, so it was replaced; grant again)
grant execute on function public_listings() to anon, authenticated;

-- ---------- 5. Email outbox: every automatic message is queued here, then sent ----------
create table if not exists outbox (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  kind text not null,                 -- e.g. lead_alert, lead_welcome, showing_alert, followup_3 ...
  related_id uuid,
  to_email text not null,
  subject text not null,
  body text not null,                 -- plain text; the sender adds the Marino Group footer
  status text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  sent_at timestamptz,
  error text,
  unique (kind, related_id, to_email)
);
alter table outbox enable row level security;
create policy "agents outbox" on outbox for all to authenticated using (is_agent()) with check (is_agent());

-- Office settings used by the emails
create table if not exists settings (key text primary key, value text);
alter table settings enable row level security;
create policy "agents settings" on settings for all to authenticated using (is_agent()) with check (is_agent());
insert into settings values
  ('office_email','dhomeswfl@gmail.com'),
  ('office_phone','(239) 776-2393'),
  ('site','https://marinogroupswfl.com'),
  ('signature', E'Jorge Marino LLC · Marino Group\nBrokered by Waterfront Realty Group, Inc.\n(239) 776-2393 · marinogroupswfl.com')
on conflict (key) do nothing;
create or replace function cfg(k text) returns text language sql stable security definer set search_path = public as
$$ select value from settings where key = k $$;

create or replace function queue_mail(p_kind text, p_rel uuid, p_to text, p_subject text, p_body text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(p_to),'') = '' or p_to !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return; end if;
  insert into outbox(kind, related_id, to_email, subject, body)
  values (p_kind, p_rel, lower(trim(p_to)), left(p_subject,200), p_body || E'\n\n— ' || cfg('signature'))
  on conflict do nothing;
end $$;
revoke execute on function queue_mail(text,uuid,text,text,text) from public, anon, authenticated;

-- New lead: alert the office, welcome the lead
create or replace function on_new_lead() returns trigger language plpgsql security definer set search_path = public as $$
declare what text := case new.lead_type when 'seller' then 'home value report' when 'tour' then 'tour request'
  when 'preapproval' then 'pre-approval request' when 'renter' then 'rental inquiry' else 'home search' end;
begin
  perform queue_mail('lead_alert', new.id, cfg('office_email'),
    'New ' || what || ': ' || new.name || coalesce(' · ' || new.address, ''),
    'New ' || what || E' from the website.\n\nName: ' || new.name || E'\nPhone: ' || coalesce(new.phone,'—') ||
    E'\nEmail: ' || coalesce(new.email,'—') || E'\nLanguage: ' || coalesce(new.language,'English') ||
    E'\nProperty: ' || coalesce(new.address,'—') || coalesce(E'\nType: ' || new.property_type,'') ||
    coalesce(E'\nBeds/baths/sq ft: ' || new.beds || ' / ' || new.baths || ' / ' || new.sqft,'') ||
    coalesce(E'\nCondition: ' || new.condition,'') || coalesce(E'\nTimeline: ' || new.timeline,'') ||
    coalesce(E'\nNotes: ' || new.reason,'') || coalesce(E'\nDetails: ' || new.details::text,'') ||
    E'\n\nOpen your portal: ' || cfg('site') || '/portal/');
  if new.email is not null then
    perform queue_mail('lead_welcome', new.id, new.email,
      case new.lead_type when 'seller' then 'Your home value report is on its way' else 'Thanks for contacting Marino Group' end,
      'Hi ' || split_part(new.name,' ',1) || E',\n\n' ||
      case new.lead_type
        when 'seller' then 'Thank you for requesting a home value report for ' || coalesce(new.address,'your home') ||
          '. A local Marino Group agent is studying recent sales near you and will send your report within 24 hours.'
        when 'tour' then 'Thank you for your tour request. We will confirm a time with you shortly.'
        when 'preapproval' then 'Thank you for your pre-approval request. We will connect you with a trusted local lender and call you to talk about your plans.'
        when 'renter' then 'Thank you for your interest in ' || coalesce(new.address,'our rental') || '. We will contact you shortly about a showing and the application.'
        else 'Thank you for reaching out. We will be in touch shortly.' end ||
      E'\n\nQuestions? Call or text ' || cfg('office_phone') || '.' ||
      E'\n\nNo longer interested? Unsubscribe: ' || cfg('site') || '/unsubscribe/?t=' || new.token);
  end if;
  return new;
end $$;
drop trigger if exists t_new_lead on leads;
create trigger t_new_lead after insert on leads for each row execute function on_new_lead();

-- Showings: alert the office and seller on a request; email the showing agent on every status change; share feedback
create or replace function on_showing() returns trigger language plpgsql security definer set search_path = public as $$
declare d deals; t text; link text;
begin
  select * into d from deals where id = new.deal_id;
  t := to_char(new.start_at at time zone 'America/New_York', 'Dy Mon DD, HH12:MI AM');
  link := cfg('site') || '/book/?t=' || new.token;
  if tg_op = 'INSERT' then
    perform queue_mail('showing_alert', new.id, coalesce(d.agent_email, cfg('office_email')),
      'Showing ' || lower(new.status) || ': ' || split_part(d.address, ',', 1) || ' · ' || t,
      new.agent_name || coalesce(' (' || new.brokerage || ')', '') || ' booked ' || t || ' for ' || new.minutes || E' minutes.\nPhone: ' ||
      coalesce(new.agent_phone,'—') || E'\nEmail: ' || coalesce(new.agent_email,'—') || coalesce(E'\nLicense: ' || new.license_no,'') ||
      coalesce(E'\nNote: ' || new.note,'') || E'\n\nConfirm or decline in your portal: ' || cfg('site') || '/portal/');
    if d.client_email is not null then
      perform queue_mail('showing_seller', new.id, d.client_email,
        case when new.status = 'Requested' and d.showing_approval = 'seller' then 'Please approve a showing: ' else 'New showing: ' end || t,
        'A buyer''s agent would like to show ' || split_part(d.address, ',', 1) || ' on ' || t || '.' ||
        case when new.status = 'Requested' and d.showing_approval = 'seller' then E'\n\nApprove or decline it in your portal: ' || cfg('site') || '/portal/'
             else E'\n\nSee all showings in your portal: ' || cfg('site') || '/portal/' end);
    end if;
  end if;
  if new.agent_email is not null and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    perform queue_mail('showing_' || lower(new.status), new.id, new.agent_email,
      'Showing ' || lower(new.status) || ': ' || split_part(d.address, ',', 1) || ' · ' || t,
      'Your showing at ' || d.address || ' on ' || t || ' is ' || lower(new.status) || '.' ||
      case when new.status = 'Confirmed' then E'\n\nAccess instructions and the feedback form after the showing: ' || link
           when new.status = 'Declined' then E'\n\nPlease pick another time: ' || cfg('site') || '/book/?l=' || d.id
           else E'\n\nCheck the status any time: ' || link end);
  end if;
  if tg_op = 'UPDATE' and new.fb_at is not null and old.fb_at is null and d.client_email is not null then
    perform queue_mail('showing_feedback', new.id, d.client_email,
      'Showing feedback: ' || split_part(d.address, ',', 1),
      'Feedback from the ' || t || E' showing:\n\nBuyer interest: ' || new.fb_interest || E'/5\nPrice: ' || coalesce(new.fb_price,'—') ||
      coalesce(E'\nComments: ' || new.fb_comment,'') || E'\n\nSee all feedback in your portal: ' || cfg('site') || '/portal/');
  end if;
  return new;
end $$;
drop trigger if exists t_showing on showings;
create trigger t_showing after insert or update on showings for each row execute function on_showing();

-- New review: tell the office it is waiting for approval
create or replace function on_review() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform queue_mail('review_alert', new.id, cfg('office_email'), 'New ' || new.rating || '-star review from ' || new.name,
    new.body || E'\n\nApprove it in your portal (Reviews tab) to show it on the website: ' || cfg('site') || '/portal/');
  return new;
end $$;
drop trigger if exists t_review on reviews;
create trigger t_review after insert on reviews for each row execute function on_review();

-- ---------- 6. Follow-up sequences (run daily) ----------
create or replace function queue_followups() returns int language plpgsql security definer set search_path = public as $$
declare l leads; h homes; n int := 0; age int;
begin
  for l in select * from leads where email is not null and not unsubscribed and status in ('New','CMA sent','Not now') loop
    age := (current_date - (l.created_at at time zone 'America/New_York')::date);
    if l.lead_type = 'seller' and age = 3 then
      perform queue_mail('followup_3', l.id, l.email, 'Questions about your home value report?',
        'Hi ' || split_part(l.name,' ',1) || E',\n\nI wanted to make sure your report for ' || coalesce(l.address,'your home') ||
        E' answered your questions. If you made upgrades we should know about, reply and I will update the numbers.\n\nWould a 15-minute call this week help? Just reply with a good time.' ||
        E'\n\nUnsubscribe: ' || cfg('site') || '/unsubscribe/?t=' || l.token); n := n + 1;
    elsif l.lead_type = 'seller' and age = 14 then
      perform queue_mail('followup_14', l.id, l.email, 'What sold near you this month',
        'Hi ' || split_part(l.name,' ',1) || E',\n\nHomes keep selling near ' || coalesce(l.address,'you') ||
        E'. If you would like an updated value with this month''s sales, reply "update" and I will send it.' ||
        E'\n\nUnsubscribe: ' || cfg('site') || '/unsubscribe/?t=' || l.token); n := n + 1;
    elsif l.lead_type <> 'seller' and age = 2 then
      perform queue_mail('followup_2', l.id, l.email, 'Still looking? Here is how we can help',
        'Hi ' || split_part(l.name,' ',1) || E',\n\nTell us what matters most (area, price, beds, timing) and we will send matching homes as soon as they list. ' ||
        E'You can also save homes and searches on our website: ' || cfg('site') || E'/homes/\n\nUnsubscribe: ' || cfg('site') || '/unsubscribe/?t=' || l.token); n := n + 1;
    elsif age >= 30 and age % 30 = 0 and age <= 360 then
      perform queue_mail('followup_m' || age, l.id, l.email, 'Your monthly Southwest Florida market update',
        'Hi ' || split_part(l.name,' ',1) || E',\n\nA quick check-in from Marino Group. Whenever you are ready to buy, sell or just want a fresh home value, reply to this email or call ' || cfg('office_phone') ||
        E'.\n\nFree home value report: ' || cfg('site') || E'/sell/\n\nUnsubscribe: ' || cfg('site') || '/unsubscribe/?t=' || l.token); n := n + 1;
    end if;
  end loop;
  -- Past clients: monthly home value note on the 1st
  if extract(day from now() at time zone 'America/New_York') = 1 then
    for h in select * from homes loop
      perform queue_mail('homeowner_' || to_char(now(),'YYYYMM'), h.id, h.client_email, 'Your home this month: ' || split_part(h.address, ',', 1),
        'Hi ' || coalesce(split_part(h.client_name,' ',1),'there') || E',\n\n' ||
        coalesce('Your latest estimated value is $' || to_char(h.current_value,'FM999,999,999') || ' (updated ' || to_char(h.value_updated,'Mon DD, YYYY') || E').\n\n','') ||
        E'See your home dashboard, equity and Florida home reminders: ' || cfg('site') || E'/portal/\n\nWant a fresh value? Just reply.'); n := n + 1;
    end loop;
  end if;
  return n;
end $$;

-- Unsubscribe from the link in every email
create or replace function unsubscribe(p_token uuid) returns boolean language plpgsql security definer set search_path = public as $$
begin
  update leads set unsubscribed = true where token = p_token;
  update outbox set status = 'skipped' where status = 'queued' and related_id in (select id from leads where token = p_token);
  return found;
end $$;
grant execute on function unsubscribe(uuid) to anon, authenticated;

-- ---------- 7. Schedules (pg_cron): follow-ups daily at 9:05 AM New York ----------
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'mg-followups';
select cron.schedule('mg-followups', '5 14 * * *', $$select public.queue_followups()$$);
