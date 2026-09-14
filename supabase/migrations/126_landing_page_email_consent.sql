-- 126_landing_page_email_consent.sql
--
-- Owner decision (2026-09-14): everyone who arrives through a landing page
-- has agreed to receive mailings. The landing-page form copy now says so
-- explicitly ("...וקבלת דיוור במייל"), and this migration makes the data
-- match the rule:
--
--   1. backfill — landing-page leads whose consent_email was never set get
--      true, with a consent_granted event per lead so the grant is visible
--      in the timeline and auditable;
--   2. trigger — new landing-page leads get the same on insert, whichever
--      intake path created them (website-leads-intake, leads-intake,
--      make-intake, manual entry);
--   3. an explicit `false` is a refusal and is never overwritten.
--
-- Why it matters: contact-guard and the broadcast segment treat NULL as
-- "no consent", so until now not one landing-page lead could receive an
-- email broadcast. consent_whatsapp is deliberately untouched.

-- ── 1. Backfill ───────────────────────────────────────────────────────
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
       and (source = 'landing_page'
            or source_detail in (select slug from public.landing_pages))
    returning id
  ),
  logged as (
    insert into public.lead_events (lead_id, event_type, actor_type, event_payload)
    select id, 'consent_granted', 'system',
           jsonb_build_object('channel', 'email', 'basis', 'landing_page_form',
                              'backfill', true, 'migration', '126')
      from granted
    returning lead_id
  )
  select count(*) into v_granted from logged;

  select count(*) into v_refused
    from public.leads
   where consent_email = false
     and (source = 'landing_page'
          or source_detail in (select slug from public.landing_pages));

  raise notice 'landing-page email consent: % granted, % explicit refusals left alone',
    v_granted, v_refused;
end $$;

-- ── 2. New leads ──────────────────────────────────────────────────────
create or replace function public.leads_landing_page_consent_before_insert()
returns trigger
language plpgsql
as $$
begin
  if new.source = 'landing_page' and new.consent_email is null then
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
  -- Only the auto-grant is logged here. A caller that set consent_email
  -- itself (leads-intake with an explicit boolean) is not a landing-page
  -- grant and records nothing.
  if new.source = 'landing_page' and new.consent_email = true
     and new.consent_updated_at is not null
     and new.consent_updated_at >= now() - interval '1 second' then
    insert into public.lead_events (lead_id, event_type, actor_type, event_payload)
    values (new.id, 'consent_granted', 'system',
            jsonb_build_object('channel', 'email', 'basis', 'landing_page_form',
                               'backfill', false));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_leads_landing_page_consent_before on public.leads;
create trigger trg_leads_landing_page_consent_before
  before insert on public.leads
  for each row execute function public.leads_landing_page_consent_before_insert();

drop trigger if exists trg_leads_landing_page_consent_after on public.leads;
create trigger trg_leads_landing_page_consent_after
  after insert on public.leads
  for each row execute function public.leads_landing_page_consent_after_insert();

comment on column public.leads.consent_email is
  'Marketing-email opt-in (חוק הספאם). NULL = never asked, false = refused. '
  'Landing-page leads (source = landing_page) are granted true on insert by '
  'trg_leads_landing_page_consent_before — the form copy states the consent.';
