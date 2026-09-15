-- 128_consent_default_and_opt_out.sql
--
-- Owner's rule (2026-09-14): every new lead is opted in to mailings unless
-- they say otherwise, and a lead who replies to a mailing asking to be
-- removed is removed. Three pieces of state for that:
--
--   1. the insert trigger from 126/127 now grants BOTH consent flags for
--      EVERY source when the caller left them null (an explicit false from
--      an intake payload still wins);
--   2. intake contracts gain an `action`, so a Rav Messer "unsubscribed"
--      webhook can revoke email consent instead of creating a lead;
--   3. crm_config.messaging holds the opt-out keywords, the footer every
--      outgoing marketing text carries, and the confirmation sent back.
--
-- Existing leads with consent still null (18 on 2026-09-14: 17 whatsapp,
-- 1 manual) are NOT backfilled here — the rule is about new leads; the
-- owner decides on those separately.

-- ── 1. Default opt-in on insert ────────────────────────────────────────
create or replace function public.leads_landing_page_consent_before_insert()
returns trigger
language plpgsql
as $$
begin
  if new.consent_email is null then
    new.consent_email := true;
    new.consent_updated_at := coalesce(new.consent_updated_at, now());
  end if;
  if new.consent_whatsapp is null then
    new.consent_whatsapp := true;
    new.consent_updated_at := coalesce(new.consent_updated_at, now());
  end if;
  return new;
end;
$$;

create or replace function public.leads_landing_page_consent_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_channels text[] := array[]::text[];
begin
  -- Only a grant made by the before-trigger in this same statement is
  -- logged here (consent_updated_at stamped "now"); a caller that set the
  -- flags itself records nothing — it is not a default grant.
  if new.consent_updated_at is null or new.consent_updated_at < now() - interval '1 second' then
    return new;
  end if;
  if new.consent_email = true then v_channels := v_channels || 'email'; end if;
  if new.consent_whatsapp = true then v_channels := v_channels || 'whatsapp'; end if;
  if array_length(v_channels, 1) is null then
    return new;
  end if;
  insert into public.lead_events (lead_id, event_type, actor_type, event_payload)
  values (new.id, 'consent_granted', 'system',
          jsonb_build_object(
            'channels', to_jsonb(v_channels),
            'basis', case when public.is_form_source(new.source) then 'form_submission' else 'default_opt_in' end,
            'source', new.source,
            'backfill', false));
  return new;
end;
$$;

comment on column public.leads.consent_email is
  'Marketing-email opt-in (חוק הספאם). Granted true on insert for every source unless the '
  'caller sets it (migration 128); false = the lead asked to be removed. NULL only on rows '
  'created before 2026-09-14.';
comment on column public.leads.consent_whatsapp is
  'Marketing-WhatsApp opt-in. Same rule as consent_email (migration 128). contact-guard blocks '
  'proactive WhatsApp when false.';

-- ── 2. Intake contracts can revoke instead of create ───────────────────
alter table public.intake_source_contracts
  add column if not exists action text not null default 'upsert_lead';
do $$ begin
  alter table public.intake_source_contracts
    add constraint intake_source_contracts_action_check
    check (action in ('upsert_lead', 'revoke_consent'));
exception when duplicate_object then null; end $$;

comment on column public.intake_source_contracts.action is
  'upsert_lead (default) creates/refreshes a lead; revoke_consent looks the lead up by '
  'email/phone and sets consent_email=false (Rav Messer unsubscribe webhook).';

insert into public.intake_source_contracts (
  contract_key, source_slug, display_name, description,
  required_fields, field_aliases, default_track, default_stage, default_interest_topic,
  default_tags, example_payload, action
) values (
  'ravmesser_unsubscribe_v1',
  'responder_form',
  'רב מסר — הסרה מרשימה',
  'Rav Messer (Responder) webhook fired when a subscriber unsubscribes from a list. Revokes email consent in the CRM; never creates a lead. Point the Responder "unsubscribe" automation at leads-intake with contract_key=ravmesser_unsubscribe_v1.',
  '{}'::text[],
  '{
    "full_name": ["NAME", "name", "שם", "שם מלא"],
    "phone": ["PHONE", "phone", "טלפון", "mobile", "נייד"],
    "email": ["EMAIL", "email", "אימייל", "mail", "דוא\"ל"],
    "campaign_name": ["list_name", "רשימה", "LIST_NAME"]
  }'::jsonb,
  null, null, null,
  array['ravmesser', 'unsubscribe'],
  '{ "EMAIL": "israel@example.com", "list_name": "רשימת מתעניינים — הדרך לדירה" }'::jsonb,
  'revoke_consent'
)
on conflict (contract_key) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  field_aliases = excluded.field_aliases,
  default_tags = excluded.default_tags,
  example_payload = excluded.example_payload,
  action = excluded.action,
  is_active = true,
  updated_at = now();

-- ── 3. Messaging config ────────────────────────────────────────────────
insert into public.crm_config (config_key, config_value)
values (
  'messaging',
  jsonb_build_object(
    'optOutFooter', 'להסרה מרשימת התפוצה השיבו "הסר"',
    'optOutConfirmation', 'הוסרת מרשימת התפוצה שלנו ולא נשלח לך עוד הודעות שיווקיות. אם תרצה לחזור, כתוב "חזור".',
    'resubscribeConfirmation', 'חזרת לרשימת התפוצה שלנו. תודה!',
    'optOutKeywords', jsonb_build_array(
      'הסר', 'הסירו', 'הסירו אותי', 'תסיר', 'תסירו', 'להסיר',
      'תוריד', 'תורידו', 'להוריד אותי', 'תפסיק', 'תפסיקו',
      'לא מעוניין', 'לא מעוניינת', 'אל תפנו', 'אל תשלחו',
      'stop', 'unsubscribe', 'remove me', 'opt out'),
    'resubscribeKeywords', jsonb_build_array('חזור', 'הרשם', 'תרשמו אותי', 'resubscribe', 'start')
  )
)
on conflict (config_key) do nothing;

-- ── 4. Broadcasts remember why they failed ─────────────────────────────
-- The 2026-09-14 email campaign (311 recipients) flipped to failed one
-- second after its start with sent_count=0 and nothing on the row; the
-- reason ("ravmesser not configured") went out only as a WhatsApp alert.
alter table public.broadcasts
  add column if not exists last_error text,
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz;
comment on column public.broadcasts.last_error is
  'Why the last attempt failed (provider message). Cleared on retry.';
