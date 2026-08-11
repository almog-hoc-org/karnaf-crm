-- 117_notifications_config.sql
--
-- Operator notification switches. perInboundTelegram: a Telegram alert
-- (name + snippet + deep link) the moment a human-owned lead writes —
-- the single chokepoints are orchestrate-message's ownership gate and
-- whatsapp-webhook's pending-reply flush branch. Throttled to one alert
-- per lead per 10 minutes via the telegram_inbound_alert lead_event.
-- On by default (the operator asked for aggressive surfacing); turn off
-- with: UPDATE crm_config
--       SET config_value = jsonb_set(config_value, '{perInboundTelegram}', 'false')
--       WHERE config_key = 'notifications';

INSERT INTO public.crm_config (config_key, config_value)
VALUES ('notifications', '{"perInboundTelegram": true}'::jsonb)
ON CONFLICT (config_key) DO NOTHING;
