-- 124_lead_journey_cursor.sql
--
-- lead-journey-manager scans `order by updated_at asc limit 200`. A lead
-- whose classification did not change is not written to, so its updated_at
-- does not move — which means the same 200 oldest-updated leads come back
-- on every single tick, forever, and lead 201 onwards is never classified
-- at all. The scan looks busy and covers a fixed prefix of the table.
--
-- A dedicated cursor column fixes it: order by it, stamp every lead the
-- scan touched, and the next tick necessarily picks up where this one
-- stopped. NULLS FIRST means leads never scanned go first.

alter table public.leads
  add column if not exists journey_scanned_at timestamptz;

comment on column public.leads.journey_scanned_at is
  'Round-robin cursor for lead-journey-manager. Stamped on every scan pass, '
  'whether or not the classification changed. Not a business field.';

create index if not exists idx_leads_journey_scan
  on public.leads (journey_scanned_at nulls first)
  where do_not_contact = false and removed_by_request = false;

-- The cursor write must NOT look like a business change. trg_leads_set_updated_at
-- (migration 004) stamps updated_at on every UPDATE, and sla-worker detects
-- dormant leads with `updated_at < dormantBreach` — so stamping 200 leads
-- every ten minutes would mean no lead is ever dormant again, and every
-- "last updated" in the UI would read as minutes ago. A leads-specific
-- trigger keeps updated_at frozen when the cursor is the only thing that
-- moved, and behaves exactly as before for every real edit.
create or replace function public.set_updated_at_leads() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new) - 'journey_scanned_at' - 'updated_at')
     = (to_jsonb(old) - 'journey_scanned_at' - 'updated_at') then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_leads_set_updated_at on public.leads;
create trigger trg_leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at_leads();
