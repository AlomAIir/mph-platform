-- Change-order codes are unique per production. The database assigns the next CO-nn whenever a code is missing or
-- already taken, under a per-production lock, so Budget and Shoot Day can never create duplicates, even at the same moment.
create or replace function public.assign_change_order_code()
returns trigger language plpgsql as $$
declare v_next int;
begin
  perform pg_advisory_xact_lock(hashtext('change_orders:' || new.production_id::text));
  if new.code is null or new.code = '' or exists (
    select 1 from public.change_orders where production_id = new.production_id and code = new.code and id <> new.id
  ) then
    select coalesce(max((regexp_match(code, '^CO-(\d+)$'))[1]::int), 0) + 1 into v_next
      from public.change_orders where production_id = new.production_id;
    new.code := 'CO-' || lpad(v_next::text, 2, '0');
  end if;
  return new;
end $$;

create trigger change_orders_code before insert on public.change_orders
  for each row execute function public.assign_change_order_code();

create unique index if not exists change_orders_code_unique on public.change_orders (production_id, code);
