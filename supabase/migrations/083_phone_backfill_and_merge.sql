-- 083_phone_backfill_and_merge.sql
--
-- Tier 8.E3 — phone normalization backfill + minimal lead merge.
--
-- (1) Backfill: normalizeIsraeliPhone has applied at intake since the
--     beginning, but rows imported/edited through other paths can hold
--     "+972 50-1234567" style values. Those break dedup (upsert by
--     phone misses) and WhatsApp sends. Normalize in place; when the
--     normalized value collides with another lead, queue a manual
--     merge instead of guessing.
--
-- (2) merge_leads(survivor, duplicate): repoints every lead-linked
--     table, fills the survivor's missing contact fields, neutralizes
--     the duplicate (frees the phone/email unique indexes), and logs
--     lead_merged on both sides. Exposed to owners/admins through
--     admin-actions `merge_lead_duplicate`.

-- ── 1. SQL mirror of normalizeIsraeliPhone ──────────────────────────

create or replace function public.normalize_il_phone(p_raw text)
returns text
language plpgsql
immutable
as $$
declare
  v text;
begin
  if p_raw is null then return null; end if;
  v := regexp_replace(p_raw, '[\s\-().]', '', 'g');
  if v like '+972%' then
    v := '0' || substr(v, 5);
  elsif v like '00972%' then
    v := '0' || substr(v, 6);
  elsif v like '972%' and length(v) > 9 then
    v := '0' || substr(v, 4);
  end if;
  v := regexp_replace(v, '^\+', '');
  if v not like '0%' and length(v) = 9 then
    v := '0' || v;
  end if;
  if length(v) >= 9 then return v; end if;
  return null;
end;
$$;

-- ── 2. Backfill ─────────────────────────────────────────────────────

do $$
declare
  r record;
  v_norm text;
  v_collision uuid;
  v_fixed int := 0;
  v_queued int := 0;
begin
  for r in
    select id, phone from public.leads
    where phone is not null
      and public.normalize_il_phone(phone) is not null
      and public.normalize_il_phone(phone) <> phone
  loop
    v_norm := public.normalize_il_phone(r.phone);
    select id into v_collision from public.leads where phone = v_norm and id <> r.id limit 1;
    if v_collision is null then
      update public.leads set phone = v_norm, updated_at = now() where id = r.id;
      v_fixed := v_fixed + 1;
    else
      -- Same human, two rows. Don't guess which survives — queue it.
      insert into public.work_queue (lead_id, queue_type, priority_level, status, reason, created_by_actor_type, payload_json)
      select v_collision, 'manual_review_required', 2, 'pending',
             'כפילות טלפון אחרי נרמול — נדרש מיזוג',
             'system',
             jsonb_build_object('duplicate_lead_id', r.id, 'survivor_suggestion', v_collision, 'raw_phone', r.phone, 'normalized_phone', v_norm)
      where not exists (
        select 1 from public.work_queue
        where lead_id = v_collision and queue_type = 'manual_review_required'
          and status = 'pending'
          and payload_json->>'duplicate_lead_id' = r.id::text
      );
      v_queued := v_queued + 1;
    end if;
  end loop;
  raise notice 'phone backfill: % normalized in place, % queued for manual merge', v_fixed, v_queued;
end $$;

-- ── 3. merge_leads RPC ──────────────────────────────────────────────

