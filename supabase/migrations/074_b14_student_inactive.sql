-- 074_b14_student_inactive.sql
--
-- Tier 4.D.7 — activate B14 (תלמיד לא מתקדם 7 ימים).
--
-- Spec § ז B14: שולח עידוד (C11) + מציע פגישת ליווי.
--
-- Tick context (Tier 4.D.7) now exposes is_program_member +
-- days_since_program_join + program_progress_stage, so the rule is
-- fully data-driven.
--
-- Conditions:
--   * lead is a program_member
--   * joined ≥7 days ago (the cadence the spec names)
--   * no inbound from the lead in the last 7 days (proxy for
--     "not progressing" — silence on the chat = silence on the course)
--   * not on a completed stage
--   * DNC off
--
-- Actions:
--   * send_template c11 ("עידוד תלמיד")
--   * create_task "פגישת ליווי קצרה לתלמיד {{first_name}}" due 48h
--
-- The send + task pairing is intentional: the bot nudges, but a
-- human follow-up is the real value (especially for students who
-- ghosted the AI).

update public.automation_rules
   set source = 'engine',
       enabled = true,
       implementation_ref = 'automation-engine + automation-tick (program_members context)',
       conditions = jsonb_build_object(
         'all', jsonb_build_array(
           jsonb_build_object('field', 'lead.is_program_member', 'op', 'eq', 'value', true),
           jsonb_build_object('field', 'lead.days_since_program_join', 'op', 'gte', 'value', 7),
           jsonb_build_object('field', 'lead.hours_since_last_inbound', 'op', 'gte', 'value', 168),
           jsonb_build_object('field', 'lead.program_progress_stage', 'op', 'not_in',
                              'value', jsonb_build_array('completed', 'graduated', 'cancelled')),
           jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false)
         )
       ),
       actions = jsonb_build_array(
         jsonb_build_object('type', 'send_template', 'key', 'c11', 'channel', 'whatsapp'),
         jsonb_build_object('type', 'create_task',
                            'title', 'פגישת ליווי קצרה לתלמיד {{first_name}}',
                            'kind', 'student_followup', 'due_in_hours', 48),
         jsonb_build_object('type', 'notify_internal',
                            'text', '📚 תלמיד שותק 7 ימים — {{first_name}} (שלב {{program_progress_stage}}). C11 נשלח + משימה.')
       )
 where code = 'b14_student_inactive_7d';
