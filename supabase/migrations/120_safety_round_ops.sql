-- 120_safety_round_ops.sql
--
-- Operational safety round: retention reapers that were written but never
-- scheduled, a table an already-deployed endpoint writes to but which was
-- never created, and the bookkeeping that stops parked replies retrying
-- forever.
--
-- 1. TWO ORPHAN REAPERS. purge_webhook_inbox (032:40) and
--    purge_expired_webhook_idempotency (035:21) both exist as functions,
--    both are documented as "nightly-jobs purges this" — and neither has
--    ever run: no cron entry, no caller anywhere in the codebase.
--    webhook_idempotency in particular grows forever (rows are only
--    filtered by expires_at at read time).
-- 2. ai_decision_reviews. supabase/functions/ai-review/index.ts has
--    shipped since Tier 3 writing to this table on every operator rating.
--    The table has no migration, so the endpoint 500s on first use. The
--    schema below is derived from the function's own upsert and select.
-- 3. pending_manual_replies gets an attempt counter and an 'expired'
--    status. Without them a reply that fails to send is re-selected and
--    re-sent on EVERY subsequent inbound message, forever, and a reply
--    parked months ago is delivered the moment the customer says hello.
-- 4. A partial index over dead-lettered dispatches, so counting them for
--    the operator alert is free.

-- ── 1. Schedule the reapers ──────────────────────────────────────────
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'karnaf_purge_webhook_inbox') then
    perform cron.schedule('karnaf_purge_webhook_inbox', '30 2 * * *',
      $cmd$ select public.purge_webhook_inbox(30); $cmd$);
  end if;
  if not exists (select 1 from cron.job where jobname = 'karnaf_purge_webhook_idempotency') then
    perform cron.schedule('karnaf_purge_webhook_idempotency', '45 * * * *',
      $cmd$ select public.purge_expired_webhook_idempotency(); $cmd$);
  end if;
end $$;

-- ── 2. Operator ratings of AI decisions ──────────────────────────────
create table if not exists public.ai_decision_reviews (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.ai_decisions(id) on delete cascade,
  operator_id uuid not null references public.profiles(id) on delete cascade,
  -- -1 bad / 0 neutral / 1 good, matching the endpoint's validation.
  rating smallint not null check (rating in (-1, 0, 1)),
  correction_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (decision_id, operator_id)
);

create index if not exists idx_ai_decision_reviews_decision
  on public.ai_decision_reviews (decision_id);
create index if not exists idx_ai_decision_reviews_operator
  on public.ai_decision_reviews (operator_id, created_at desc);

alter table public.ai_decision_reviews enable row level security;

drop policy if exists ai_decision_reviews_staff_read on public.ai_decision_reviews;
create policy ai_decision_reviews_staff_read on public.ai_decision_reviews
  for select to authenticated using (public.is_active_staff());

grant select, insert, update on public.ai_decision_reviews to service_role;

drop trigger if exists trg_ai_decision_reviews_set_updated_at on public.ai_decision_reviews;
create trigger trg_ai_decision_reviews_set_updated_at
  before update on public.ai_decision_reviews
  for each row execute function public.set_updated_at();

-- ── 3. Bound the parked-reply retry loop ─────────────────────────────
alter table public.pending_manual_replies
  add column if not exists attempts int not null default 0;

alter table public.pending_manual_replies
  drop constraint if exists pending_manual_replies_status_check;
alter table public.pending_manual_replies
  add constraint pending_manual_replies_status_check
  check (status in ('queued', 'reopen_sent', 'sent', 'failed', 'cancelled', 'expired'));

comment on column public.pending_manual_replies.attempts is
  'Send attempts made after the customer reopened the window. The flush '
  'retires a reply at 5 attempts or 14 days old (see _shared/pending-reply-policy.ts).';

-- ── 4. Dead-letter visibility ────────────────────────────────────────
create index if not exists idx_outbound_dispatch_dlq
  on public.outbound_dispatch (created_at)
  where status = 'dlq';
