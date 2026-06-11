-- 076_investor_journey_step_0_assign_partner.sql
--
-- Tier 7.A.1 — fix the silent-skip bug in investor_mentorship_kickoff.
--
-- Background: bridge_deal_won_investor_start_journey fires the journey
-- on deal.won with track=investor_mentorship. The context at that
-- moment has the lead + the deal, but NOT a partner — partner
-- assignment is a separate B3 rule that's triggered by tick scan of
-- unassigned investor deals (deal.investor_open).
--
-- The journey's step 0 (kickoff_partner_intro) sends template C6 which
-- requires {{partner_name}}. With no partner set, renderTemplate
-- returns missing var → actionSendTemplate logs status='skipped' →
-- the runner advances → customer gets no welcome message. Silent.
--
-- Fix: insert a new step 0 = assign_partner action with delay_hours=0.
-- The runner executes it immediately when the journey starts. The
-- existing actionAssignPartner mutates ctx.context.partner_name in
-- the same dispatch chain — so by the time the OLD step 0 (now step 1)
-- sends C6, partner_name is populated and the template renders.
--
-- In-flight runs: if any active run on investor_mentorship_kickoff
-- exists, its current_step indexes shift +1 because we prepended a
-- step. We bump them in the same migration so they don't skip step 1
-- (the original kickoff). Idempotent: assign_partner on an already-
-- assigned deal returns 'skipped' — no harm if a re-fire hits an
-- already-assigned run.

-- Snapshot the new steps array before we update the definition. This
-- variable approach also documents the cadence: 21 days with 5 steps
-- now (assign + 4 originals).
update public.journey_definitions
   set steps = jsonb_build_array(
         -- NEW step 0 — guarantees partner_name in ctx before C6.
         jsonb_build_object(
           'name', 'kickoff_assign_partner',
           'delay_hours', 0,
           'conditions', jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
           'actions', jsonb_build_array(
             jsonb_build_object('type', 'assign_partner', 'domain', 'investor_mentorship')
           )
         ),
         -- Original step 0 → now step 1. Sends C6 with the partner_name
         -- ctx field populated by the previous assign_partner action.
         jsonb_build_object(
           'name', 'kickoff_partner_intro',
           'delay_hours', 0,
           'conditions', jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
           'actions', jsonb_build_array(
             jsonb_build_object('type', 'send_template', 'key', 'c6', 'channel', 'whatsapp')
           )
         ),
         -- Original step 1 → now step 2.
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
         -- Original step 2 → now step 3.
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
         -- Original step 3 → now step 4.
         jsonb_build_object(
           'name', 'day_21_wrapup',
           'delay_hours', 264,
           'conditions', jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
           'actions', jsonb_build_array(
             jsonb_build_object('type', 'send_template', 'key', 'c12', 'channel', 'whatsapp')
           )
         )
       )
 where code = 'investor_mentorship_kickoff';

-- Migrate any active in-flight runs so their current_step lines up
-- with the new step indexes. Without this, a run at current_step=0
-- would re-send the kickoff_partner_intro instead of moving forward.
-- Note: only active runs need this; completed/cancelled/failed runs
-- are read-only history.
update public.journey_runs
   set current_step = current_step + 1
 where definition_code = 'investor_mentorship_kickoff'
   and status = 'active';
