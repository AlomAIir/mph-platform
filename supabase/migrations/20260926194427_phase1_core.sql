-- MPH Phase 1 core schema
-- Production houses (orgs), productions, script → AI breakdown → shots → schedule → budget/bid → call sheets.
--
-- Client-safe boundary, enforced here rather than in the UI:
--   * budget_lines (internal cost, markup) are readable ONLY by org owners/producers.
--   * clients read client_bids, a separate published object with client prices only.
--   * clients never read people (crew rates), elements, shots, shoot days or call sheets.

create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------------ profiles
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  full_name text,
  phone text,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ orgs (production houses)
create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_ar text,
  city text default 'Riyadh',
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id uuid not null references public.orgs on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null default 'producer' check (role in ('owner', 'producer', 'hod', 'crew')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- ------------------------------------------------------------------ productions
create table public.productions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  title text not null,
  title_ar text,
  code text,
  client_name text,
  agency text,
  format text,
  status text not null default 'Development'
    check (status in ('Development', 'Bidding', 'Pre-production', 'Shooting', 'Post-production', 'Delivered')),
  shoot_start date,
  shoot_end date,
  delivery date,
  summary text,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- clients (and optionally outside HoDs/crew) get access to a single production
create table public.production_members (
  production_id uuid not null references public.productions on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null default 'client' check (role in ('client')),
  created_at timestamptz not null default now(),
  primary key (production_id, user_id)
);

-- pending invites. The producer shares the invite link (secret token); the invitee opens it signed in to join.
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  email text not null,
  org_id uuid references public.orgs on delete cascade,
  production_id uuid references public.productions on delete cascade,
  role text not null check (role in ('owner', 'producer', 'hod', 'crew', 'client')),
  invited_by uuid references auth.users on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((role = 'client' and production_id is not null) or (role <> 'client' and org_id is not null))
);
create index on public.invites (lower(email)) where claimed_at is null;

-- ------------------------------------------------------------------ access helpers (security definer: they read membership tables without recursion)
create or replace function public.org_role(p_org uuid)
returns text language sql stable security definer set search_path = public as $$
  select role from org_members where org_id = p_org and user_id = auth.uid()
$$;

create or replace function public.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from org_members where org_id = p_org and user_id = auth.uid())
$$;

