-- Creates a brand-new lead exactly the way the intakes do (upsert_lead_smart
-- as service_role, then the follow-up writes), inside a transaction that is
-- rolled back. Any trigger that breaks lead creation fails this file — the
-- way migration 128's consent trigger silently failed every new lead in
-- production for two weeks (fixed in 134).
\set ON_ERROR_STOP 1
begin;
set local role service_role;

select public.check_rate_limit('db-smoke', 3600, 10) as rate_limit_ok;

create temp table smoke_lead on commit drop as
  select * from public.upsert_lead_smart(
    '+972500009901', 'smoke@example.com', 'db smoke', 'landing_page', 'form', '{"smoke": true}'::jsonb);

do $$
declare
  v public.leads;
  v_events integer;
begin
  select * into v from smoke_lead;
  if v.id is null then raise exception 'upsert_lead_smart returned no lead'; end if;
  if v.created_at <> v.updated_at then raise exception 'new lead not detectable as new (created_at <> updated_at)'; end if;
  if v.consent_email is distinct from true or v.consent_whatsapp is distinct from true then
    raise exception 'default consent not granted on insert';
  end if;

  select count(*) into v_events from public.lead_events
   where lead_id = v.id and event_type = 'consent_granted';
  if v_events <> 1 then raise exception 'expected 1 consent_granted event, found %', v_events; end if;

  -- website-leads-intake follow-up writes
  update public.leads
     set source_detail = 'website', source_campaign = 'karnaf_website',
         consent_email = false, consent_whatsapp = false, consent_updated_at = now()
   where id = v.id;
  insert into public.lead_events(lead_id, event_type, actor_type, event_payload)
  values (v.id, 'intake_received', 'system', '{}'::jsonb),
         (v.id, 'consent_not_given', 'system', '{"basis": "website_checkbox_unticked"}'::jsonb);
  insert into public.work_queue(lead_id, queue_type, priority_level, status, reason, queue_summary,
                                created_by_actor_type, due_at, payload_json)
  values (v.id, 'first_response_due', 2, 'pending', 'db smoke', 'db smoke', 'system',
          now() + interval '4 hours', '{}'::jsonb);

  -- the same person again: matched, not duplicated
  perform public.upsert_lead_smart('+972500009901', null, null, 'landing_page', 'form', '{}'::jsonb);
  if (select count(*) from public.leads where phone = '+972500009901') <> 1 then
    raise exception 'repeat submission created a duplicate lead';
  end if;
end $$;

select 'lead path ok' as result;
rollback;

-- ── Privileges (migration 136) ─────────────────────────────────────────
-- The anon key ships inside the web bundle. Nothing in public may be
-- callable or readable with it except the active landing pages.
begin;
do $$
declare
  v_name text;
  v_bad text[] := '{}';
  f record;
  -- The only functions a signed-in staff member may call through PostgREST
  -- (plus RLS helpers, which run as the querying role). Mirror of the
  -- keep_authenticated list in migration 136.
  allow_authenticated text[] := array[
    'is_active_staff', 'has_role', 'current_user_role',
    'attention_inbox', 'dashboard_summary', 'advance_deal_stage'
  ];
