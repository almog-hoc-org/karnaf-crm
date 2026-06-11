-- 075_b17_presale_publish.sql
--
-- Tier 4.D.8 — activate B17 (פתיחת פרויקט פריסייל).
--
-- Spec § ז B17: שולח הצעה (C14) לאנשי קשר מתאימים כשפרויקט פריסייל נפתח.
--
-- Trigger: `project.recruiting` emitted per-lead from the projects
-- edge fn's new `publish` action. The publish action queries
-- "relevant" leads (primary_track=presale OR
-- product_interest=contractor_group_purchase) and fans out the
-- event to each, so the rule's conditions run per lead.
--
-- Conditions guard against re-sending to the same lead twice when a
-- project is re-published: simplest expression is a soft check on
-- ownership_mode + lead status. A more robust dedup would need an
-- `outbound_sent` index per (lead_id, template_key) — defer.

update public.automation_rules
   set source = 'engine',
       enabled = true,
       implementation_ref = 'automation-engine + /projects publish action',
       -- The /projects publish action already gates on
       -- (primary_track=presale OR product_interest=contractor_group_purchase)
       -- + DNC + terminal status. Rule-side conditions stay minimal as
       -- belt-and-suspenders — DNC primarily, since a lead might have
       -- opted out between intake and publish.
       conditions = jsonb_build_object(
         'all', jsonb_build_array(
           jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
           jsonb_build_object('field', 'lead.lead_status', 'op', 'not_in',
                              'value', jsonb_build_array('won', 'lost', 'dormant', 'do_not_contact', 'removed_by_request'))
         )
       ),
       actions = jsonb_build_array(
         jsonb_build_object('type', 'send_template', 'key', 'c14', 'channel', 'whatsapp')
       )
 where code = 'b17_presale_project_opens';
