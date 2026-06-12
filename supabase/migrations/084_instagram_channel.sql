-- 084_instagram_channel.sql
--
-- Tier 8.A — Instagram DM as a first-class inbound channel.
--
-- Identity: Instagram messaging exposes only an IGSID (per-app scoped
-- user id) — no phone, no email. Leads created from a DM are keyed on
-- ig_user_id; when the bot later learns a phone, the operator merges
-- via merge_leads (083). conversations.channel='instagram' is already
-- allowed by the 003 check constraint.

alter table public.leads add column if not exists ig_user_id text;
alter table public.leads add column if not exists ig_username text;

create unique index if not exists ux_leads_ig_user_id
  on public.leads(ig_user_id) where ig_user_id is not null;

-- Mirror of upsert_lead_by_phone / upsert_lead_smart for IGSID identity.
create or replace function public.upsert_lead_by_igsid(
  p_igsid text,
  p_full_name text default null,
  p_username text default null,
  p_metadata jsonb default '{}'::jsonb
) returns leads
language plpgsql security definer set search_path = public as $$
declare
  v_lead leads;
begin
  if p_igsid is null or p_igsid = '' then
    raise exception 'igsid required';
  end if;

  select * into v_lead from leads where ig_user_id = p_igsid limit 1;
  if found then
    update leads set
      full_name = coalesce(full_name, p_full_name),
      ig_username = coalesce(p_username, ig_username),
      updated_at = now()
    where id = v_lead.id
    returning * into v_lead;
    return v_lead;
  end if;

  insert into leads (ig_user_id, ig_username, full_name, source, intake_channel, raw_import_snapshot)
  values (p_igsid, p_username, coalesce(p_full_name, 'ליד אינסטגרם'), 'instagram_dm', 'instagram', coalesce(p_metadata, '{}'::jsonb))
  returning * into v_lead;

  insert into lead_events(lead_id, event_type, actor_type, event_payload)
  values (v_lead.id, 'lead_created', 'system', jsonb_build_object(
    'source', 'instagram_dm', 'intake_channel', 'instagram', 'igsid', p_igsid
  ));
  return v_lead;
end;
$$;

revoke all on function public.upsert_lead_by_igsid(text,text,text,jsonb) from public;
grant execute on function public.upsert_lead_by_igsid(text,text,text,jsonb) to service_role;

-- Keep the source registry honest — instagram_dm exists since 037 but
-- make sure it's active now that ingestion is real.
update public.lead_sources
   set is_active = true, updated_at = now()
 where slug = 'instagram_dm';
