-- Karnaf CRM Core - Webhook payload persistence + replay.
--
-- When a webhook handler dies (HMAC verifier bug, downstream Supabase
-- outage, malformed payload that breaks parser), the inbound is lost.
-- This table captures EVERY accepted webhook body before handler logic
-- runs, so an admin can replay it later via the webhook-replay function.
--
-- Scope:
--   * Inserted by webhook functions immediately after auth passes,
--     before any DB writes (see _shared/webhook-inbox.ts helper).
--   * Service-role only — no RLS read for operators (raw bodies may
--     include phone numbers; admin-only replay UI uses service role).
--   * 30-day retention; nightly-jobs purges. Older rows are no longer
--     useful — Meta only allows replay of recent events.

create table if not exists webhook_inbox (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  headers_json jsonb not null,
  body text not null,
  correlation_id text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_status text check (processed_status in ('success','duplicate','rate_limited','client_error','server_error','replay_failed')),
  error_message text,
  replayed_from uuid references webhook_inbox(id) on delete set null
);

create index if not exists ix_webhook_inbox_source_received
  on webhook_inbox (source, received_at desc);

create index if not exists ix_webhook_inbox_failed
  on webhook_inbox (received_at desc)
  where processed_status in ('server_error', 'replay_failed') or processed_at is null;

create index if not exists ix_webhook_inbox_correlation
  on webhook_inbox (correlation_id)
  where correlation_id is not null;

create or replace function purge_webhook_inbox(p_retention_days int default 30)
returns int
language plpgsql
as $$
declare
  v_deleted int;
begin
  delete from webhook_inbox where received_at < now() - make_interval(days => p_retention_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
