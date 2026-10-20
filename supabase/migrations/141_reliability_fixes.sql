-- 141_reliability_fixes.sql
--
-- Four small data-layer fixes from the 2026-10-17 audit.
--
-- 1. 124 replaced the leads updated_at trigger with set_updated_at_leads()
--    and dropped 121's `karnaf.skip_touch_updated_at` opt-out on the way,
--    so apply_lead_score_decay (which sets that GUC) bumped updated_at on
--    every lead again each night — "last updated: 2 hours ago" on leads
--    nobody touched, and pii-delete's stale-confirm token invalidated
--    nightly.
-- 2. broadcast_recipients had no index on lead_id, which applyOptOut, the
--    merge and lead deletion all filter on.
-- 3. ig-webhook dedupes Instagram senders by (external_source, external_id)
--    with a read-then-insert and no unique index; two retries of the same
--    event created two leads.
-- 4. broadcasts.pause_baseline: a broadcast auto-paused for failure rate
--    was re-paused on the first tick after "retry" because the guard read
--    cumulative counts. The retry action records the counts at retry time
--    and the guard measures the delta.
-- 5. pending_manual_replies.claimed_at: whatsapp-webhook flushed parked
--    replies with select → send → update, so two inbound messages seconds
--    apart sent the same reply twice. The flush now claims a row with a
--    conditional UPDATE on claimed_at before sending.

create or replace function public.set_updated_at_leads() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('karnaf.skip_touch_updated_at', true), '') = 'on' then
    return new;
  end if;
  if (to_jsonb(new) - 'journey_scanned_at' - 'updated_at' - 'awaiting_reply')
     = (to_jsonb(old) - 'journey_scanned_at' - 'updated_at' - 'awaiting_reply') then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end $$;

create index if not exists idx_broadcast_recipients_lead
  on public.broadcast_recipients (lead_id);

-- Partial unique: only rows that carry an external identity. Existing
-- duplicates (if any) would make this fail, so they are parked first.
-- Which row keeps the identity matters: the next DM from that sender lands
-- on it. A lead merge_leads already parked (lead_status 'duplicate',
-- do_not_contact) must never win — a message routed there is suppressed
-- and invisible — so parked rows lose the identity first; among live rows
-- the one with the conversation history keeps it (most messages, then a
-- real phone/email, then the oldest), and the others are noted for the
-- merge queue the owner already uses. Housekeeping, not a customer touch:
-- updated_at is left alone (karnaf.skip_touch_updated_at).
do $$
declare
  d record;
begin
  perform set_config('karnaf.skip_touch_updated_at', 'on', true);
  update public.leads
     set external_id = null,
         notes_internal = concat_ws(E'\n', notes_internal, 'migration 141: external identity cleared from a merged duplicate')
   where lead_status = 'duplicate'
     and external_source is not null and external_id is not null;
  for d in
    select id from (
      select l.id,
             row_number() over (
               partition by l.external_source, l.external_id
               order by (select count(*) from public.messages m where m.lead_id = l.id) desc,
                        (l.phone is not null or l.email is not null) desc,
                        l.created_at asc
             ) as rn
      from public.leads l
      where l.external_source is not null and l.external_id is not null
    ) x where rn > 1
  loop
    update public.leads
       set external_id = null,
           notes_internal = concat_ws(E'\n', notes_internal, 'migration 141: duplicate external identity cleared — merge into the lead that kept it (same sender)')
     where id = d.id;
  end loop;
  perform set_config('karnaf.skip_touch_updated_at', '', true);
end $$;

create unique index if not exists ux_leads_external_identity
  on public.leads (external_source, external_id)
  where external_source is not null and external_id is not null;

alter table public.broadcasts
  add column if not exists pause_baseline jsonb;

alter table public.pending_manual_replies
  add column if not exists claimed_at timestamptz;

comment on column public.pending_manual_replies.claimed_at is
  'Set by the flush that is about to send this reply; a claim older than two minutes is '
  'considered abandoned. Prevents two concurrent inbound webhooks from sending it twice.';

comment on column public.broadcasts.pause_baseline is
  '{sent, failed} counts at the moment of the last "retry". The failure-rate pause guard '
  'measures from here, not from zero, so a retried campaign is not re-paused by its own history.';
