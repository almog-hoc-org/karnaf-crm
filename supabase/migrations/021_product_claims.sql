-- Karnaf CRM Core - Product claims knowledge base.
--
-- The bot is told *exactly* which product specifics it is authorised to
-- reference. The forbidden-claims filter blocks bad claims after
-- generation; the product_claims table provides the positive set of
-- allowed claims the prompt can lean on. Each row is a single canonical
-- Hebrew sentence the bot may quote/paraphrase, tagged by type so the
-- prompt can present them grouped (features, price, duration, etc.).
--
-- The runtime currently scopes to product_code = 'derech_le_dira' since
-- the system is single-product. The schema is multi-product ready
-- (product_code text not null) so the Phase 5 multi-product scaffold can
-- start filtering by product without a column change.

create table if not exists product_claims (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'derech_le_dira',
  claim_type text not null,
  hebrew_text text not null,
  english_text text,
  validation_notes text,
  is_active boolean not null default true,
  weight int not null default 50,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_user_id uuid references profiles(id) on delete set null
);

alter table product_claims
  add constraint product_claims_type_check check (
    claim_type in ('feature', 'price', 'duration', 'format', 'outcome', 'pace', 'audience', 'guarantee', 'support')
  );

create index if not exists idx_product_claims_active
  on product_claims(product_code) where is_active;

alter table product_claims enable row level security;

drop policy if exists product_claims_staff_read on product_claims;
create policy product_claims_staff_read on product_claims
  for select to authenticated using (public.is_active_staff());

drop policy if exists product_claims_admin_write on product_claims;
create policy product_claims_admin_write on product_claims
  for all to authenticated
  using (public.has_role(array['owner','admin']::user_role[]))
  with check (public.has_role(array['owner','admin']::user_role[]));

drop trigger if exists trg_product_claims_set_updated_at on product_claims;
create trigger trg_product_claims_set_updated_at
  before update on product_claims
  for each row execute function public.set_updated_at();

-- Seed an opening set for the live product so the bot has something
-- concrete to lean on immediately. The owner can edit/replace via the
-- (future) admin UI without redeploy.
insert into product_claims (product_code, claim_type, hebrew_text, weight) values
  ('derech_le_dira', 'audience',   'התוכנית מיועדת לרוכשי דירה ראשונה בישראל.', 90),
  ('derech_le_dira', 'format',     'התוכנית דיגיטלית עם וובינרים, הקלטות וקבצי PDF.', 80),
  ('derech_le_dira', 'duration',   'משך התוכנית גמיש לפי הקצב של הלומד; חומרי הליבה זמינים מיידית.', 70),
  ('derech_le_dira', 'outcome',    'התוכנית בונה תוכנית רכישה מסודרת ומלמדת לזהות עסקאות שוות.', 70),
  ('derech_le_dira', 'support',    'יש מענה אנושי לשאלות בערוצי התקשורת של התוכנית.', 60),
  ('derech_le_dira', 'price',      'התשלום ניתן בפריסה לתשלומים, פרטים מדויקים בעמוד התשלום.', 50)
on conflict do nothing;