create or replace function public.prod_org(p_prod uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from productions where id = p_prod
$$;

-- any org member of the production's house (internal team)
create or replace function public.is_team(p_prod uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from productions p join org_members m on m.org_id = p.org_id
    where p.id = p_prod and m.user_id = auth.uid()
  )
$$;

-- team members allowed to edit (owners, producers, heads of department)
create or replace function public.can_edit(p_prod uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from productions p join org_members m on m.org_id = p.org_id
    where p.id = p_prod and m.user_id = auth.uid() and m.role in ('owner', 'producer', 'hod')
  )
$$;

-- internal money: owners and producers only
create or replace function public.can_see_internal(p_prod uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from productions p join org_members m on m.org_id = p.org_id
    where p.id = p_prod and m.user_id = auth.uid() and m.role in ('owner', 'producer')
  )
$$;

create or replace function public.is_client(p_prod uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from production_members where production_id = p_prod and user_id = auth.uid() and role = 'client')
$$;

-- ------------------------------------------------------------------ scripts, scenes, elements
create table public.scripts (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  version int not null default 1,
  title text,
  language text default 'ar+en',
  source_type text not null default 'text' check (source_type in ('text', 'pdf', 'docx')),
  file_path text,               -- storage path in the "scripts" bucket
  raw_text text,
  locked boolean not null default false,
  breakdown_status text not null default 'none' check (breakdown_status in ('none', 'running', 'done', 'failed')),
  breakdown_at timestamptz,
  breakdown_notes text,
  runtime_seconds int,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  unique (production_id, version)
);

create table public.shoot_days (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  day_no int not null,
  date date,
  location text,
  crew_call time,
  wrap time,
  notes text,
  created_at timestamptz not null default now()
);

create table public.scenes (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  script_id uuid references public.scripts on delete cascade,
  num text not null,
  heading text,
  int_ext text check (int_ext in ('INT', 'EXT', 'INT/EXT')),
  day_night text,
  location text,
  synopsis text,
  body text,                    -- the scene's script text, verbatim
  pages_eighths int default 1,
  est_minutes int default 60,
  sort int not null default 0,
  shoot_day_id uuid references public.shoot_days on delete set null,
  day_sort int not null default 0,
  created_at timestamptz not null default now()
);

-- scenes of each production's current script: the latest version with a finished breakdown.
-- Screens read this so an older version's scenes never show up twice. security_invoker keeps the scenes RLS.
create view public.active_scenes with (security_invoker = on) as
  select s.* from public.scenes s
  where s.script_id is null
     or s.script_id = (
       select sc.id from public.scripts sc
       where sc.production_id = s.production_id and sc.breakdown_status = 'done'
       order by sc.version desc limit 1
     );

create table public.elements (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  scene_id uuid not null references public.scenes on delete cascade,
  category text not null check (category in ('cast', 'extras', 'props', 'wardrobe', 'makeup', 'vehicles', 'location', 'sfx', 'equipment', 'animals', 'sound', 'vfx', 'stunts')),
  name text not null,
  qty int not null default 1,
  status text not null default 'suggested' check (status in ('suggested', 'accepted')),
  confidence numeric,
  source_quote text,
  reason text,
  ai boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.shots (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  scene_id uuid references public.scenes on delete cascade,
  code text,
  size text,
  angle text,
  movement text,
  lens text,
  description text,
  subject text,
  setup int,
  est_minutes int default 15,
  done boolean not null default false,
  ai boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ people on the job
create table public.people (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  name text not null,
  role text,
  dept text,
  kind text not null default 'crew' check (kind in ('crew', 'talent', 'extra', 'client', 'vendor')),
  phone text,
  email text,
  default_call time,
  days int,
  status text not null default 'confirmed' check (status in ('confirmed', 'hold', 'invited')),
  notes text,
  created_at timestamptz not null default now()
);

-- day rates live in their own table: RLS can't hide one column, so rates get a table only owners/producers can read.
-- Read them embedded: people.select('*, people_rates(day_rate)') returns null for everyone else.
create table public.people_rates (
  person_id uuid primary key references public.people on delete cascade,
  production_id uuid not null references public.productions on delete cascade,
  day_rate numeric check (day_rate >= 0),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ money: internal lines vs client bid
create table public.budget_lines (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  category text not null,       -- A..J commercial bid categories
  code text,
  description text not null,
  qty numeric not null default 1,
  unit text default 'flat',
  unit_cost numeric not null default 0,
  markup_pct numeric not null default 20,
  notes text,
  ai boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table public.client_bids (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  version int not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'approved', 'changes_requested')),
  lines jsonb not null default '[]',  -- [{category, label, amount}] client prices only
  subtotal numeric not null default 0,
  vat numeric not null default 0,
  total numeric not null default 0,
  note text,
  client_note text,
  sent_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  unique (production_id, version)
);

-- ------------------------------------------------------------------ call sheets (crew open them by link, no account needed)
create table public.call_sheets (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  shoot_day_id uuid references public.shoot_days on delete cascade,
  version int not null default 1,
  status text not null default 'draft' check (status in ('draft', 'published')),
  share_token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  content jsonb not null default '{}',  -- snapshot rendered to recipients at publish time (no rates, no costs)
  notes text,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.call_sheet_responses (
  id uuid primary key default gen_random_uuid(),
  call_sheet_id uuid not null references public.call_sheets on delete cascade,
  person_id uuid references public.people on delete cascade,
  name text,
  status text not null check (status in ('viewed', 'confirmed', 'declined')),
  responded_at timestamptz not null default now()
);
create index on public.call_sheet_responses (call_sheet_id);

-- ------------------------------------------------------------------ updated_at
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger productions_touch before update on public.productions for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ Row Level Security
alter table public.profiles enable row level security;
alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.productions enable row level security;
alter table public.production_members enable row level security;
alter table public.invites enable row level security;
alter table public.scripts enable row level security;
alter table public.shoot_days enable row level security;
alter table public.scenes enable row level security;
alter table public.elements enable row level security;
alter table public.shots enable row level security;
alter table public.people enable row level security;
alter table public.people_rates enable row level security;
alter table public.budget_lines enable row level security;
alter table public.client_bids enable row level security;
alter table public.call_sheets enable row level security;
alter table public.call_sheet_responses enable row level security;

-- profiles: yourself, plus people you share a house or production with
create policy profiles_self on public.profiles for all using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_colleagues on public.profiles for select using (
  exists (select 1 from org_members a join org_members b on a.org_id = b.org_id where a.user_id = auth.uid() and b.user_id = profiles.id)
  or exists (select 1 from production_members pm join productions p on p.id = pm.production_id
             where pm.user_id = profiles.id and public.is_team(p.id))
);

-- orgs
create policy orgs_read on public.orgs for select using (public.is_org_member(id));
create policy orgs_update on public.orgs for update using (public.org_role(id) = 'owner');

-- org members: read your houses' rosters; owners manage
create policy org_members_read on public.org_members for select using (public.is_org_member(org_id));
create policy org_members_manage on public.org_members for all using (public.org_role(org_id) = 'owner') with check (public.org_role(org_id) = 'owner');

-- productions: team sees all; clients see only productions they were added to
create policy productions_read on public.productions for select using (public.is_org_member(org_id) or public.is_client(id));
create policy productions_insert on public.productions for insert with check (public.org_role(org_id) in ('owner', 'producer'));
create policy productions_update on public.productions for update using (public.org_role(org_id) in ('owner', 'producer'));
create policy productions_delete on public.productions for delete using (public.org_role(org_id) = 'owner');

create policy production_members_read on public.production_members for select using (public.is_team(production_id) or user_id = auth.uid());
create policy production_members_manage on public.production_members for all using (public.can_see_internal(production_id)) with check (public.can_see_internal(production_id));

create policy invites_manage on public.invites for all
  using (coalesce(public.org_role(org_id), '') in ('owner', 'producer') or public.can_see_internal(production_id))
  with check (coalesce(public.org_role(org_id), '') in ('owner', 'producer') or public.can_see_internal(production_id));

-- scripts: team reads/edits; clients can read the script text (read only)
create policy scripts_read on public.scripts for select using (public.is_team(production_id) or public.is_client(production_id));
create policy scripts_write on public.scripts for all using (public.can_edit(production_id)) with check (public.can_edit(production_id));

-- scenes: team; clients may read scene list (headings/synopsis appear in the script view)
create policy scenes_read on public.scenes for select using (public.is_team(production_id) or public.is_client(production_id));
create policy scenes_write on public.scenes for all using (public.can_edit(production_id)) with check (public.can_edit(production_id));

-- internal production detail: the whole team reads; only owners/producers/HoDs insert, update or delete
do $$
declare t text;
begin
  foreach t in array array['elements', 'shots', 'shoot_days', 'people', 'call_sheets'] loop
    execute format('create policy %1$s_read on public.%1$s for select using (public.is_team(production_id))', t);
    execute format('create policy %1$s_insert on public.%1$s for insert with check (public.can_edit(production_id))', t);
    execute format('create policy %1$s_update on public.%1$s for update using (public.can_edit(production_id)) with check (public.can_edit(production_id))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete using (public.can_edit(production_id))', t);
  end loop;
end $$;

-- day rates: owners and producers only
create policy people_rates_internal on public.people_rates for all
  using (public.can_see_internal(production_id)) with check (public.can_see_internal(production_id));
create policy call_sheet_responses_team on public.call_sheet_responses for select using (
  exists (select 1 from call_sheets c where c.id = call_sheet_id and public.is_team(c.production_id))
);

-- internal money: owners and producers ONLY (not HoDs, crew or clients)
create policy budget_lines_internal on public.budget_lines for all
  using (public.can_see_internal(production_id)) with check (public.can_see_internal(production_id));

-- client bids: producers manage; clients read anything already sent to them
create policy client_bids_internal on public.client_bids for all
  using (public.can_see_internal(production_id)) with check (public.can_see_internal(production_id));
create policy client_bids_client_read on public.client_bids for select
  using (public.is_client(production_id) and status <> 'draft');

-- ------------------------------------------------------------------ RPCs
-- first-run: create a production house and become its owner
create or replace function public.create_org(p_name text, p_name_ar text default null, p_city text default 'Riyadh')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into orgs (name, name_ar, city, created_by) values (p_name, p_name_ar, p_city, auth.uid()) returning id into v_org;
  insert into org_members (org_id, user_id, role) values (v_org, auth.uid(), 'owner');
  return v_org;
end $$;

-- accept an invite by its secret token (the invite link). Returns where to go next.
create or replace function public.accept_invite(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r invites%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into r from invites where token = p_token;
  if r.id is null then raise exception 'This invite link is not valid.'; end if;
  if r.claimed_at is not null then raise exception 'This invite has already been used.'; end if;
  if r.role = 'client' then
    insert into production_members (production_id, user_id, role) values (r.production_id, auth.uid(), 'client') on conflict do nothing;
  else
    insert into org_members (org_id, user_id, role) values (r.org_id, auth.uid(), r.role)
      on conflict (org_id, user_id) do update set role = excluded.role;
  end if;
  update invites set claimed_at = now() where id = r.id;
  return jsonb_build_object('role', r.role, 'org_id', r.org_id, 'production_id', r.production_id);
end $$;

-- invite preview for the join screen (who invited you to what), by token
create or replace function public.invite_info(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'role', i.role, 'email', i.email, 'used', i.claimed_at is not null,
    'org', (select name from orgs where id = coalesce(i.org_id, (select org_id from productions where id = i.production_id))),
    'production', (select title from productions where id = i.production_id)
  ) from invites i where i.token = p_token
$$;

-- client decision on a sent bid
create or replace function public.decide_bid(p_bid uuid, p_decision text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_prod uuid;
begin
  if p_decision not in ('approved', 'changes_requested') then raise exception 'invalid decision'; end if;
  select production_id into v_prod from client_bids b where b.id = p_bid and b.status = 'sent'
    and b.version = (select max(version) from client_bids where production_id = b.production_id and status <> 'draft');
  if v_prod is null then raise exception 'This bid is no longer awaiting a decision. Open the latest version.'; end if;
  if not (public.is_client(v_prod) or public.can_see_internal(v_prod)) then raise exception 'not allowed'; end if;
  update client_bids set status = p_decision, client_note = p_note, decided_at = now(), decided_by = auth.uid() where id = p_bid;
end $$;

-- public call sheet by link (no account): returns only the published snapshot
create or replace function public.get_call_sheet(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', c.id, 'version', c.version, 'published_at', c.published_at, 'content', c.content,
    'production', jsonb_build_object('title', p.title, 'title_ar', p.title_ar, 'client', p.client_name)
  )
  from call_sheets c join productions p on p.id = c.production_id
  where c.share_token = p_token and c.status = 'published'
$$;

create or replace function public.respond_call_sheet(p_token text, p_person uuid, p_name text, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare v_sheet uuid;
begin
  if p_status not in ('viewed', 'confirmed', 'declined') then raise exception 'invalid status'; end if;
  select id into v_sheet from call_sheets where share_token = p_token and status = 'published';
  if v_sheet is null then raise exception 'call sheet not found'; end if;
  insert into call_sheet_responses (call_sheet_id, person_id, name, status) values (v_sheet, p_person, left(p_name, 120), p_status);
end $$;

grant execute on function public.get_call_sheet(text) to anon, authenticated;
grant execute on function public.respond_call_sheet(text, uuid, text, text) to anon, authenticated;
revoke execute on function public.create_org(text, text, text) from anon;
revoke execute on function public.accept_invite(text) from anon;
grant execute on function public.invite_info(text) to anon, authenticated;
revoke execute on function public.decide_bid(uuid, text, text) from anon;

-- profile row on sign-up, and claim invites straight away
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name) values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------ storage: private bucket for script files, path = <production_id>/<file>
insert into storage.buckets (id, name, public) values ('scripts', 'scripts', false) on conflict (id) do nothing;

create policy scripts_bucket_read on storage.objects for select
  using (bucket_id = 'scripts' and public.is_team(((storage.foldername(name))[1])::uuid));
create policy scripts_bucket_write on storage.objects for insert
  with check (bucket_id = 'scripts' and public.can_edit(((storage.foldername(name))[1])::uuid));
create policy scripts_bucket_delete on storage.objects for delete
  using (bucket_id = 'scripts' and public.can_edit(((storage.foldername(name))[1])::uuid));