create or replace function public.merge_leads(p_survivor uuid, p_duplicate uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dup public.leads%rowtype;
begin
  if p_survivor = p_duplicate then
    raise exception 'survivor and duplicate are the same lead';
  end if;
  select * into v_dup from public.leads where id = p_duplicate for update;
  if not found then raise exception 'duplicate lead % not found', p_duplicate; end if;
  perform 1 from public.leads where id = p_survivor for update;
  if not found then raise exception 'survivor lead % not found', p_survivor; end if;

  -- Plain repoints (no unique-per-lead constraints).
  update public.conversations set lead_id = p_survivor where lead_id = p_duplicate;
  update public.messages set lead_id = p_survivor where lead_id = p_duplicate;
  update public.lead_events set lead_id = p_survivor where lead_id = p_duplicate;
  update public.lead_tasks set lead_id = p_survivor where lead_id = p_duplicate;
  update public.ai_decisions set lead_id = p_survivor where lead_id = p_duplicate;
  update public.payment_events set lead_id = p_survivor where lead_id = p_duplicate;
  update public.work_queue set lead_id = p_survivor where lead_id = p_duplicate;
  update public.outbound_dispatch set lead_id = p_survivor where lead_id = p_duplicate;
  update public.deals set lead_id = p_survivor where lead_id = p_duplicate;
  update public.meetings set lead_id = p_survivor where lead_id = p_duplicate;
  update public.webinar_registrations set lead_id = p_survivor where lead_id = p_duplicate;
  update public.activities set contact_id = p_survivor where contact_id = p_duplicate;
  update public.automation_runs set contact_id = p_survivor where contact_id = p_duplicate;

  -- journey_runs: partial unique (definition_id, contact_id) where
  -- status='active'. Cancel the duplicate's active runs when the
  -- survivor already has one for the same definition, then repoint.
  update public.journey_runs jr
     set status = 'cancelled',
         last_error = 'cancelled by lead merge — survivor already active'
   where jr.contact_id = p_duplicate
     and jr.status = 'active'
     and exists (
       select 1 from public.journey_runs s
       where s.contact_id = p_survivor and s.definition_id = jr.definition_id and s.status = 'active'
     );
  update public.journey_runs set contact_id = p_survivor where contact_id = p_duplicate;

  -- engine_template_sends: unique (lead_id, template_key, channel) —
  -- drop the duplicate's rows that would collide, repoint the rest.
  delete from public.engine_template_sends d
   where d.lead_id = p_duplicate
     and exists (
       select 1 from public.engine_template_sends s
       where s.lead_id = p_survivor and s.template_key = d.template_key and s.channel = d.channel
     );
  update public.engine_template_sends set lead_id = p_survivor where lead_id = p_duplicate;

  -- lead_id-as-PK tables: keep the survivor's row when both exist.
  delete from public.program_members d
   where d.lead_id = p_duplicate
     and exists (select 1 from public.program_members s where s.lead_id = p_survivor);
  update public.program_members set lead_id = p_survivor where lead_id = p_duplicate;
  delete from public.whatsapp_router_state d
   where d.lead_id = p_duplicate
     and exists (select 1 from public.whatsapp_router_state s where s.lead_id = p_survivor);
  update public.whatsapp_router_state set lead_id = p_survivor where lead_id = p_duplicate;

  -- Fill survivor gaps from the duplicate, union tags.
  update public.leads s
     set full_name = coalesce(s.full_name, v_dup.full_name),
         email = coalesce(s.email, v_dup.email),
         city = coalesce(s.city, v_dup.city),
         source_detail = coalesce(s.source_detail, v_dup.source_detail),
         source_campaign = coalesce(s.source_campaign, v_dup.source_campaign),
         product_interest = coalesce(s.product_interest, v_dup.product_interest),
         tags = (
           select coalesce(array_agg(distinct t), '{}'::text[])
           from unnest(coalesce(s.tags, '{}'::text[]) || coalesce(v_dup.tags, '{}'::text[])) as t
         ),
         updated_at = now()
   where s.id = p_survivor;

  -- Neutralize the duplicate: free the unique phone/email indexes and
  -- park the row out of every operational scan. Original identifiers
  -- preserved in the merge event payload below.
  update public.leads
     set phone = null,
         email = null,
         lead_status = 'duplicate',
         do_not_contact = true,
         updated_at = now()
   where id = p_duplicate;

  insert into public.lead_events (lead_id, event_type, actor_type, event_payload)
  values
    (p_survivor, 'lead_merged', 'admin',
     jsonb_build_object('merged_from', p_duplicate, 'merged_phone', v_dup.phone, 'merged_email', v_dup.email)),
    (p_duplicate, 'lead_merged', 'admin',
     jsonb_build_object('merged_into', p_survivor));
end;
$$;

revoke all on function public.merge_leads(uuid, uuid) from public;
revoke all on function public.merge_leads(uuid, uuid) from anon, authenticated;
