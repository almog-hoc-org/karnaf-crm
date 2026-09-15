-- 130_email_provider_resend.sql
--
-- The 2026-09-14 email campaign (311 recipients) failed with "ravmesser not
-- configured": Rav Messer's four API secrets were never provisioned, and
-- broadcast-dispatch could only send through Rav Messer — it read
-- crm_config.email_channel.fromName/fromEmail/requireConsent and ignored
-- `provider` entirely, so flipping the setting changed nothing.
--
-- The dispatcher now honours `provider` and can send through Resend, one
-- message per recipient, with the CRM owning the unsubscribe link. This
-- migration flips the switch and gives the new path the columns it needs.
--
-- IMPORTANT: fromEmail stays as it is on purpose. Resend refuses to send
-- from a public mailbox (karnaf.yazamut@gmail.com), and the scheduling
-- preflight now blocks an email campaign until the owner verifies a domain
-- at https://resend.com/domains and sets a sender address on it
-- (Settings → ערוץ מייל). Failing at the click is the point.

-- ── 1. Per-recipient provider result ───────────────────────────────────
-- Rav Messer sent ONE campaign to a list, so a provider id per recipient
-- was meaningless. Resend returns a message id per send; keeping it makes a
-- single recipient's delivery traceable in the Resend dashboard.
alter table public.broadcast_recipients
  add column if not exists provider_ref jsonb not null default '{}'::jsonb;

comment on column public.broadcast_recipients.provider_ref is
  'Provider result for this recipient: {provider: "resend", id: "<resend message id>"} '
  'on success, {provider, status} on a rejected send. Empty for the Rav Messer '
  'list path, where the campaign — not the recipient — carries the provider ids.';

-- ── 2. Switch the channel to Resend ────────────────────────────────────
-- replyTo keeps the owner's mailbox in the loop: Resend sends FROM the
-- verified domain, but answers (including "הסר", which email-webhook
-- understands) should still land where they always did.
update public.crm_config
   set config_value = jsonb_strip_nulls(
         config_value
         || jsonb_build_object('provider', 'resend')
         || case
              when coalesce(config_value->>'replyTo', '') <> '' then '{}'::jsonb
              else jsonb_build_object('replyTo', coalesce(config_value->>'fromEmail', ''))
            end
       ),
       updated_at = now()
 where config_key = 'email_channel';

-- Seed the key if a fresh environment never ran migration 106's insert.
insert into public.crm_config (config_key, config_value)
values ('email_channel', jsonb_build_object(
          'provider', 'resend',
          'fromName', 'קרנף נדל"ן',
          'fromEmail', '',
          'replyTo', '',
          'requireConsent', true))
on conflict (config_key) do nothing;

do $$
declare v jsonb;
begin
  select config_value into v from public.crm_config where config_key = 'email_channel';
  raise notice 'email_channel: provider=% fromEmail=% replyTo=%',
    v->>'provider', coalesce(nullif(v->>'fromEmail', ''), '(not set)'),
    coalesce(nullif(v->>'replyTo', ''), '(not set)');
end $$;
