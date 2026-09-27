-- Onboarding: anyone in the industry can join, as an individual or a company, with their professions.
alter table public.profiles
  add column if not exists account_type text check (account_type in ('individual', 'company')),
  add column if not exists professions text[] not null default '{}',
  add column if not exists company_name text,
  add column if not exists onboarded_at timestamptz;

-- a workspace (org) belongs to a company, or is an individual's own workspace
alter table public.orgs
  add column if not exists kind text not null default 'company' check (kind in ('company', 'individual')),
  add column if not exists services text[] not null default '{}';

drop function if exists public.create_org(text, text, text);
create or replace function public.create_org(p_name text, p_name_ar text default null, p_city text default 'Riyadh',
                                             p_kind text default 'company', p_services text[] default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_kind not in ('company', 'individual') then raise exception 'invalid workspace kind'; end if;
  insert into orgs (name, name_ar, city, created_by, kind, services)
    values (p_name, p_name_ar, p_city, auth.uid(), p_kind, coalesce(p_services, '{}')) returning id into v_org;
  insert into org_members (org_id, user_id, role) values (v_org, auth.uid(), 'owner');
  return v_org;
end $$;
revoke execute on function public.create_org(text, text, text, text, text[]) from anon;
