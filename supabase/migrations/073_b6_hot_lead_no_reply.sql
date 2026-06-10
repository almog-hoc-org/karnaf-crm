-- 073_b6_hot_lead_no_reply.sql
--
-- Tier 4.D.6 — activate B6 (hot lead with no reply after 48h).
--
-- Spec § ז B6: "ליד חם בלי מענה 48ש' → משימה דחופה לעובד CRM".
--
-- The Tier 4.D.6 tick context now exposes lead_heat +
-- hours_since_last_inbound + hours_since_last_outbound, so the rule
-- can be 100% data-driven. It fires when:
--   * lead.lead_heat = 'hot'
--   * 48h+ since the lead's last inbound message
--   * lead has not progressed to won / lost / dormant
--   * DNC off
-- Action: create a high-priority follow-up task and notify Mia.
-- Deliberately does NOT auto-send a template — a hot lead deserves a
-- human touch, not another bot message.

update public.automation_rules
   set source = 'engine',
       enabled = true,
       implementation_ref = 'automation-engine + automation-tick (time.elapsed pass)',
       conditions = jsonb_build_object(
         'all', jsonb_build_array(
           jsonb_build_object('field', 'lead.lead_heat', 'op', 'eq', 'value', 'hot'),
           jsonb_build_object('field', 'lead.hours_since_last_inbound', 'op', 'gte', 'value', 48),
           jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
           jsonb_build_object('field', 'lead.lead_status', 'op', 'not_in',
                              'value', jsonb_build_array('won', 'lost', 'dormant', 'do_not_contact', 'removed_by_request'))
         )
       ),
       actions = jsonb_build_array(
         jsonb_build_object('type', 'create_task',
                            'title', 'דחוף: ליד חם {{first_name}} בלי מענה 48ש - לחזור עכשיו',
                            'kind', 'urgent_followup', 'due_in_hours', 4),
         jsonb_build_object('type', 'notify_internal',
                            'text', '🔥 ליד חם בלי מענה — {{first_name}} ({{phone}}), בתפיסת AI {{hours_since_last_inbound}}ש.')
       )
 where code = 'b6_hot_lead_no_reply_48h';
