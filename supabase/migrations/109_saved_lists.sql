-- 109_saved_lists.sql
--
-- Named, reusable audience lists. definition holds a BroadcastSegment-
-- shaped filter (source / source_campaign / primary_track /
-- product_interest, multi-slug supported) plus optional tags[]. Used by
-- the broadcast composer ("load list" / "save segment as list").

create table if not exists public.saved_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  definition jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.saved_lists enable row level security;

drop policy if exists saved_lists_staff_all on public.saved_lists;
create policy saved_lists_staff_all on public.saved_lists
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());

grant select, insert, update, delete on public.saved_lists to service_role;

drop trigger if exists saved_lists_set_updated_at on public.saved_lists;
create trigger saved_lists_set_updated_at
  before update on public.saved_lists
  for each row execute function public.set_updated_at();
