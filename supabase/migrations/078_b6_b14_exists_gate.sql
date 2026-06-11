-- 078_b6_b14_exists_gate.sql
--
-- Tier 7.A.4 — null-safety gates for B6 (hot lead 48h no reply) and
-- B14 (student inactive 7d).
--
-- Both rules use `hours_since_last_inbound >= N` to detect silence.
-- The DSL coerces null → 0 via Number(actual), so leads that NEVER
-- replied evaluate to false (0 < 48). The behavior is correct from a
-- type-safety angle but contradicts the admin's mental model — "a
-- never-replied hot lead older than 48h" is exactly the audience these
-- rules want to surface. A simple way to express the intent is to add
-- an explicit existence check before the gte.
--
-- After this migration:
--   * B6 conditions: lead_heat='hot' AND hours_since_last_inbound IS NOT NULL
--                    AND hours_since_last_inbound >= 48
--                    AND lead_status NOT IN (...) AND do_not_contact=false
--   * B14 conditions: is_program_member=true AND days_since_program_join >= 7
--                     AND hours_since_last_inbound IS NOT NULL
--                     AND hours_since_last_inbound >= 168
--                     AND program_progress_stage NOT IN (...) AND do_not_contact=false
--
-- The 'exists' op in the DSL means "not null and not undefined" — see
-- automation-engine.ts leafOp().

update public.automation_rules
   set conditions = jsonb_build_object(
         'all', jsonb_build_array(
           jsonb_build_object('field', 'lead.lead_heat', 'op', 'eq', 'value', 'hot'),
           jsonb_build_object('field', 'lead.hours_since_last_inbound', 'op', 'exists'),
           jsonb_build_object('field', 'lead.hours_since_last_inbound', 'op', 'gte', 'value', 48),
           jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
           jsonb_build_object('field', 'lead.lead_status', 'op', 'not_in',
                              'value', jsonb_build_array('won', 'lost', 'dormant', 'do_not_contact', 'removed_by_request'))
         )
       )
 where code = 'b6_hot_lead_no_reply_48h';

update public.automation_rules
   set conditions = jsonb_build_object(
         'all', jsonb_build_array(
           jsonb_build_object('field', 'lead.is_program_member', 'op', 'eq', 'value', true),
           jsonb_build_object('field', 'lead.days_since_program_join', 'op', 'gte', 'value', 7),
           jsonb_build_object('field', 'lead.hours_since_last_inbound', 'op', 'exists'),
           jsonb_build_object('field', 'lead.hours_since_last_inbound', 'op', 'gte', 'value', 168),
           jsonb_build_object('field', 'lead.program_progress_stage', 'op', 'not_in',
                              'value', jsonb_build_array('completed', 'graduated', 'cancelled')),
           jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false)
         )
       )
 where code = 'b14_student_inactive_7d';
