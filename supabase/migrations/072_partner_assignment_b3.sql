-- 072_partner_assignment_b3.sql
--
-- Tier 4.D.5 — activate B3 (partner round-robin assignment).
--
-- Spec § ז B3 names this as the engine rule for investor_mentorship:
-- when an open investor_mentorship deal exists without a partner, pick
-- the active partner with the lowest open-deal count from
-- partner_workload, assign them, and notify both sides (C5 to partner,
-- C6 to lead).
--
-- The cron tick (automation-tick) now scans for unassigned investor
-- deals every 10 min and emits `deal.investor_open` per match. This
-- rule listens and acts:
--   1. assign_partner — picks + writes deal.partner_id, mutates the
--      run context to include partner_name (for {{partner_name}}
--      template variables in subsequent send_template actions).
--   2. send_template c6 — confirms to the lead "we paired you with X".
--   3. notify_internal — pings Mia's Telegram so she knows to
--      personally introduce or warm-hand the partner. The partner is
--      not auto-DMed because the outbound_dispatch flow is rooted on
--      lead_id, not partner_id — a partner-routed dispatch is a
--      future capability (C5 deferred).
--
-- Idempotency: assign_partner returns 'skipped' if deal.partner_id is
-- already set. Re-runs on the same deal are safe; the tick simply
-- stops emitting deal.investor_open once partner_id is non-null.

update public.automation_rules
   set source = 'engine',
       enabled = true,
       implementation_ref = 'automation-engine + automation-tick + partner_workload view',
       trigger_event = 'deal.investor_open',
       conditions = jsonb_build_object(
         'all', jsonb_build_array(
           jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
           jsonb_build_object('field', 'deal.track', 'op', 'eq', 'value', 'investor_mentorship')
         )
       ),
       actions = jsonb_build_array(
         jsonb_build_object('type', 'assign_partner', 'domain', 'investor_mentorship'),
         jsonb_build_object('type', 'send_template', 'key', 'c6', 'channel', 'whatsapp'),
         jsonb_build_object('type', 'notify_internal',
                            'text', 'שיוך פרילנסר ל-{{first_name}} ({{partner_name}}). יש לוודא העברה רכה.')
       )
 where code = 'b3_partner_assignment';
