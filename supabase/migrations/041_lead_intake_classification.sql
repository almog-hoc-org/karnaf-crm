-- Add operator/AI-facing lead classification fields.
-- These are deterministic intake tags, not final sales judgement; humans can
-- correct them from the CRM and the AI receives them as context.

alter table leads
  add column if not exists inquiry_type text,
  add column if not exists product_interest text,
  add column if not exists intake_segment text,
  add column if not exists classification_confidence text,
  add column if not exists classification_summary text,
  add column if not exists suggested_next_action text,
  add column if not exists handoff_reason text,
  add column if not exists classification_updated_at timestamptz;

create index if not exists idx_leads_inquiry_type on leads(inquiry_type);
create index if not exists idx_leads_product_interest on leads(product_interest);
create index if not exists idx_leads_intake_segment on leads(intake_segment);
