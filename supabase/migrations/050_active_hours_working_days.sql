-- Karnaf CRM Core - make human handoff scheduling explicit.
-- JS day indexes: Sunday=0 ... Saturday=6. Default Israel sales week is Sun-Thu.

insert into crm_config (config_key, config_value)
values ('active_hours', jsonb_build_object(
  'start', '09:00',
  'end', '21:00',
  'timezone', 'Asia/Jerusalem',
  'workingDays', jsonb_build_array(0, 1, 2, 3, 4)
))
on conflict (config_key) do update
set config_value = case
  when crm_config.config_value ? 'workingDays' then crm_config.config_value
  else crm_config.config_value || jsonb_build_object('workingDays', jsonb_build_array(0, 1, 2, 3, 4))
end,
updated_at = now();
