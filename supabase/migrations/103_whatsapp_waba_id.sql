-- 103_whatsapp_waba_id.sql
--
-- Pin the WhatsApp Business Account id (supplied by the operator from
-- Meta Business Manager). meta-template-status resolves the WABA from
-- this config key, since the token cannot read the field off the
-- phone-number node (Graph #100).

insert into public.crm_config (config_key, config_value)
values ('whatsapp_waba_id', '"1011670828704610"'::jsonb)
on conflict (config_key) do update set config_value = excluded.config_value;
