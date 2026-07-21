-- 108_landing_pages.sql
--
-- In-system landing pages: a config row per page, served publicly by the
-- Vercel edge function /api/lp/{slug} (SSR from this table via the anon
-- key) and posting registrations into website-leads-intake with the
-- page's campaign slug. Copy-only table — NEVER store secrets here, the
-- anon role can read active rows.

create table if not exists public.landing_pages (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  title text not null,
  headline text not null,
  subheadline text,
  body_md text,
  cta_label text not null default 'רוצה שיחזרו אליי',
  campaign text not null,
  source text not null default 'landing_page',
  form_config jsonb not null default '{"fields": ["name", "phone", "email"]}'::jsonb,
  theme jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.landing_pages enable row level security;

drop policy if exists landing_pages_staff_all on public.landing_pages;
create policy landing_pages_staff_all on public.landing_pages
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());

-- Public read of ACTIVE pages only — the edge renderer uses the anon key.
drop policy if exists landing_pages_public_read on public.landing_pages;
create policy landing_pages_public_read on public.landing_pages
  for select to anon
  using (active);

grant select, insert, update, delete on public.landing_pages to service_role;

drop trigger if exists landing_pages_set_updated_at on public.landing_pages;
create trigger landing_pages_set_updated_at
  before update on public.landing_pages
  for each row execute function public.set_updated_at();
