-- 068_engine_bridges_and_more_journeys.sql
--
-- Tier 4.C — wire engine + journeys into reality.
--
-- Two pieces here:
--   1. A bridge automation rule that translates `deal.won` events
--      (emitted from admin-actions/mark_won in this Tier) into a
--      journey_start for the right journey based on deal.track.
--   2. Two more journey definitions from spec § ח: investor
--      mentorship kickoff + retention resurrect. Schema from 067
--      already supports them — this migration is data only.

-- ─────────────────────────────────────────────────────────────────────
-- Bridge rules — small, focused, one per (event, track) pairing.
-- Easy to disable a single bridge from /automations without
-- affecting the others.
-- ─────────────────────────────────────────────────────────────────────
insert into public.automation_rules
  (code, name_he, description, trigger_event, category, source, enabled, conditions, actions, implementation_ref)
values
  ('bridge_deal_won_program_start_journey',
    'גשר: deal.won + תוכנית הליווי → התחל מסע יום-14',
    'ברגע שעסקת program נסגרת, יוצר ריצה למסע program_14d',
    'deal.won', 'sales', 'engine', true,
    jsonb_build_object(
      'all', jsonb_build_array(
        jsonb_build_object('field', 'deal.track', 'op', 'eq', 'value', 'program')
      )
    ),
    jsonb_build_array(
      jsonb_build_object('type', 'journey_start', 'code', 'program_14d')
    ),
    'engine bridge — admin-actions/mark_won + journey-runner'
  ),
  ('bridge_deal_won_investor_start_journey',
    'גשר: deal.won + ליווי משקיעים → התחל מסע קיק-אוף',
    'ברגע שעסקת investor_mentorship נסגרת, יוצר ריצה למסע investor_mentorship_kickoff',
    'deal.won', 'sales', 'engine', true,
    jsonb_build_object(
      'all', jsonb_build_array(
        jsonb_build_object('field', 'deal.track', 'op', 'eq', 'value', 'investor_mentorship')
      )
    ),
    jsonb_build_array(
      jsonb_build_object('type', 'journey_start', 'code', 'investor_mentorship_kickoff')
    ),
    'engine bridge — admin-actions/mark_won + journey-runner'
  ),
  ('bridge_lead_created_dormant_start_journey',
    'גשר: lead.created + לא רכש → טריגר למסע retention',
    'מסע retention מופעל בקרון tick אחרי X ימי שתיקה, לא מ-lead.created. כלל זה נשאר בתכנון.',
    'lead.created', 'nurture', 'planned', false,
    '{}'::jsonb,
    '[]'::jsonb,
    null
  )
on conflict (code) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  trigger_event = excluded.trigger_event,
  category = excluded.category,
  source = excluded.source,
  conditions = excluded.conditions,
  actions = excluded.actions,
  implementation_ref = excluded.implementation_ref;

-- ─────────────────────────────────────────────────────────────────────
-- investor_mentorship_kickoff — 21-day journey after closing a
-- ליווי משקיעים deal. Pairs the buyer with their assigned partner,
-- nudges the first meeting, then checks in mid-program.
-- Templates referenced: c6 (intro to partner), c9 (meeting reminder).
-- ─────────────────────────────────────────────────────────────────────
insert into public.journey_definitions
  (code, name_he, description, trigger_event, trigger_conditions, steps)
values
  ('investor_mentorship_kickoff', 'מסע קיק-אוף — ליווי משקיעים',
   'מסע 21 ימים שמלווה רוכש ליווי-משקיעים: התאמה לפרילנסר, תזכורת לפגישה, צ׳ק-אין באמצע התוכנית.',
   'deal.won_investor',
   '{}'::jsonb,
   jsonb_build_array(
     jsonb_build_object(
       'name', 'kickoff_partner_intro',
       'delay_hours', 0,
       'conditions', jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'send_template', 'key', 'c6', 'channel', 'whatsapp')
       )
     ),
     jsonb_build_object(
       'name', 'day_3_meeting_reminder',
       'delay_hours', 72,
       'conditions', jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'create_task',
                            'title', 'וידוא: פגישת היכרות עם הפרילנסר בוצעה',
                            'kind', 'check_in', 'due_in_hours', 48)
       )
     ),
     jsonb_build_object(
       'name', 'day_10_progress_check',
       'delay_hours', 168,
       'conditions', jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'create_task',
                            'title', 'צ׳ק-אין יום 10 — בדיקת התקדמות עם הליווי',
                            'kind', 'check_in', 'due_in_hours', 24)
       )
     ),
     jsonb_build_object(
       'name', 'day_21_wrapup',
       'delay_hours', 264,
       'conditions', jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'send_template', 'key', 'c12', 'channel', 'whatsapp')
       )
     )
   )
  )
on conflict (code) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  trigger_event = excluded.trigger_event,
  steps = excluded.steps;

-- ─────────────────────────────────────────────────────────────────────
-- retention_resurrect — 21-day journey for dormant leads. Designed to
-- be started by an engine rule (B8 evolved) that detects 14+ days of
-- inactivity. Sends C4 then escalates to a follow-up task if no reply.
-- ─────────────────────────────────────────────────────────────────────
insert into public.journey_definitions
  (code, name_he, description, trigger_event, trigger_conditions, steps)
values
  ('retention_resurrect', 'מסע החייאה — לידים רדומים',
   'מסע 21 ימים שמנסה להחזיר לידים שותקים: ערך חינמי, ואז משימה לעובד CRM.',
   'lead.dormant',
   '{}'::jsonb,
   jsonb_build_array(
     jsonb_build_object(
       'name', 'day_0_value_nudge',
       'delay_hours', 0,
       'conditions', jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'send_template', 'key', 'c4', 'channel', 'whatsapp')
       )
     ),
     jsonb_build_object(
       'name', 'day_7_human_followup',
       'delay_hours', 168,
       'conditions', jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'create_task',
                            'title', 'מעקב אישי: ליד שותק 21 ימים',
                            'kind', 'follow_up', 'due_in_hours', 48)
       )
     ),
     jsonb_build_object(
       'name', 'day_21_final_attempt',
       'delay_hours', 336,
       'conditions', jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'set_field', 'table', 'leads', 'field', 'heat', 'value', 'cold')
       )
     )
   )
  )
on conflict (code) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  trigger_event = excluded.trigger_event,
  steps = excluded.steps;
