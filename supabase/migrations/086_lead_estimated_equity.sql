-- Estimated equity captured by the AI bot during qualification (free text).
alter table public.leads add column if not exists estimated_equity text;
comment on column public.leads.estimated_equity is 'Estimated equity captured by the AI bot (free text, e.g. "300 אלף").';
