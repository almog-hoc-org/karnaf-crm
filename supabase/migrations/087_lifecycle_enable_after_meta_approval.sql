-- 087_lifecycle_enable_after_meta_approval.sql
--
-- Recovered 2026-07-09 from production's
-- supabase_migrations.schema_migrations (the file was applied to
-- prod but never committed). Statements are verbatim as recorded
-- by the Supabase CLI at apply time.

-- 087_lifecycle_enable_after_meta_approval.sql
--
-- Keep lifecycle automations dormant until Meta approves the WhatsApp
-- templates. The approval monitor enables these rules after all three
-- template statuses are APPROVED.

update public.automation_rules
   set enabled = false,
       metadata = coalesce(metadata, '{}'::jsonb)
         || jsonb_build_object('enable_after_meta_approval', true),
       updated_at = now()
 where code in (
   'lifecycle_landing_lead_welcome',
   'lifecycle_student_welcome_and_checkins',
   'lifecycle_student_biweekly_checkin'
 );
