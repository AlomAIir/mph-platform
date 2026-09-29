-- Remaining pre-production and production modules:
-- Treatment & Lookbook, Storyboard, Calendar, Locations, Shoot Day (attendance, day log, change orders, receipts),
-- Documents, and a per-workspace rate card for budget drafts.
--
-- Client boundary, as before: clients read only what is explicitly shared or sent to them. Internal money
-- (change-order cost, receipts, rate cards) sits in tables clients can't read at all.

-- ------------------------------------------------------------------ shared media storage
-- path: <production_id>/client/...   files a client may see once the row that references them is shared
--       <production_id>/internal/...  team only (receipts, internal documents)
insert into storage.buckets (id, name, public) values ('media', 'media', false) on conflict (id) do nothing;

create policy media_read on storage.objects for select using (
  bucket_id = 'media' and (
    public.is_team(((storage.foldername(name))[1])::uuid)
    or (public.is_client(((storage.foldername(name))[1])::uuid) and (storage.foldername(name))[2] = 'client')
  ));
create policy media_write on storage.objects for insert
  with check (bucket_id = 'media' and public.can_edit(((storage.foldername(name))[1])::uuid));
create policy media_delete on storage.objects for delete
  using (bucket_id = 'media' and public.can_edit(((storage.foldername(name))[1])::uuid));

-- ------------------------------------------------------------------ sharing switches on a production
alter table public.productions
  add column if not exists share_storyboard boolean not null default false,
  add column if not exists share_calendar boolean not null default true;

-- ------------------------------------------------------------------ Treatment & Lookbook
create table public.treatments (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  version int not null,
  title text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'approved', 'changes_requested')),
  sections jsonb not null default '[]',      -- [{ id, title, body }]
  note text,                                  -- producer's note to the client
  client_note text,
  sent_at timestamptz, decided_at timestamptz, decided_by uuid references auth.users on delete set null,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (production_id, version)
);
create trigger treatments_touch before update on public.treatments for each row execute function public.touch_updated_at();

create table public.lookbook_items (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  board text not null default 'Mood',
  kind text not null default 'image' check (kind in ('image', 'note', 'color')),
  image_path text,                            -- media bucket, under <pid>/client/lookbook/
  caption text,
  body text,
  color text,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ Storyboard
create table public.storyboard_frames (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  scene_id uuid references public.scenes on delete set null,
  shot_id uuid references public.shots on delete set null,
  image_path text,                            -- media bucket, under <pid>/client/storyboard/
  title text,
  description text,
  shot_size text,
  movement text,
  label text,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ Calendar
create table public.events (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  title text not null,
  type text not null default 'meeting' check (type in ('prep', 'recce', 'casting', 'fitting', 'meeting', 'shoot', 'travel', 'post', 'review', 'delivery', 'other')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  location text,
  notes text,
  attendees text[] not null default '{}',
  internal boolean not null default false,    -- internal events never reach clients
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);
create index on public.events (production_id, starts_at);

-- ------------------------------------------------------------------ Locations
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  name text not null,
  kind text,
  address text,
  maps_url text,
  contact_name text,
  contact_phone text,
  permit_status text not null default 'needed' check (permit_status in ('not_needed', 'needed', 'applied', 'approved', 'refused')),
  permit_ref text,
  permit_notes text,
  parking text,
  nearest_hospital text,
  power text,
  access_notes text,
  notes text,
  photo_paths text[] not null default '{}',   -- media bucket, under <pid>/internal/locations/
  created_at timestamptz not null default now()
);
alter table public.shoot_days add column if not exists location_id uuid references public.locations on delete set null;

-- ------------------------------------------------------------------ Shoot Day: attendance, day log
create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  shoot_day_id uuid not null references public.shoot_days on delete cascade,
  person_id uuid not null references public.people on delete cascade,
  status text not null default 'in' check (status in ('in', 'late', 'absent', 'released')),
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  method text default 'manual',
  note text,
  unique (shoot_day_id, person_id)
);

create table public.day_logs (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  shoot_day_id uuid not null references public.shoot_days on delete cascade,
  at timestamptz not null default now(),
  kind text not null default 'note' check (kind in ('note', 'call', 'first_shot', 'meal', 'wrap', 'delay', 'incident', 'move')),
  body text not null,
  created_by uuid references auth.users on delete set null
);

-- ------------------------------------------------------------------ change orders: client-facing price, internal cost kept apart
create table public.change_orders (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  shoot_day_id uuid references public.shoot_days on delete set null,
  code text,
  title text not null,
  reason text,
  price numeric not null default 0,           -- what the client pays
  status text not null default 'draft' check (status in ('draft', 'sent', 'approved', 'declined')),
  client_note text,
  sent_at timestamptz, decided_at timestamptz, decided_by uuid references auth.users on delete set null,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);
create table public.change_order_costs (
  change_order_id uuid primary key references public.change_orders on delete cascade,
  production_id uuid not null references public.productions on delete cascade,
  cost numeric not null default 0             -- internal cost: owners/producers only
);

-- ------------------------------------------------------------------ receipts (AI-read, internal)
create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  shoot_day_id uuid references public.shoot_days on delete set null,
  image_path text,                            -- media bucket, under <pid>/internal/receipts/
  vendor text,
  vat_number text,
  receipt_date date,
  total numeric,
  vat numeric,
  lines jsonb not null default '[]',
  budget_line_id uuid references public.budget_lines on delete set null,
  status text not null default 'read' check (status in ('uploaded', 'read', 'matched', 'unmatched')),
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ Documents
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions on delete cascade,
  folder text not null default 'other' check (folder in ('contracts', 'releases', 'permits', 'insurance', 'client', 'other')),
  name text not null,
  doc_type text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'signed', 'approved', 'expired')),
  parties text,
  file_path text,                             -- media bucket: <pid>/client/docs/ if shared, else <pid>/internal/docs/
  signed_on date,
  expires_on date,
  notes text,
  client_shared boolean not null default false,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ rate card: a workspace's real rates, used by the budget AI
