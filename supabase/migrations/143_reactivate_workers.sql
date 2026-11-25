-- 143_reactivate_workers.sql
--
-- The production ops report of 2026-11-24 found five pg_cron jobs with
-- active = false: karnaf_sla_worker, karnaf_ai_watchdog,
-- karnaf_operator_digest, karnaf_daily_sales_inbox, karnaf_template_sync.
-- Their heartbeats stop at 2026-11-05 06:1x UTC. Nothing in this repository
-- deactivates a job (no cron.alter_job / unschedule outside the one-off
-- history drain), so it was done by hand; the owner did not recognise it
-- as theirs and asked for all of them back (24.11). Since then there was no
-- SLA scan, no AI watchdog, no hourly digest, no morning "today" inbox and
-- no nightly template sync.
--
-- The automation rule b6_hot_lead_no_reply_48h was switched off in the
-- same period. It is a time.elapsed rule: with AUTOMATION_TIME_RULES unset
-- it only appears in the dry-run report, so enabling it sends nothing.
-- Going live stays a per-rule decision of the owner.
--
-- Idempotent: only rows that are actually inactive are touched.

select cron.alter_job(jobid, active := true)
  from cron.job
 where jobname in (
   'karnaf_sla_worker', 'karnaf_ai_watchdog', 'karnaf_operator_digest',
   'karnaf_daily_sales_inbox', 'karnaf_template_sync'
 )
   and not active;

update public.automation_rules
   set enabled = true
 where code = 'b6_hot_lead_no_reply_48h'
   and not enabled;
