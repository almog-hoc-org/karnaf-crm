-- 127_form_sources_email_consent.sql
--
-- Migration 126 granted email consent to source = 'landing_page' and found
-- exactly one lead. Production, 2026-09-14:
--
--   responder_form   314   (Rav Messer forms — that is where the landing
--                           pages live; every one of these subscribed to a
--                           Rav Messer list)
--   whatsapp          17
--   webinar            2
--   lead_magnet        2
--   manual_entry       1
--   landing_page       1
--
-- "Everyone who arrives through a landing page" therefore means every
-- form-based source. The rule now lives in one predicate used by the
-- backfill, the insert trigger and the ops report, so the three cannot
-- drift. Chat, phone, manual and ad-form leads stay as they are.

create or replace function public.is_form_source(p_source text)
returns boolean
language sql
immutable
as $$
  select p_source in (
    'landing_page',           -- in-system landing pages (website-leads-intake)
    'responder_form',         -- Rav Messer forms / automations
    'lead_magnet',            -- website course / research forms
    'presale_form',
    'webinar',
    'webinar_registration',
    'investor_mentorship_form'
  );
$$;

comment on function public.is_form_source(text) is
  'Sources where the lead filled a form whose copy states mailing consent. '
  'Used for the consent_email grant (migrations 126/127).';

-- ── 1. Backfill (idempotent; never overwrites an explicit false) ────────
do $$
declare
  v_granted integer := 0;
  v_refused integer := 0;
begin
  with granted as (
    update public.leads
       set consent_email = true,
           consent_updated_at = now()
     where consent_email is null
       and public.is_form_source(source)
    returning id, source
  ),
  logged as (
    insert into public.lead_events (lead_id, event_type, actor_type, event_payload)
    select id, 'consent_granted', 'system',
           jsonb_build_object('channel', 'email', 'basis', 'form_submission',
                              'source', source, 'backfill', true, 'migration', '127')
      from granted
    returning lead_id
  )
  select count(*) into v_granted from logged;

  select count(*) into v_refused
    from public.leads
   where consent_email = false and public.is_form_source(source);

  raise notice 'form-source email consent: % granted, % explicit refusals left alone',
    v_granted, v_refused;
end $$;

-- ── 2. New leads: same predicate ───────────────────────────────────────
create or replace function public.leads_landing_page_consent_before_insert()
returns trigger
language plpgsql
as $$
begin
  if public.is_form_source(new.source) and new.consent_email is null then
    new.consent_email := true;
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
begin
  if public.is_form_source(new.source) and new.consent_email = true
     and new.consent_updated_at is not null
     and new.consent_updated_at >= now() - interval '1 second' then
    insert into public.lead_events (lead_id, event_type, actor_type, event_payload)
    values (new.id, 'consent_granted', 'system',
            jsonb_build_object('channel', 'email', 'basis', 'form_submission',
                               'source', new.source, 'backfill', false));
  end if;
  return new;
end;
$$;

comment on column public.leads.consent_email is
  'Marketing-email opt-in (חוק הספאם). NULL = never asked, false = refused. '
  'Form-based sources (public.is_form_source) are granted true on insert by '
  'trg_leads_landing_page_consent_before — the form copy states the consent.';
