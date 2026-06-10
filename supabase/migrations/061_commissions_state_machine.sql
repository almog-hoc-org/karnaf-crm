-- 061_commissions_state_machine.sql
--
-- Tier 1.D — make commissions a first-class entity instead of a
-- bookkeeping mental note. Two changes:
--
-- (1) `deals` gets two explicit timestamps the workflow has been
--     hiding in operator memory: when seriousness money came in, and
--     when the contract was signed. These are the two events the
--     commission state machine reacts to.
--
-- (2) New `commissions` table. One row per partner-mediated deal.
--     Status walks pending → to_bill → paid, cancellable from either
--     of the first two. The amount is snapshotted at creation time
--     so a future change to partners.commission_to_karnaf_pct doesn't
--     silently rewrite history.
--
-- Spec § ז B11/B12: the seriousness-paid + contract-signed events fire
-- those two automations. The triggers below realise the database half;
-- the messaging/queue half (notify Karnaf, create a billing task)
-- stays in the application layer where templates and routing live.

alter table public.deals
  add column if not exists seriousness_deposit_paid_at timestamptz,
  add column if not exists contract_signed_at timestamptz;

comment on column public.deals.seriousness_deposit_paid_at is
  'When the lead paid demei retzinut. Triggers commission creation (B11).';
comment on column public.deals.contract_signed_at is
  'When the lead signed the contract. Triggers commission state '
  'transition pending → to_bill (B12).';

-- ─────────────────────────────────────────────────────────────────────
-- The commissions table itself.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.commissions (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null unique references public.deals(id) on delete cascade,
  partner_id uuid not null references public.partners(id) on delete restrict,
  -- Snapshots at creation. The % may drift if Mia updates the partner
  -- record later; the commission row holds the rate that was in force
  -- when the deal triggered. amount_due is value × pct / 100 frozen.
  pct_snapshot numeric(5,2) not null,
  deal_value_snapshot numeric(14,2) not null,
  amount_due numeric(14,2) not null,
  currency text not null default 'ILS',
  status text not null default 'pending' check (status in (
    'pending', 'to_bill', 'paid', 'cancelled'
  )),
  -- Timeline. We log every status entry as its own column rather than
  -- a separate events table for two reasons:
  --   * Each transition has at most one entry per row (the state
  --     machine forbids re-entry).
  --   * Reporting wants "average days from pending to paid" — easier
  --     with these on the same row.
  pending_at timestamptz not null default now(),
  to_bill_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  -- The actual money that hit Karnaf's books, in case it differs from
  -- amount_due (settlement, late fee, partial payment). Defaults to
  -- amount_due when the operator marks paid without overriding.
  amount_received numeric(14,2),
  payment_method text,
  payment_reference text,
  cancellation_reason text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_commissions_status_due
  on public.commissions(status, to_bill_at)
  where status in ('pending', 'to_bill');
create index if not exists idx_commissions_partner_status
  on public.commissions(partner_id, status);

drop trigger if exists trg_commissions_updated_at on public.commissions;
create trigger trg_commissions_updated_at
  before update on public.commissions
  for each row execute function public.set_updated_at();

alter table public.commissions enable row level security;

drop policy if exists commissions_staff_all on public.commissions;
create policy commissions_staff_all on public.commissions
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());

drop policy if exists commissions_partner_self_read on public.commissions;
create policy commissions_partner_self_read on public.commissions
  for select to authenticated
  using (
    partner_id in (
      select p.id from public.partners p
      where p.user_id is not null and p.user_id = auth.uid()
    )
  );

grant select, insert, update, delete on public.commissions to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- Automation B11: deal.seriousness_deposit_paid_at goes non-null →
-- create commission row in 'pending' state.
--
-- Skips silently when the deal has no partner_id (program track deals
-- don't generate partner commissions), or when a commission row
-- already exists (idempotent re-fire).
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.handle_deal_deposit_paid() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_partner partners%rowtype;
  v_amount numeric(14,2);
begin
  -- Only react to the actual transition null → non-null. Updates that
  -- merely touch other columns shouldn't keep re-firing this.
  if NEW.seriousness_deposit_paid_at is null then return NEW; end if;
  if OLD.seriousness_deposit_paid_at is not null then return NEW; end if;
  if NEW.partner_id is null then return NEW; end if;
  -- Already created (e.g., manual insert)? Leave it alone.
  if exists (select 1 from public.commissions where deal_id = NEW.id) then return NEW; end if;

  select * into v_partner from public.partners where id = NEW.partner_id;
  if v_partner.id is null then
    raise warning 'handle_deal_deposit_paid: partner % missing for deal %', NEW.partner_id, NEW.id;
    return NEW;
  end if;

  v_amount := round(coalesce(NEW.value, 0) * v_partner.commission_to_karnaf_pct / 100.0, 2);

  insert into public.commissions (
    deal_id, partner_id, pct_snapshot, deal_value_snapshot, amount_due, currency
  ) values (
    NEW.id, NEW.partner_id, v_partner.commission_to_karnaf_pct,
    coalesce(NEW.value, 0), v_amount, NEW.currency
  );
  return NEW;
end;
$$;

drop trigger if exists trg_deal_deposit_paid on public.deals;
create trigger trg_deal_deposit_paid
  after update of seriousness_deposit_paid_at on public.deals
  for each row execute function public.handle_deal_deposit_paid();

-- ─────────────────────────────────────────────────────────────────────
-- Automation B12: deal.contract_signed_at goes non-null → move
-- commission from pending to to_bill. Idempotent.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.handle_deal_contract_signed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.contract_signed_at is null then return NEW; end if;
  if OLD.contract_signed_at is not null then return NEW; end if;

  update public.commissions
     set status = 'to_bill', to_bill_at = NEW.contract_signed_at
   where deal_id = NEW.id and status = 'pending';
  return NEW;
end;
$$;

drop trigger if exists trg_deal_contract_signed on public.deals;
create trigger trg_deal_contract_signed
  after update of contract_signed_at on public.deals
  for each row execute function public.handle_deal_contract_signed();
