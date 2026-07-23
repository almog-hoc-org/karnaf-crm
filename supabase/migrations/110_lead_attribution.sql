-- 110_lead_attribution.sql
--
-- First-class campaign attribution on leads. The website already sends
-- utm_* / landing_page / referrer (and optionally fbclid/fbp/fbc) with
-- every form submission, but until now those lived only inside
-- raw_import_snapshot jsonb and only for the first INSERT.
--
-- Semantics: the dedicated columns are FIRST-TOUCH — written once when
-- empty, never overwritten. Every later submission is kept in full in
-- last_touch jsonb (payload + touched_at), so nothing is lost.

alter table public.leads
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists utm_content text,
  add column if not exists utm_term text,
  add column if not exists landing_page text,
  add column if not exists referrer text,
  add column if not exists fbclid text,
  add column if not exists fbp text,
  add column if not exists fbc text,
  add column if not exists first_touch_at timestamptz,
  add column if not exists last_touch jsonb;

create index if not exists idx_leads_utm_campaign
  on public.leads(utm_campaign) where utm_campaign is not null;

-- Backfill from raw_import_snapshot for existing leads. coalesce keeps
-- first-touch semantics and makes the migration safe to re-run.
update public.leads set
  utm_source   = coalesce(utm_source,   nullif(raw_import_snapshot->>'utm_source', '')),
  utm_medium   = coalesce(utm_medium,   nullif(raw_import_snapshot->>'utm_medium', '')),
  utm_campaign = coalesce(utm_campaign, nullif(raw_import_snapshot->>'utm_campaign', '')),
  utm_content  = coalesce(utm_content,  nullif(raw_import_snapshot->>'utm_content', '')),
  utm_term     = coalesce(utm_term,     nullif(raw_import_snapshot->>'utm_term', '')),
  landing_page = coalesce(landing_page,
                          nullif(raw_import_snapshot->>'landing_page', ''),
                          nullif(raw_import_snapshot->>'page_path', '')),
  referrer     = coalesce(referrer,     nullif(raw_import_snapshot->>'referrer', '')),
  fbclid       = coalesce(fbclid,       nullif(raw_import_snapshot->>'fbclid', '')),
  fbp          = coalesce(fbp,          nullif(raw_import_snapshot->>'fbp', '')),
  fbc          = coalesce(fbc,          nullif(raw_import_snapshot->>'fbc', '')),
  first_touch_at = coalesce(first_touch_at, created_at)
where raw_import_snapshot ?| array[
  'utm_source','utm_medium','utm_campaign','utm_content','utm_term',
  'landing_page','page_path','referrer','fbclid','fbp','fbc'
];

-- equity arrived from the website but was never mapped to the dedicated
-- column added in 091.
update public.leads set
  estimated_equity = nullif(raw_import_snapshot->>'equity', '')
where estimated_equity is null
  and nullif(raw_import_snapshot->>'equity', '') is not null;
