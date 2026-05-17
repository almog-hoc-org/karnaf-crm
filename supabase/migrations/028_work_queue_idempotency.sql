-- Karnaf CRM Core - Work queue idempotency + leads dormant-scan index.
--
-- 1) Partial unique index on (lead_id, queue_type) for pending rows so
--    overlapping sla-worker invocations can't duplicate queue items.
--    `ensurePendingQueueItem` was the only application-side dedup; this
--    adds a DB-level guarantee.
-- 2) sla-worker filters leads on (lead_status IN ('nurture','responded'))
--    AND updated_at < <threshold>. At 10k+ leads this becomes a table
--    scan; compound index covers both columns.

create unique index if not exists work_queue_pending_dedupe
  on work_queue (lead_id, queue_type)
  where status = 'pending';

create index if not exists ix_leads_status_updated_at
  on leads (lead_status, updated_at);
