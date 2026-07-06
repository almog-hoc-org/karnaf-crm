-- 082_outbound_send_ledger.sql
--
-- Tier 8.E2 — per-(lead, template, channel) send ledger.
--
-- Migration 075 deferred exactly this: B17 (presale publish → C14) can
-- re-send the same template to the same lead when a project is
-- re-published. The unique constraint here is the dedup primitive; the
-- engine's send_template action opts in via `once: true` — insert
-- before enqueue, conflict → skip.

create table if not exists public.engine_template_sends (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  template_key text not null,
  channel text not null default 'whatsapp',
  sent_at timestamptz not null default now(),
  unique (lead_id, template_key, channel)
);

create index if not exists idx_engine_template_sends_lead
  on public.engine_template_sends(lead_id);

alter table public.engine_template_sends enable row level security;

drop policy if exists engine_template_sends_staff_read on public.engine_template_sends;
create policy engine_template_sends_staff_read on public.engine_template_sends
  for select using (public.is_active_staff());

-- B17: presale publish should reach each lead once per template, ever.
update public.automation_rules
   set actions = (
     select jsonb_agg(
       case
         when a->>'type' = 'send_template' then a || '{"once": true}'::jsonb
         else a
       end
     )
     from jsonb_array_elements(actions) as a
   ),
   updated_at = now()
 where code = 'b17_presale_project_opens'
   and actions is not null;