begin
  -- Every non-trigger function: closed to anon; closed to authenticated
  -- unless allow-listed. Hand-picked names used to pass while 13 RPCs with
  -- a forgotten `revoke from public` stayed open — the loop is the gate.
  -- Extension functions (pg_trgm lives in public) and IMMUTABLE helpers
  -- (normalize_il_phone, is_form_source — used in indexes and triggers,
  -- touch no data) are not RPC surface and stay callable.
  for f in
    select p.oid, p.oid::regprocedure as sig, p.proname, p.provolatile,
           exists (select 1 from pg_depend d where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e') as from_extension
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f', 'p') and p.prorettype <> 'trigger'::regtype
  loop
    if has_function_privilege('anon', f.oid, 'execute') and not f.from_extension then
      v_bad := v_bad || ('anon:' || f.sig::text);
    end if;
    if has_function_privilege('authenticated', f.oid, 'execute')
       and not (f.proname = any (allow_authenticated))
       and not f.from_extension
       and f.provolatile <> 'i' then
      v_bad := v_bad || ('authenticated:' || f.sig::text);
    end if;
    if not has_function_privilege('service_role', f.oid, 'execute') then
      v_bad := v_bad || ('service_role LOST:' || f.sig::text);
    end if;
  end loop;
  if array_length(v_bad, 1) > 0 then
    raise exception 'function privileges open: %', v_bad;
  end if;
  -- A probe created AFTER the migrations: is a forgotten revoke caught?
  -- (It is not closed by default — see 136 — so this documents that the
  -- loop above is what catches it, by asserting the probe IS open and then
  -- that the convention closes it.)
  execute 'create function public.__smoke_probe_fn() returns int language sql as $f$ select 1 $f$';
  if not has_function_privilege('anon', 'public.__smoke_probe_fn()', 'execute') then
    raise notice 'new functions are closed to anon by default (defaults changed?)';
  end if;
  execute 'revoke all on function public.__smoke_probe_fn() from public, anon, authenticated';
  if has_function_privilege('anon', 'public.__smoke_probe_fn()', 'execute') then
    raise exception 'revoke from public did not close the probe to anon';
  end if;
  execute 'drop function public.__smoke_probe_fn()';

  if not has_function_privilege('authenticated', 'public.attention_inbox(int)', 'execute') then
    raise exception 'authenticated lost attention_inbox';
  end if;
  if not has_function_privilege('authenticated', 'public.is_active_staff()', 'execute') then
    raise exception 'authenticated lost is_active_staff (RLS helper)';
  end if;
  if not has_function_privilege('service_role', 'public.upsert_lead_smart(text,text,text,text,text,jsonb)', 'execute') then
    raise exception 'service_role lost upsert_lead_smart';
  end if;

  -- Views: invoker rights, closed to anon.
  for v_name in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
  loop
    if has_table_privilege('anon', format('public.%I', v_name), 'select') then
      v_bad := v_bad || v_name;
    end if;
    if not exists (
      select 1 from pg_class c2 join pg_namespace n2 on n2.oid = c2.relnamespace
      cross join lateral pg_options_to_table(c2.reloptions) o
      where n2.nspname = 'public' and c2.relname = v_name
        and o.option_name = 'security_invoker' and lower(o.option_value) in ('true', 'on', '1')
    ) then
      raise exception 'view % is not security_invoker', v_name;
    end if;
  end loop;
  if array_length(v_bad, 1) > 0 then
    raise exception 'anon can read views: %', v_bad;
  end if;

  -- Every table has RLS on.
  select array_agg(tablename) into v_bad
    from pg_tables where schemaname = 'public' and not rowsecurity;
  if v_bad is not null then
    raise exception 'tables without RLS: %', v_bad;
  end if;

  -- No staff-wide write policy survives: writes go through Edge Functions.
  -- (005's `*_staff_no_write` policies are RESTRICTIVE deny-alls — those
  -- are the opposite of a grant and stay.)
  select array_agg(tablename || '.' || policyname) into v_bad
    from pg_policies
    where schemaname = 'public' and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
      and roles = '{authenticated}'::name[]
      and permissive = 'PERMISSIVE';
  if v_bad is not null then
    raise exception 'authenticated write policies remain: %', v_bad;
  end if;

  -- The public landing-page renderer still works with the anon key.
  if not has_table_privilege('anon', 'public.landing_pages', 'select') then
    raise exception 'anon lost landing_pages select';
  end if;
end $$;
select 'privileges ok' as result;
rollback;

-- ── purge_lead_pii (migration 137) touches one lead only ───────────────
begin;
set local role service_role;
do $$
declare
  a public.leads;
  b public.leads;
  v_conv uuid;
begin
  select * into a from public.upsert_lead_smart('+972500009902', 'a@example.com', 'lead a', 'landing_page', 'form', '{}'::jsonb);
  select * into b from public.upsert_lead_smart('+972500009903', 'b@example.com', 'lead b', 'landing_page', 'form', '{}'::jsonb);
  update public.leads set removed_by_request = true where id = b.id;  -- soft-deleted, restorable
  insert into public.conversations (lead_id, channel, provider_name, ownership_mode, is_open)
    values (a.id, 'whatsapp', 'meta', 'ai_active', true) returning id into v_conv;
  insert into public.messages (conversation_id, lead_id, sender_type, direction, message_type, content_text)
    values (v_conv, a.id, 'lead', 'inbound', 'text', 'my secret address is 12 Herzl st');

  if not public.purge_lead_pii(a.id) then raise exception 'purge_lead_pii returned false'; end if;

  if (select full_name from public.leads where id = a.id) <> '[redacted]' then
    raise exception 'lead a not redacted';
  end if;
  if (select phone from public.leads where id = a.id) is not null then
    raise exception 'lead a phone kept';
  end if;
  if (select content_text from public.messages where lead_id = a.id) <> '[redacted]' then
    raise exception 'lead a message text kept';
  end if;
  if (select full_name from public.leads where id = b.id) <> 'lead b' then
    raise exception 'purge_lead_pii touched another soft-deleted lead';
  end if;
  if public.purge_lead_pii(gen_random_uuid()) then
    raise exception 'purge_lead_pii claimed to purge a missing lead';
  end if;
end $$;
select 'pii purge ok' as result;
rollback;

-- ── Reliability round (migrations 138-141) ─────────────────────────────
begin;
set local role service_role;
do $$
declare
  a public.leads; b public.leads;
  ca uuid; cb uuid; w uuid; n int; v text; t0 timestamptz; fk record;
begin
  -- awaiting_reply (139) follows the inbound/outbound timestamps.
  select * into a from public.upsert_lead_smart('+972500009921', null, 'surv', 'landing_page', 'form', '{}'::jsonb);
  update public.leads set last_inbound_at = now() - interval '1 hour', last_outbound_at = null where id = a.id;
  if not (select awaiting_reply from public.leads where id = a.id) then raise exception 'awaiting_reply false after inbound'; end if;
  update public.leads set last_outbound_at = now() where id = a.id;
  if (select awaiting_reply from public.leads where id = a.id) then raise exception 'awaiting_reply true after outbound'; end if;

  -- Turn lease (138): second claim fails, release frees it.
  insert into public.conversations (lead_id, channel, provider_name) values (a.id, 'whatsapp', 'meta') returning id into ca;
  if not public.claim_conversation_turn(ca, 60) then raise exception 'first claim failed'; end if;
  if public.claim_conversation_turn(ca, 60) then raise exception 'second claim succeeded while leased'; end if;
  if not public.release_conversation_turn(ca) then raise exception 'release failed'; end if;
  if not public.claim_conversation_turn(ca, 60) then raise exception 'claim after release failed'; end if;
  perform public.release_conversation_turn(ca);

  -- merge_leads v3 (140): both leads have a whatsapp conversation, the same
  -- webinar and an open deal on the same track; the duplicate has the email.
  select * into b from public.upsert_lead_smart(null, 'dup@example.com', 'dup', 'landing_page', 'form', '{}'::jsonb);
  insert into public.conversations (lead_id, channel, provider_name) values (b.id, 'whatsapp', 'meta') returning id into cb;
  insert into public.conversations (lead_id, channel, provider_name) values (b.id, 'email', 'resend');
  insert into public.messages (conversation_id, lead_id, sender_type, direction, message_type, content_text)
    values (cb, b.id, 'lead', 'inbound', 'text', 'hi from dup');
  insert into public.webinars (title, starts_at) values ('smoke webinar', now()) returning id into w;
  insert into public.webinar_registrations (lead_id, webinar_id, attended) values (a.id, w, null), (b.id, w, true);
  insert into public.deals (lead_id, track, stage) values (a.id, 'program', 'new'), (b.id, 'program', 'new');
  -- Both hold a pending item of the same kind (unique pending per lead+type,
  -- 028) and the duplicate has a turn still queued on its conversation.
  insert into public.work_queue (lead_id, queue_type, priority_level, status, reason, created_by_actor_type)
    values (a.id, 'first_response_due', 2, 'pending', 'surv', 'system'), (b.id, 'first_response_due', 2, 'pending', 'dup', 'system');
  insert into public.outbound_dispatch (lead_id, conversation_id, payload) values (b.id, cb, '{"kind":"orchestrate"}'::jsonb);

  perform public.merge_leads(a.id, b.id);

  select count(*) into n from public.conversations where lead_id = a.id and channel = 'whatsapp';
  if n <> 1 then raise exception 'merge left % whatsapp conversations on the survivor', n; end if;
  select count(*) into n from public.conversations where lead_id = a.id;
  if n <> 2 then raise exception 'expected whatsapp + email conversations, got %', n; end if;
  select count(*) into n from public.messages where conversation_id = ca and lead_id = a.id;
  if n <> 1 then raise exception 'duplicate''s message not folded into the survivor conversation'; end if;
  select count(*) into n from public.webinar_registrations where lead_id = a.id;
  if n <> 1 then raise exception 'expected 1 webinar registration, got %', n; end if;
  if not (select attended from public.webinar_registrations where lead_id = a.id) then raise exception 'attended not carried over'; end if;
  select count(*) into n from public.deals where lead_id = a.id and status = 'open';
  if n <> 1 then raise exception 'expected 1 open deal after merge, got %', n; end if;
  select email into v from public.leads where id = a.id;
  if v <> 'dup@example.com' then raise exception 'email not carried over (%)', v; end if;
  if (select lead_status from public.leads where id = b.id) <> 'duplicate' then raise exception 'duplicate not parked'; end if;
  select count(*) into n from public.work_queue where lead_id = a.id and queue_type = 'first_response_due' and status = 'pending';
  if n <> 1 then raise exception 'expected 1 pending first_response_due on the survivor, got %', n; end if;
  select count(*) into n from public.work_queue where lead_id = a.id and queue_type = 'first_response_due' and status = 'resolved';
  if n <> 1 then raise exception 'duplicate''s colliding queue item not closed'; end if;
  select count(*) into n from public.outbound_dispatch where lead_id = a.id and conversation_id = ca and status = 'pending';
  if n <> 1 then raise exception 'queued turn lost its conversation in the fold'; end if;
  -- Nothing may still point at the parked duplicate through any FK to leads.
  for fk in
    select c.conrelid::regclass as tbl, att.attname as col
    from pg_constraint c
    join pg_attribute att on att.attrelid = c.conrelid and att.attnum = any (c.conkey)
    where c.contype = 'f' and c.confrelid = 'public.leads'::regclass
  loop
    -- The parked row keeps its own 'lead_merged' (merged_into) marker and
    -- the activity row the 054 mirror makes from it.
    execute format('select count(*) from %s where %I = $1 %s', fk.tbl, fk.col,
      case when fk.tbl = 'public.lead_events'::regclass then $q$and event_type <> 'lead_merged'$q$
           when fk.tbl = 'public.activities'::regclass then $q$and not (source_table = 'lead_events' and source_id in (select id from public.lead_events where event_type = 'lead_merged'))$q$
           else '' end) into n using b.id;
    if n <> 0 then raise exception '% rows of %.% still reference the merged duplicate', n, fk.tbl, fk.col; end if;
  end loop;

  -- Phone carries over to a survivor without one.
  select * into a from public.upsert_lead_smart(null, 'x@example.com', 'x', 'landing_page', 'form', '{}'::jsonb);
  select * into b from public.upsert_lead_smart('+972500009922', null, 'y', 'landing_page', 'form', '{}'::jsonb);
  perform public.merge_leads(a.id, b.id);
  if (select phone from public.leads where id = a.id) is null then raise exception 'phone not carried over'; end if;

  -- 141: the nightly decay leaves updated_at alone. now() is fixed for the
  -- whole transaction, so the baseline is backdated and the change is real.
  t0 := now() - interval '1 day';
  perform set_config('karnaf.skip_touch_updated_at', 'on', true);
  -- (the trigger would otherwise keep old.updated_at for an updated_at-only change)
  update public.leads set updated_at = t0 where id = a.id;
  if (select updated_at from public.leads where id = a.id) <> t0 then raise exception 'could not backdate updated_at under skip_touch_updated_at'; end if;
  update public.leads set lead_score = lead_score + 5 where id = a.id;
  perform set_config('karnaf.skip_touch_updated_at', '', true);
  if (select updated_at from public.leads where id = a.id) <> t0 then raise exception 'skip_touch_updated_at ignored by set_updated_at_leads'; end if;
  update public.leads set lead_score = lead_score + 5 where id = a.id;
  if (select updated_at from public.leads where id = a.id) <> now() then raise exception 'set_updated_at_leads no longer stamps a real change'; end if;

  -- 141: one Instagram sender, one lead.
  insert into public.leads (full_name, source, external_source, external_id) values ('ig', 'instagram_dm', 'instagram', 'sender-1');
  begin
    insert into public.leads (full_name, source, external_source, external_id) values ('ig2', 'instagram_dm', 'instagram', 'sender-1');
    raise exception 'duplicate external identity accepted';
  exception when unique_violation then null;
  end;
end $$;
select 'reliability ok' as result;
rollback;
