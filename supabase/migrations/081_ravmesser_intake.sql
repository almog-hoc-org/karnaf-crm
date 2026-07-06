-- 081_ravmesser_intake.sql
--
-- Tier 8.B + 8.C — Rav Messer (Responder) connectivity.
--
-- Inbound: a webhook contract for Rav Messer's outbound webhooks
-- ("נמען חדש" on a list / "שליחת וובהוק" automation step). Rav Messer's
-- webhook editor lets the operator name the payload fields freely, so
-- the aliases are generous; the canonical URL also carries
-- ?source=responder_form&contract_key=ravmesser_new_subscriber_v1
-- so a bare payload still routes correctly.
--
-- Outbound: catalog entry + starter rule for the new engine action
-- `add_to_email_list` (adds the lead as a subscriber to a Rav Messer
-- list; Rav Messer automations take over the email sequence from there).
-- Starter rule ships disabled — the admin fills in the real list_id
-- from Rav Messer and flips it on.

-- ── Inbound contract ────────────────────────────────────────────────

update public.lead_sources
   set display_name = 'רב מסר — טופס/אוטומציה',
       is_active = true,
       updated_at = now()
 where slug = 'responder_form';

insert into public.intake_source_contracts(
  contract_key,
  source_slug,
  display_name,
  description,
  required_fields,
  field_aliases,
  default_track,
  default_stage,
  default_interest_topic,
  default_tags,
  example_payload
) values (
  'ravmesser_new_subscriber_v1',
  'responder_form',
  'רב מסר — נמען חדש',
  'Rav Messer (Responder) outbound webhook on new list subscriber or automation step. Field names are operator-mapped in the Rav Messer webhook editor; aliases cover their default export names (NAME/EMAIL/PHONE) plus Hebrew labels.',
  '{}'::text[],
  '{
    "full_name": ["NAME", "name", "שם", "שם מלא", "first_name", "fullname"],
    "phone": ["PHONE", "phone", "טלפון", "mobile", "נייד", "cellphone"],
    "email": ["EMAIL", "email", "אימייל", "mail", "דוא\"ל"],
    "message": ["notes", "הערות", "comment"],
    "campaign_name": ["list_name", "רשימה", "campaign", "LIST_NAME"],
    "source_detail": ["form_name", "טופס", "automation_name"]
  }'::jsonb,
  null,
  null,
  null,
  array['ravmesser', 'email_list'],
  '{
    "NAME": "ישראל ישראלי",
    "EMAIL": "israel@example.com",
    "PHONE": "0501234567",
    "list_name": "רשימת מתעניינים — הדרך לדירה"
  }'::jsonb
)
on conflict (contract_key) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  field_aliases = excluded.field_aliases,
  default_tags = excluded.default_tags,
  example_payload = excluded.example_payload,
  is_active = true,
  updated_at = now();

-- ── Outbound action catalog + starter rule ──────────────────────────

insert into public.automation_rules (
  code, name_he, description, trigger_event, category, source, implementation_ref,
  enabled, conditions, actions
) values (
  'b20_email_nurture_on_lead_created',
  'הוספה לרשימת דיוור (רב מסר)',
  'ליד חדש עם אימייל מצטרף לרשימת דיוור ברב מסר — רב מסר ממשיך את רצף האימיילים. ממלאים list_id אמיתי מרב מסר ומדליקים.',
  'lead.created',
  'nurture',
  'engine',
  'automation-engine actionAddToEmailList (_shared/ravmesser.ts)',
  false,
  jsonb_build_object(
    'all', jsonb_build_array(
      jsonb_build_object('field', 'lead.email', 'op', 'exists'),
      jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false)
    )
  ),
  jsonb_build_array(
    jsonb_build_object(
      'type', 'add_to_email_list',
      'list_id', 'REPLACE_WITH_RAVMESSER_LIST_ID',
      'list_name', 'רשימת טיפוח — הדרך לדירה'
    )
  )
)
on conflict (code) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  conditions = excluded.conditions,
  actions = excluded.actions,
  implementation_ref = excluded.implementation_ref,
  updated_at = now();
