# Runbook — payment-webhook 5xx / unmatched payments

**Symptom:** Customer paid but lead never flipped to `won`, or
payment-webhook logs show repeated 500s.

## Triage (≤ 5 min)

1. **Confirm money actually moved.** Check the payment provider's
   dashboard. Without confirmation do NOT mark the lead `won`.
2. Pull recent payment_events:
   ```sql
   select id, lead_id, external_order_id, payment_status, payload_json
     from payment_events order by created_at desc limit 20;
   ```
3. Check function logs for the exact error.

## Common root causes

### Signature mismatch (PR-A made fail-closed)

After PR-A, missing `PAYMENT_WEBHOOK_SECRET` returns 503. Confirm:

```bash
supabase secrets list | grep PAYMENT_WEBHOOK_SECRET
```

If absent, set + redeploy. Ask provider to retry the event from their
dashboard.

### Unmatched lead

The handler matches `order_id → phone → email`. If none match, the row
goes into `payment_events` with `lead_id IS NULL` and an
`integration_logs` row with `source = 'payment_webhook', status = 'unmatched'`.

Manual fix:

```sql
update payment_events set lead_id = '<lead-id>' where id = '<event-id>';
-- If status indicates paid, also flip the lead:
update leads
   set lead_status = 'won', won_at = now(),
       payment_status = 'paid', payment_reference = '<order-id>'
 where id = '<lead-id>';
```

### Replay path

For genuinely-lost events:

```bash
curl -X POST https://svkzkpgccahwmyflobvn.functions.supabase.co/webhook-replay \
  -H "Authorization: Bearer <admin-jwt>" \
  -d '{"filter":"failed_recent","sourceOnly":"payment","limit":20}'
```

## After the incident

- Postmortem if revenue > $X was at risk.
- Reach out to customer if access was delayed > 1h.
