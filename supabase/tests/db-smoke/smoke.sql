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
