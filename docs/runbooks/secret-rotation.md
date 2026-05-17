# Runbook — Secret rotation

**When to run:** quarterly (schedule it), AND immediately if any secret
is suspected leaked.

## Inventory

| Secret | Where | Source |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel + Supabase fn env | Dashboard → API → Reset |
| `SUPABASE_ANON_KEY` (= `VITE_SUPABASE_ANON_KEY`) | Vercel | Same |
| `INTAKE_WEBHOOK_SECRET` | Vercel relay + Supabase fn | `openssl rand -hex 32` |
| `PAYMENT_WEBHOOK_SECRET` | Supabase fn env | Payment provider dashboard |
| `EMAIL_WEBHOOK_SECRET` | Supabase fn env | Email provider dashboard |
| `WHATSAPP_APP_SECRET` | Supabase fn env | Meta App → Basic |
| `OPENAI_API_KEY` | Supabase fn env | platform.openai.com |
| `TELEGRAM_BOT_TOKEN` | Supabase fn env | @BotFather → `/revoke` + reissue |

## Procedure (one secret at a time)

1. Generate new value at the rotation source.
2. Set in both places:
   ```bash
   # Vercel
   vercel env add <NAME> production
   # Supabase
   supabase secrets set <NAME>=<value> --project-ref svkzkpgccahwmyflobvn
   ```
3. Redeploy consumer:
   - Frontend (Vercel) auto-redeploys ~5 min after env change.
   - Edge Functions: `supabase functions deploy <name>` (or all).
4. Verify with a smoke call (webhook curl, auth login, AI invocation).
5. Revoke old value at rotation source.

## Special cases

### Service-role key

Load-bearing for every Edge Function. Plan a short maintenance window:

1. Set `MAINTENANCE_MODE=true` in Vercel + redeploy.
2. Rotate service_role key.
3. Update both Vercel + Supabase secrets.
4. Redeploy all functions.
5. Set `MAINTENANCE_MODE=false`, redeploy.

~5 min total downtime.

### Meta App Secret

After rotation, every active Meta webhook subscription (WhatsApp/IG)
needs re-validation. Meta Dashboard → Webhooks → click "Test" on each
card. Failed tests → re-add the URL.

## Log

| Date | What rotated | Reason | Operator |
|------|--------------|--------|----------|
| _pending first rotation_ | — | — | — |
