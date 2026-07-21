-- 104_ai_safety_net.sql
--
-- Bot safety net: when the AI pipeline fails to produce a reply (model
-- disabled, circuit open, provider error, validation blocked), the lead
-- used to get silence. orchestrate-message now sends this configurable
-- generic acknowledgment instead, queues a human task, and hands the
-- lead to Mia. Once-per-window stamping rides on lead_events
-- (event_type 'generic_ack_sent') — no schema change needed.

insert into public.crm_config (config_key, config_value)
values (
  'ai_safety_net',
  jsonb_build_object(
    'enabled', true,
    'ackText', 'קיבלנו את הפנייה, נציג מצוות קרנף יחזור אליך בהקדם 🦏',
    'oncePerHours', 24,
    'mode', 'generic'
  )
)
on conflict (config_key) do nothing;
