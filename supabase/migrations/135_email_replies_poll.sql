-- 135_email_replies_poll.sql
--
-- Replies to the 29.9 email campaign went straight to the owner's gmail
-- (email_channel.replyTo), which the CRM cannot see. People who wrote
-- "הסר" stayed on the list; only the 5 who clicked the unsubscribe link
-- were removed. From now on replies go to an address on a Resend receiving
-- domain and the CRM collects them every 5 minutes (email-replies-poll):
-- a removal request revokes email consent at once, and every reply is
-- forwarded to the owner.
--
-- This migration only prepares it. replyTo is NOT switched here: until the
-- owner adds the receiving MX record in DNS, mail to the inbound address
-- would bounce. The switch happens after a verified test (ops workflow).

-- ── 1. Config ──────────────────────────────────────────────────────────
update public.crm_config
   set config_value = config_value
         || jsonb_build_object(
              'inboundAddress', coalesce(nullif(config_value->>'inboundAddress', ''), 'reply@reply.karnafnadlan.com'),
              'forwardTo', coalesce(nullif(config_value->>'forwardTo', ''),
                                    nullif(config_value->>'replyTo', ''), 'karnaf.yazamut@gmail.com')),
       updated_at = now()
 where config_key = 'email_channel';

-- ── 2. Cron caller (same shape as run_operator_digest, 122) ────────────
create or replace function public.run_email_replies_poll()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_url text := current_setting('app.email_replies_poll_url', true);
  v_secret text;
begin
  begin
    select decrypted_secret into v_secret
      from vault.decrypted_secrets
     where name = 'sla_worker_secret'
     order by created_at desc
     limit 1;
  exception when others then
    v_secret := null;
  end;

  if v_url is null or v_url = '' then
    v_url := 'https://svkzkpgccahwmyflobvn.supabase.co/functions/v1/email-replies-poll';
  end if;

  if v_secret is null or v_secret = '' then
    raise notice 'sla_worker_secret not set in vault; skipping email replies poll';
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('trigger', 'cron')
  );
end;
$$;

revoke all on function public.run_email_replies_poll() from public;
grant execute on function public.run_email_replies_poll() to service_role;

-- 2,7,12,… past the hour: away from the :00 / :10 / :20 jobs.
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'karnaf_email_replies_poll') then
    perform cron.schedule('karnaf_email_replies_poll', '2-59/5 * * * *',
      $cmd$ select public.run_email_replies_poll(); $cmd$);
  end if;
end $$;
