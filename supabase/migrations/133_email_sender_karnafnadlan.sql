-- 133_email_sender_karnafnadlan.sql
--
-- The owner verified karnafnadlan.com in Resend (2026-09-28; confirmed by
-- email-channel-status, which asks Resend: status "verified"). Resend
-- refuses to send from the gmail address the channel still used, so every
-- email campaign was blocked at scheduling. Move the sender onto the
-- verified domain.
--
--   fromEmail  info@karnafnadlan.com   (any local part works on a verified
--                                        domain; no mailbox is needed)
--   replyTo    unchanged — karnaf.yazamut@gmail.com, so answers, including
--              "הסר", keep landing in the owner's inbox.
--
-- Only replaces a public-mailbox sender: if the owner already typed an
-- address in Settings → ערוץ מייל, it is left alone.

update public.crm_config
   set config_value = config_value
         || jsonb_build_object('fromEmail', 'info@karnafnadlan.com')
         || case
              when coalesce(config_value->>'replyTo', '') = ''
                then jsonb_build_object('replyTo', coalesce(config_value->>'fromEmail', ''))
              else '{}'::jsonb
            end,
       updated_at = now()
 where config_key = 'email_channel'
   and (
     coalesce(config_value->>'fromEmail', '') = ''
     or lower(split_part(config_value->>'fromEmail', '@', 2)) in (
       'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com',
       'yahoo.com', 'walla.com', 'walla.co.il', 'icloud.com', 'me.com')
   );

do $$
declare v jsonb;
begin
  select config_value into v from public.crm_config where config_key = 'email_channel';
  raise notice 'email_channel: provider=% fromEmail=% replyTo=%',
    v->>'provider', v->>'fromEmail', v->>'replyTo';
end $$;
