-- 097_broadcast_pacing_config.sql
--
-- Anti-blocking pacing for broadcasts (read by broadcast-dispatch):
--   per_tick          max recipients enqueued per minutely tick,
--   daily_cap         max broadcast recipients per rolling 24h — keep at
--                     or under the number's Meta messaging-limit tier,
--   pause_min_sample  attempts before the failure guard may trigger,
--   pause_failure_pct failure % that auto-pauses a broadcast.
-- Editable at runtime via crm_config; code falls back to these defaults.

insert into public.crm_config (config_key, config_value)
values (
  'broadcast_pacing',
  jsonb_build_object(
    'per_tick', 20,
    'daily_cap', 250,
    'pause_min_sample', 20,
    'pause_failure_pct', 30
  )
)
on conflict (config_key) do nothing;