create table public.rate_cards (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  category text not null default 'B',         -- A..J bid category
  item text not null,
  unit text not null default 'day',
  rate numeric not null default 0,
  who text,                                   -- supplier or person, when known
  notes text,
  source text,                                -- e.g. "Actual budget: Tawuniya, Jan 2026"
  created_at timestamptz not null default now()
);
create index on public.rate_cards (org_id);

-- ------------------------------------------------------------------ Row Level Security
alter table public.treatments enable row level security;
alter table public.lookbook_items enable row level security;
alter table public.storyboard_frames enable row level security;
alter table public.events enable row level security;
alter table public.locations enable row level security;
alter table public.attendance enable row level security;
alter table public.day_logs enable row level security;
alter table public.change_orders enable row level security;
alter table public.change_order_costs enable row level security;
alter table public.receipts enable row level security;
alter table public.documents enable row level security;
alter table public.rate_cards enable row level security;

-- team read / editors write, for plain production tables
do $$
declare t text;
begin
  foreach t in array array['treatments', 'lookbook_items', 'storyboard_frames', 'events', 'locations', 'attendance', 'day_logs', 'change_orders', 'documents'] loop
    execute format('create policy %1$s_read on public.%1$s for select using (public.is_team(production_id))', t);
    execute format('create policy %1$s_insert on public.%1$s for insert with check (public.can_edit(production_id))', t);
    execute format('create policy %1$s_update on public.%1$s for update using (public.can_edit(production_id)) with check (public.can_edit(production_id))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete using (public.can_edit(production_id))', t);
  end loop;
end $$;

-- what clients may read
create policy treatments_client on public.treatments for select using (public.is_client(production_id) and status <> 'draft');
create policy lookbook_client on public.lookbook_items for select using (
  public.is_client(production_id) and exists (select 1 from public.treatments t where t.production_id = lookbook_items.production_id and t.status <> 'draft'));
create policy storyboard_client on public.storyboard_frames for select using (
  public.is_client(production_id) and exists (select 1 from public.productions p where p.id = storyboard_frames.production_id and p.share_storyboard));
create policy events_client on public.events for select using (
  public.is_client(production_id) and not internal and exists (select 1 from public.productions p where p.id = events.production_id and p.share_calendar));
create policy change_orders_client on public.change_orders for select using (public.is_client(production_id) and status <> 'draft');
create policy documents_client on public.documents for select using (public.is_client(production_id) and client_shared);

-- internal money
create policy change_order_costs_internal on public.change_order_costs for all
  using (public.can_see_internal(production_id)) with check (public.can_see_internal(production_id));
create policy receipts_read on public.receipts for select using (public.can_see_internal(production_id) or created_by = auth.uid());
create policy receipts_insert on public.receipts for insert with check (public.can_edit(production_id));
create policy receipts_update on public.receipts for update using (public.can_see_internal(production_id)) with check (public.can_see_internal(production_id));
create policy receipts_delete on public.receipts for delete using (public.can_see_internal(production_id));
create policy rate_cards_internal on public.rate_cards for all
  using (coalesce(public.org_role(org_id), '') in ('owner', 'producer')) with check (coalesce(public.org_role(org_id), '') in ('owner', 'producer'));

-- ------------------------------------------------------------------ client decisions
create or replace function public.decide_treatment(p_id uuid, p_decision text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_prod uuid;
begin
  if p_decision not in ('approved', 'changes_requested') then raise exception 'invalid decision'; end if;
  select production_id into v_prod from treatments t where t.id = p_id and t.status = 'sent'
    and t.version = (select max(version) from treatments where production_id = t.production_id and status <> 'draft');
  if v_prod is null then raise exception 'This treatment is no longer awaiting a decision. Open the latest version.'; end if;
  if not (public.is_client(v_prod) or public.can_see_internal(v_prod)) then raise exception 'not allowed'; end if;
  update treatments set status = p_decision, client_note = p_note, decided_at = now(), decided_by = auth.uid() where id = p_id;
end $$;

create or replace function public.decide_change_order(p_id uuid, p_decision text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_prod uuid;
begin
  if p_decision not in ('approved', 'declined') then raise exception 'invalid decision'; end if;
  select production_id into v_prod from change_orders where id = p_id and status = 'sent';
  if v_prod is null then raise exception 'This change order is not awaiting a decision.'; end if;
  if not (public.is_client(v_prod) or public.can_see_internal(v_prod)) then raise exception 'not allowed'; end if;
  update change_orders set status = p_decision, client_note = p_note, decided_at = now(), decided_by = auth.uid() where id = p_id;
end $$;

revoke execute on function public.decide_treatment(uuid, text, text) from anon;
revoke execute on function public.decide_change_order(uuid, text, text) from anon;
