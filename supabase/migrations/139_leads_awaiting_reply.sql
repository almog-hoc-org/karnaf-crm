-- 139_leads_awaiting_reply.sql
--
-- "Still waiting for our answer" was computed in JavaScript AFTER the SQL
-- limit: sla-worker took the 500 oldest leads with last_inbound_at older
-- than the threshold, then dropped the ones already answered. In a CRM a few
-- months old the 500 oldest are all answered long ago, so the filter emptied
-- the list and a lead who wrote nine hours ago never produced an sla_risk
-- or human_handoff item. ai-watchdog and the ai_stuck scan had the same
-- shape. The predicate now lives in the row as a stored generated column,
-- so the workers filter on it before the limit, with an index.

alter table public.leads
  add column if not exists awaiting_reply boolean
  generated always as (
    last_inbound_at is not null
    and (last_outbound_at is null or last_outbound_at < last_inbound_at)
  ) stored;

comment on column public.leads.awaiting_reply is
  'Generated: the customer wrote after our last outbound (or we never wrote). The SLA, '
  'AI-stuck and watchdog scans filter on this BEFORE their row limits (migration 139).';

create index if not exists idx_leads_awaiting_reply_inbound
  on public.leads (last_inbound_at)
  where awaiting_reply;
