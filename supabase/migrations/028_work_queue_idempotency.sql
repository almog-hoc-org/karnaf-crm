-- Karnaf CRM Core - Work queue idempotency + leads dormant-scan index.
--
-- Two concerns addressed:
--
-- 1) Without a uniqueness constraint on (lead_id, queue_type) for pending
--    rows, overlapping sla-worker invocations (e.g. cron tick + manual
--    re-run, or one tick taking 8 min while the next fires at 10 min) can
--    insert duplicate queue items for the same lead. `ensurePendingQueueItem`
--    is the only application-side dedup, but it races. A partial unique
--    index gives us a DB-level guarantee.
--
-- 2) The sla-worker dormant scan filters by `lead_status IN (...) AND
--    updated_at < <breach>`. At 10k+ leads, without a matching index, this
--    becomes a table scan on every cron tick. Add a compound index.
--
-- Both are additive and reversible — no data rewrite.

-- ── 1. Pending queue-item dedupe ───────────────────────────────────────────
-- Allow many resolved/escalated/cancelled rows for the same (lead, type),
-- but only one pending row at a time.
create unique index if not exists work_queue_pending_dedupe
  on work_queue (lead_id, queue_type)
  where status = 'pending';

-- ── 2. Dormant-scan index ─────────────────────────────────────────────────
-- sla-worker filters leads on (lead_status IN ('nurture','responded'))
-- AND updated_at < <threshold>. Compound index covers both columns.
create index if not exists ix_leads_status_updated_at
  on leads (lead_status, updated_at);
