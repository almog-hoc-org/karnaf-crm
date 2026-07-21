-- 106_email_broadcasts.sql
--
-- Email channel for broadcasts, delivered through Rav Messer (Responder)
-- list campaigns: broadcast-dispatch creates a dedicated Responder list,
-- pushes the segment into it, then creates + sends the message there.
-- provider_ref tracks the Responder list/message ids per broadcast.
-- Templates gain subject/body_html so emails can be authored in-system.

alter table public.broadcasts
  add column if not exists subject text,
  add column if not exists body_html text,
  add column if not exists provider_ref jsonb not null default '{}'::jsonb;

alter table public.message_templates
  add column if not exists subject text,
  add column if not exists body_html text;

insert into public.crm_config (config_key, config_value)
values (
  'email_channel',
  jsonb_build_object(
    'provider', 'ravmesser',
    'fromName', 'קרנף נדל"ן',
    'fromEmail', 'karnaf.yazamut@gmail.com',
    'requireConsent', true
  )
)
on conflict (config_key) do nothing;
