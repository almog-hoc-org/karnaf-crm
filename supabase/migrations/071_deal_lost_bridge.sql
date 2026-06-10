-- 071_deal_lost_bridge.sql
--
-- Tier 4.D.2 — bridge `deal.lost` (emitted from admin-actions/mark_lost)
-- to a 90-day re-engagement follow-up task.
--
-- A lost lead today goes silent — sla-worker excludes won/lost from
-- the dormant scan (correct: they've reached a terminal state). But
-- some lost leads are recoverable: a price objection now might be a
-- viable customer in 3 months when their financials change. The spec
-- explicitly mentions "won-back" as a strategic outcome.
--
-- The bridge creates a `re_engagement_check` task due in 90 days. The
-- task surfaces in /inbox → Mia decides whether to reach out manually
-- or leave it alone. This is intentionally a *task*, not an outbound
-- message — a 90-day-later automated nudge feels intrusive, and
-- humans should re-engage manually with context.
--
-- Skips when do_not_contact is true (terminal opt-out, no follow-up).

insert into public.automation_rules
  (code, name_he, description, trigger_event, category, source, enabled, conditions, actions, implementation_ref)
values
  ('bridge_deal_lost_followup_90d',
    'גשר: deal.lost → משימת מעקב 90 יום',
    'ליד שאבד יכול לחזור — מציאות פיננסית משתנה. הגשר יוצר משימת מעקב לעובד CRM ל-90 יום קדימה, להחלטה אנושית אם לחזור או לעזוב.',
    'deal.lost', 'retention', 'engine', true,
    jsonb_build_object(
      'all', jsonb_build_array(
        jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false)
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'type', 'create_task',
        'title', 'בדיקת re-engagement — ליד שאבד לפני 90 יום',
        'kind', 'follow_up',
        -- 90 days × 24 hours = 2160. Long-tail task — surfaces in /inbox
        -- when due. Mia decides whether to reach out.
        'due_in_hours', 2160
      )
    ),
    'engine bridge — admin-actions/mark_lost + journey-runner'
  )
on conflict (code) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  trigger_event = excluded.trigger_event,
  source = excluded.source,
  enabled = excluded.enabled,
  conditions = excluded.conditions,
  actions = excluded.actions,
  implementation_ref = excluded.implementation_ref;
