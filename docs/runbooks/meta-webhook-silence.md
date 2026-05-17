# Runbook — Meta webhook (WhatsApp/IG) stopped delivering

**Symptom:** no inbound messages for > 30 min during business hours,
or `/admin/health` shows last-inbound > expected SLA window.

## Triage (≤ 5 min)

1. Check Supabase logs for `whatsapp-webhook` — are POSTs arriving at all?
   - If yes (POSTs arrive but fail to process): jump to "handler broken".
   - If no (no POSTs at all): jump to "Meta stopped delivering".
2. Confirm last delivery time:
   ```sql
   select max(received_at) from webhook_inbox where source = 'whatsapp';
   ```

## Meta stopped delivering

1. Meta App Dashboard → your app → Webhooks. Each subscription shows
   "Recent events" with green/red dots.
2. Common red flags:
   - **Verify token mismatch:** confirm `WHATSAPP_VERIFY_TOKEN` matches
     the subscription's saved value.
   - **Cert expired:** curl `https://...functions.supabase.co/whatsapp-webhook`
     externally → 401 (missing signature) is the expected response.
   - **Subscription disabled:** Meta auto-disables webhooks that 500
     consistently. Re-enable + click "Test" in the Dashboard.

## Handler broken

1. Look at `webhook_inbox` rows with `processed_status = 'server_error'`
   in the last hour:
   ```sql
   select id, source, error_message, received_at
     from webhook_inbox
    where processed_status = 'server_error'
      and received_at > now() - interval '1 hour'
    order by received_at desc;
   ```
2. Find the most recent `error_message`; usually points at the bug.
3. Patch + redeploy: `supabase functions deploy whatsapp-webhook`.
4. Replay the failed rows:
   ```bash
   curl -X POST https://svkzkpgccahwmyflobvn.functions.supabase.co/webhook-replay \
     -H "Authorization: Bearer <admin-jwt>" \
     -H "Content-Type: application/json" \
     -d '{"filter":"failed_recent","limit":50,"sourceOnly":"whatsapp"}'
   ```

## After the incident

- Set BetterUptime monitor on `/healthz?deep=1` if not already done.
- Postmortem if outage > 1 h.
