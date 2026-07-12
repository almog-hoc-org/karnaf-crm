-- 089_lead_journey_manager.sql
--
-- Recovered 2026-07-09 from production's
-- supabase_migrations.schema_migrations (the file was applied to
-- prod but never committed). Statements are verbatim as recorded
-- by the Supabase CLI at apply time.

-- 089_lead_journey_manager.sql
--
-- Registers the always-on lead journey manager. The executable logic lives in
-- automation-tick + _shared/lead-journey-manager.ts; this catalog row makes the
-- rule visible and switchable from the CRM automation surface.

insert into public.automation_rules
  (code, name_he, description, trigger_event, category, source, enabled, implementation_ref, conditions, actions)
values
  (
    'lead_journey_manager',
    'מנהל מסע ליד חכם',
    'מסווג כל ליד פעיל, פותח תורים רלוונטיים, מסלים לליווי אנושי/טלפון, ומסמן נרדם או לא רלוונטי לפי זמן וחום.',
    'cron.tick',
    'control',
    'code',
    true,
    'automation-tick + _shared/lead-journey-manager.ts',
    '{}'::jsonb,
    '[]'::jsonb
  )
on conflict (code) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  trigger_event = excluded.trigger_event,
  category = excluded.category,
  source = excluded.source,
  enabled = excluded.enabled,
  implementation_ref = excluded.implementation_ref,
  updated_at = now();
