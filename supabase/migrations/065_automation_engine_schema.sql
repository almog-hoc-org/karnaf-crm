-- 065_automation_engine_schema.sql
--
-- Tier 4.A — make automation_rules executable, not just descriptive.
--
-- Tier 2.B + 2.C shipped a catalog + run log. Code-driven automations
-- (sla-worker, daily-sales-inbox, the deal triggers) log against the
-- catalog but the catalog doesn't drive them. The kill-switch toggle
-- on /automations works in the data layer but no code reads it.
--
-- This migration adds the two columns the engine needs:
--   * conditions (jsonb) — DSL that evaluates against a context map.
--   * actions    (jsonb) — array of {type, …} action objects.
--
-- And populates b5_program_no_purchase_24h with a working
-- conditions+actions pair so the engine has a real first rule to
-- drive. Other engine rules get filled in incrementally as we move
-- each one from 'planned' / 'code' → 'engine'.
--
-- DSL shape (recursive):
--   {"all": [<sub>...]}              — AND
--   {"any": [<sub>...]}              — OR
--   {"field": "lead.x", "op": "eq",  — leaf condition
--    "value": "..."}
-- Supported leaf ops: eq, neq, in, not_in, gte, lte, gt, lt,
--                     exists, not_exists.
--
-- Actions DSL:
--   {"type": "send_template", "key": "c2", "channel": "whatsapp"}
--   {"type": "notify_internal", "text": "..."}
--   {"type": "create_task", "title": "...", "due_in_hours": 24,
--    "kind": "..."}
--   {"type": "set_field", "table": "leads", "field": "...",
--    "value": "..."}
--   {"type": "transition_status", "to": "...", "reason": "..."}
-- Engine ignores unknown types and logs them in action_results so a
-- typo is loud, not silent.

alter table public.automation_rules
  add column if not exists conditions jsonb not null default '{}'::jsonb;
alter table public.automation_rules
  add column if not exists actions jsonb not null default '[]'::jsonb;

comment on column public.automation_rules.conditions is
  'Tier 4 DSL — recursive {all|any|field+op+value}. Empty {} = always match. Engine evaluates against the trigger context.';
comment on column public.automation_rules.actions is
  'Tier 4 DSL — array of action objects {type, ...}. Engine dispatches each in order. Unknown types log a "skipped" action.';

-- ─────────────────────────────────────────────────────────────────────
-- Populate b5 as the engine's first real rule. The trigger is the
-- cron-driven automation-tick which scans for "program leads created
-- > 24h ago, no deal won yet, not muted". Actions: send template C2,
-- then notify Mia's internal Telegram group.
--
-- The conditions reference context fields the automation-tick will
-- populate when it iterates leads:
--   lead.product_interest  — set by intake
--   lead.hours_since_intake — derived in the tick
--   lead.has_won_program   — derived in the tick
--   lead.do_not_contact    — column passthrough
-- ─────────────────────────────────────────────────────────────────────
update public.automation_rules
   set source = 'engine',
       implementation_ref = 'automation-engine + automation-tick',
       conditions = jsonb_build_object(
         'all', jsonb_build_array(
           jsonb_build_object('field', 'lead.product_interest', 'op', 'eq',  'value', 'program'),
           jsonb_build_object('field', 'lead.hours_since_intake', 'op', 'gte', 'value', 24),
           jsonb_build_object('field', 'lead.has_won_program', 'op', 'eq',  'value', false),
           jsonb_build_object('field', 'lead.do_not_contact',  'op', 'eq',  'value', false)
         )
       ),
       actions = jsonb_build_array(
         jsonb_build_object('type', 'send_template', 'key', 'c2', 'channel', 'whatsapp'),
         jsonb_build_object('type', 'notify_internal',
                            'text', 'ליד הדרך לדירה לא רכש 24ש — נשלח וידאו עדות (C2).')
       )
 where code = 'b5_program_no_purchase_24h';
