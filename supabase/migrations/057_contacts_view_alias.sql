-- 057_contacts_view_alias.sql
--
-- Tier 0.E — symbolic move toward the Contact-centric model.
--
-- The v4 spec's first principle is "ישות אחת שולטת — איש קשר". The
-- current table is named `leads`; renaming it now would touch every
-- edge function and migration in the repo for marginal value, so we
-- introduce a view layer instead. New code can read `contacts` and
-- `contact_activities`; legacy code keeps working against `leads` and
-- `activities`. The physical rename happens at the end of Tier 1 once
-- Partner + Project entities are in, in one decisive migration.
--
-- The views are SECURITY INVOKER (default) so RLS continues to fire
-- against the underlying table — no policy duplication needed.

create or replace view public.contacts as
  select * from public.leads;

comment on view public.contacts is
  'Tier 0.E alias for the Lead-centric `leads` table. The v4 redesign '
  'treats every row as a Contact whose role (lead/student/investor) is '
  'a status, not a separate table. New code should query this view; '
  'legacy code can keep using `leads` until the Tier 1 physical rename.';

create or replace view public.contact_activities as
  select * from public.activities;

comment on view public.contact_activities is
  'Tier 0.E alias mirroring contacts → activities. Same shape as '
  'activities; just lets new code stay in the Contact namespace.';

grant select on public.contacts to authenticated, service_role;
grant select on public.contact_activities to authenticated, service_role;
