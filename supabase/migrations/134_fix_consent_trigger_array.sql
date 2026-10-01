-- 134_fix_consent_trigger_array.sql
--
-- Every new lead has failed to save since migration 128 (2026-09-15).
--
-- The after-insert trigger 128 installed builds its channel list with
--
--     v_channels := v_channels || 'email';
--
-- and Postgres resolves `text[] || <untyped literal>` as array || array,
-- so it tries to parse 'email' as an array literal and raises
-- "malformed array literal". The before-insert trigger from the same
-- migration sets consent_email = true on every insert, so the failing
-- branch runs for every new lead — from every intake: website forms,
-- make-intake (Rav Messer, Facebook Lead Ads), leads-intake, webinar
-- events, new WhatsApp contacts. upsert_lead_smart rolls back and the
-- intake answers 500 ("Failed to save lead"). Updates to existing leads
-- never fire the trigger, which is why the rest of the CRM looked healthy.
--
-- Evidence it never ran once: the ops report's consent_granted events show
-- only backfill = true rows (migrations 126/127) and not a single
-- backfill = false row, although the trigger exists to write those.
--
-- The fix is array_append, which has no such ambiguity. Behaviour is
-- otherwise identical to 128.

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
  if new.consent_email = true then v_channels := array_append(v_channels, 'email'); end if;
  if new.consent_whatsapp = true then v_channels := array_append(v_channels, 'whatsapp'); end if;
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
