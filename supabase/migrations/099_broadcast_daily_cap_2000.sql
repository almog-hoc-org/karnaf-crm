-- 099_broadcast_daily_cap_2000.sql
--
-- Meta raised this number's messaging-limit tier to 2,000 business-
-- initiated conversations per rolling 24h (verified in Meta Business
-- Manager). Lift the broadcast daily cap to match. The per-tick drip
-- (20/min) and the failure-rate auto-pause stay as they are — sends
-- keep going out in spaced batches.

UPDATE public.crm_config
   SET config_value = config_value || jsonb_build_object('daily_cap', 2000)
 WHERE config_key = 'broadcast_pacing';
