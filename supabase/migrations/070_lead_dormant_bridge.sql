-- 070_lead_dormant_bridge.sql
--
-- Tier 4.D.1 — bridge `lead.dormant` event (emitted from sla-worker)
-- into the retention_resurrect journey.
--
-- Background: retention_resurrect was seeded in Tier 4.C (068) but
-- nothing was firing it. sla-worker transitioned leads to dormant
-- status but didn't emit an engine event. This migration plus the
-- sla-worker patch close the loop:
--   sla-worker dormant transition → emit 'lead.dormant' to engine →
--   this bridge rule matches → action `journey_start: retention_resurrect`
--   → journey-runner schedules day 0 step → 10-min tick advances.
--
-- The bridge also tracks the spec's planned-then-implemented rule
-- (B8 in the catalog moves from spec-only to actually-firing).

insert into public.automation_rules
  (code, name_he, description, trigger_event, category, source, enabled, conditions, actions, implementation_ref)
values
  ('bridge_lead_dormant_start_retention',
    'גשר: lead.dormant → התחל מסע retention_resurrect',
    'sla-worker מעביר ליד לסטטוס dormant אחרי 14+ ימי שתיקה ופולט lead.dormant. הגשר הזה מפעיל את מסע ההחייאה (3 שלבים, 21 ימים).',
    'lead.dormant', 'retention', 'engine', true,
    -- Don't start the journey if the lead is muted (DNC) or already
    -- explicitly opted out — the journey's per-step conditions catch
    -- this too, but failing early at start time is cleaner.
    jsonb_build_object(
      'all', jsonb_build_array(
        jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false)
      )
    ),
    jsonb_build_array(
      jsonb_build_object('type', 'journey_start', 'code', 'retention_resurrect')
    ),
    'engine bridge — sla-worker + journey-runner'
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

-- Also retire the now-stale placeholder bridge from 068 that
-- intended to start retention from lead.created — wrong trigger
-- per Tier 4.C reasoning. Keep the row for audit but mark planned/
-- disabled so the catalog stays honest.
update public.automation_rules
   set enabled = false,
       source = 'planned',
       description = 'נדחה: מסע retention מופעל מהטריגר lead.dormant של sla-worker, לא מ-lead.created. ראה bridge_lead_dormant_start_retention.'
 where code = 'bridge_lead_created_dormant_start_journey';
