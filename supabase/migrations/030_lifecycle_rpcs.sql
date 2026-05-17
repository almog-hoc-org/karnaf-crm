-- Karnaf CRM Core - Lifecycle dead-end fixes.
--
-- The audit flagged three lifecycle dead-ends where leads can get
-- stuck silently:
--   1. Dormant leads (sla-worker moves them after `nurtureHours * 7`
--      idle) have no re-activation path. Operators have to find them by hand.
--   2. human_handoff queue items have no TTL — if Mia is on vacation
--      the item stays pending indefinitely.
--   3. `won` leads with no portal_invite_code after grace period
--      indicate a stalled onboarding handoff nobody's watching.
--
-- This migration adds three RPCs that sla-worker (or a future cron tick)
-- can invoke each run to surface these as actionable queue items. The
-- partial unique index in migration 028 prevents duplicates across runs.

-- ── 1. Mark dormant leads for re-activation review ──────────────────────
create or replace function enqueue_dormant_reactivation_reviews(
  p_max_age_days int default 60
) returns int
language plpgsql
as $$
declare
  v_inserted int := 0;
begin
  with candidates as (
    select id
      from leads
     where lead_status = 'dormant'
       and do_not_contact = false
       and removed_by_request = false
       and updated_at < now() - make_interval(days => p_max_age_days)
       and not exists (
         select 1 from work_queue
          where work_queue.lead_id = leads.id
            and queue_type = 'dormant_reactivation_review'
            and status = 'pending'
       )
     limit 100
  )
  insert into work_queue (lead_id, queue_type, status, priority_level, queue_summary, reason, payload_json, created_by_actor_type)
  select id, 'dormant_reactivation_review', 'pending', 3,
         'Dormant ' || p_max_age_days || '+ days — review for re-activation or close',
         'Auto-enqueued by enqueue_dormant_reactivation_reviews',
         jsonb_build_object('source', 'cron', 'max_age_days', p_max_age_days),
         'system'
    from candidates;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- ── 2. human_handoff TTL — escalate stale pending items ─────────────────
create or replace function escalate_stale_handoffs(
  p_stale_after_hours int default 24
) returns int
language plpgsql
as $$
declare
  v_updated int := 0;
begin
  update work_queue
     set priority_level = 1,
         payload_json = coalesce(payload_json, '{}'::jsonb)
                        || jsonb_build_object('escalated_at', now(), 'stale_after_hours', p_stale_after_hours)
   where queue_type = 'human_handoff'
     and status = 'pending'
     and priority_level > 1
     and created_at < now() - make_interval(hours => p_stale_after_hours);
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

-- ── 3. Won-but-not-onboarded escalation ──────────────────────────────────
-- Note: requires leads.portal_invite_code column (migration 026 portal_handoff).
-- Falls back gracefully if the column doesn't exist yet — we use a dynamic
-- check via information_schema.
create or replace function enqueue_won_without_provisioning_reviews(
  p_grace_hours int default 24
) returns int
language plpgsql
as $$
declare
  v_inserted int := 0;
  v_has_portal_col boolean;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'leads' and column_name = 'portal_invite_code'
  ) into v_has_portal_col;

  if not v_has_portal_col then
    -- portal_handoff migration not applied; nothing to surface.
    return 0;
  end if;

  execute $sql$
    with candidates as (
      select id
        from leads
       where lead_status = 'won'
         and (portal_invite_code is null or portal_invite_code = '')
         and won_at < now() - make_interval(hours => $1)
         and not exists (
           select 1 from work_queue
            where work_queue.lead_id = leads.id
              and queue_type = 'won_onboarding_stalled'
              and status = 'pending'
         )
       limit 100
    )
    insert into work_queue (lead_id, queue_type, status, priority_level, queue_summary, reason, payload_json, created_by_actor_type)
    select id, 'won_onboarding_stalled', 'pending', 1,
           'Won > ' || $1 || 'h ago, no portal invite — provisioning stalled',
           'Auto-enqueued by enqueue_won_without_provisioning_reviews',
           jsonb_build_object('source', 'cron', 'grace_hours', $1),
           'system'
      from candidates
  $sql$ using p_grace_hours;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;
