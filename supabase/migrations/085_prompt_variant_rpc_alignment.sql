-- 085_prompt_variant_rpc_alignment.sql
--
-- Recovered 2026-07-09 from production's
-- supabase_migrations.schema_migrations (the file was applied to
-- prod but never committed). Statements are verbatim as recorded
-- by the Supabase CLI at apply time.

-- Karnaf CRM Core - prompt variant schema/RPC production alignment.
--
-- Production drift showed two failures:
-- 1) PostgREST could not see `prompt_variants.lead_segment_filter`, while the
--    deployed prompt-variants function selects it.
-- 2) The legacy `pick_prompt_variant(text)` RPC can fail with an ambiguous
--    `weight` reference because `weight` is both an output column and a table
--    column inside PL/pgSQL.
--
-- This migration is intentionally idempotent and replaces both RPC signatures.

alter table prompt_variants
  add column if not exists lead_segment_filter jsonb not null default '{}'::jsonb;

drop function if exists public.pick_prompt_variant(text);

drop function if exists public.pick_prompt_variant(text, text, text, text);

create or replace function public.pick_prompt_variant(
  p_playbook text,
  p_lead_heat text default null,
  p_lead_source text default null,
  p_lead_status text default null
)
returns table(version text, weight int, prompt_overrides jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  v_total int;
  v_threshold int;
begin
  with eligible as (
    select pv.version, pv.weight, pv.prompt_overrides
    from prompt_variants pv
    where pv.playbook_name = p_playbook
      and pv.is_active
      and pv.weight > 0
      and (
        not (pv.lead_segment_filter ? 'heat')
        or jsonb_array_length(coalesce(pv.lead_segment_filter->'heat', '[]'::jsonb)) = 0
        or p_lead_heat is null
        or pv.lead_segment_filter->'heat' @> to_jsonb(p_lead_heat)
      )
      and (
        not (pv.lead_segment_filter ? 'source')
        or jsonb_array_length(coalesce(pv.lead_segment_filter->'source', '[]'::jsonb)) = 0
        or p_lead_source is null
        or pv.lead_segment_filter->'source' @> to_jsonb(p_lead_source)
      )
      and (
        not (pv.lead_segment_filter ? 'status')
        or jsonb_array_length(coalesce(pv.lead_segment_filter->'status', '[]'::jsonb)) = 0
        or p_lead_status is null
        or pv.lead_segment_filter->'status' @> to_jsonb(p_lead_status)
      )
  )
  select coalesce(sum(eligible.weight), 0)
    into v_total
  from eligible;

  if v_total <= 0 then
    return;
  end if;

  v_threshold := floor(random() * v_total)::int;

  return query
  with eligible as (
    select pv.version, pv.weight, pv.prompt_overrides
    from prompt_variants pv
    where pv.playbook_name = p_playbook
      and pv.is_active
      and pv.weight > 0
      and (
        not (pv.lead_segment_filter ? 'heat')
        or jsonb_array_length(coalesce(pv.lead_segment_filter->'heat', '[]'::jsonb)) = 0
        or p_lead_heat is null
        or pv.lead_segment_filter->'heat' @> to_jsonb(p_lead_heat)
      )
      and (
        not (pv.lead_segment_filter ? 'source')
        or jsonb_array_length(coalesce(pv.lead_segment_filter->'source', '[]'::jsonb)) = 0
        or p_lead_source is null
        or pv.lead_segment_filter->'source' @> to_jsonb(p_lead_source)
      )
      and (
        not (pv.lead_segment_filter ? 'status')
        or jsonb_array_length(coalesce(pv.lead_segment_filter->'status', '[]'::jsonb)) = 0
        or p_lead_status is null
        or pv.lead_segment_filter->'status' @> to_jsonb(p_lead_status)
      )
  ),
  ranked as (
    select e.version,
           e.weight,
           e.prompt_overrides,
           sum(e.weight) over (order by e.version) - e.weight as cumulative_low,
           sum(e.weight) over (order by e.version) as cumulative_high
    from eligible e
  )
  select r.version, r.weight, r.prompt_overrides
  from ranked r
  where v_threshold >= r.cumulative_low
    and v_threshold < r.cumulative_high
  limit 1;
end;
$$;

revoke all on function public.pick_prompt_variant(text, text, text, text) from public;

grant execute on function public.pick_prompt_variant(text, text, text, text) to service_role;
