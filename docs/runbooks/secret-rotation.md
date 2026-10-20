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


### EMAIL_UNSUBSCRIBE_SECRET and the service-role key

The per-lead unsubscribe links in marketing email are signed with
`EMAIL_UNSUBSCRIBE_SECRET`; when it is not set, the service-role key is used
instead. Verification accepts tokens signed with EITHER (since 17.10), so:

- **Before rotating the service-role key**, set `EMAIL_UNSUBSCRIBE_SECRET`
  (any long random string) and deploy. Links already in inboxes keep working
  only while the OLD key is still configured as `SUPABASE_SERVICE_ROLE_KEY`,
  so do this at least one campaign before the rotation.
- Rotating `EMAIL_UNSUBSCRIBE_SECRET` itself invalidates every link sent
  before — avoid it; a recipient can always reply "הסר".

### Worker secrets live in two places

The pg_cron callers read their bearer from Supabase Vault
(`vault.decrypted_secrets`) and the Edge Function compares it with a project
secret. Rotating one means `vault.update_secret(<id>, '<new value>')` for
the row whose `name` is the vault name below (`select id, name from
vault.secrets`), then `supabase secrets set` for the project secret, then a
function deploy — otherwise cron calls get 401 and the heartbeat goes
stale. The vault name is NOT the project-secret name, and the fallbacks
differ per worker:

| Vault secret (what the cron sends) | Project secret(s) the function accepts | Cron callers (migration) |
|---|---|---|
| `sla_worker_secret` | `SLA_WORKER_SECRET` | `run_sla_worker` (009), `run_nightly_jobs` (013), `run_daily_sales_inbox` (069), `run_ai_watchdog` (088), `run_template_sync` (098), `run_operator_digest` (122), `run_email_replies_poll` (135) |
| `outbound_dispatch_secret` | `OUTBOUND_DISPATCH_SECRET` — required, no fallback (dispatch-outbound answers 503 when unset) | `run_outbound_dispatch` (042) |
| `broadcast_dispatch_secret`, else `outbound_dispatch_secret` | `BROADCAST_DISPATCH_SECRET`, else `OUTBOUND_DISPATCH_SECRET` | `run_broadcast_dispatch` (094) |
| `automation_tick_secret` | `AUTOMATION_TICK_SECRET` or `SLA_WORKER_SECRET` | `run_automation_tick` (069) |

`OPERATOR_DIGEST_SECRET` and `EMAIL_REPLIES_POLL_SECRET` have no vault entry
of their own: their cron callers send `sla_worker_secret`, and since 20.10
both functions accept either that or the dedicated value. Leave them unset
unless you also change the cron SQL — before 20.10 setting one made it
exclusive, and every cron tick got 401.

## Inventory

Every environment variable an Edge Function reads, and who reads it
(generated 20.10 from `supabase/functions` by scanning every
`Deno.env.get(...)`, `optional(...)`/`required(...)` and `env.<accessor>()`
call, with each accessor mapped to its variable(s) via `_shared/env.ts`).
Each row lists the functions that read the variable directly AND, as
"via _shared: <module>", every `_shared` helper that reads it. A helper's
readers are every function that imports it, so a variable with a `_shared`
reader has a wider blast radius than its direct readers suggest — e.g.
`WHATSAPP_TOKEN` is read by `whatsapp-provider` for every WhatsApp send and
owner alert, not only by `meta-template-status`, and
`SUPABASE_SERVICE_ROLE_KEY` is read by `supabase` (every function) and by
`email-unsubscribe` as the link-signing fallback. An accessor with a
fallback counts as reading both variables (`broadcastDispatchSecret`,
`emailUnsubscribeSecret`).

| Variable | Read by |
|---|---|
| `AI_PROVIDER` | healthz (via _shared: ai-decision-service) |
| `ALERT_EMAIL_FROM` | (via _shared: operator-alert) |
| `ALERT_EMAIL_TO` | (via _shared: operator-alert) |
| `ALERT_WHATSAPP_TEMPLATE` | (via _shared: operator-alert) |
| `ALERT_WHATSAPP_TO` | (via _shared: operator-alert) |
| `AUTOMATION_TICK_SECRET` | automation-tick |
| `AUTOMATION_TIME_RULES` | automation-tick |
| `BROADCAST_DISPATCH_SECRET` | broadcast-dispatch |
| `CORS_ALLOWED_ORIGINS` | (via _shared: cors) |
| `EMAIL_REPLIES_POLL_SECRET` | email-replies-poll |
| `EMAIL_UNSUBSCRIBE_SECRET` | (via _shared: email-unsubscribe) |
| `EMAIL_WEBHOOK_SECRET` | email-webhook |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | fb-leadgen-webhook |
| `GEMINI_API_KEY` | healthz (via _shared: ai-decision-service) |
| `GEMINI_MODEL` | (via _shared: ai-decision-service) |
| `INSTAGRAM_ACCESS_TOKEN` | (via _shared: instagram-provider) |
| `INSTAGRAM_APP_SECRET` | (via _shared: instagram-provider) |
| `INSTAGRAM_BUSINESS_ID` | (via _shared: instagram-provider) |
| `INSTAGRAM_VERIFY_TOKEN` | (via _shared: instagram-provider) |
| `INTAKE_STATIC_TOKEN` | leads-intake |
| `INTAKE_WEBHOOK_SECRET` | leads-intake, make-intake, webinar-events |
| `MAKE_INTAKE_KEY` | make-intake |
| `META_APP_SECRET` | fb-leadgen-webhook, ig-webhook |
| `META_CAPI_TEST_EVENT_CODE` | (via _shared: meta-capi-send) |
| `META_CAPI_TOKEN` | (via _shared: meta-capi-send) |
| `META_GRAPH_VERSION` | fb-leadgen-webhook (via _shared: meta-capi-send) |
| `META_PIXEL_ID` | (via _shared: meta-capi-send) |
| `META_VERIFY_TOKEN` | fb-leadgen-webhook, ig-webhook |
| `OPENAI_API_KEY` | healthz (via _shared: ai-decision-service, transcript-summary) |
| `OPENAI_MODEL` | (via _shared: ai-decision-service, transcript-summary) |
| `OPERATOR_DIGEST_SECRET` | operator-digest |
| `OUTBOUND_DISPATCH_SECRET` | broadcast-dispatch, dispatch-outbound |
| `PAYMENT_STATIC_TOKEN` | payment-webhook |
| `PAYMENT_WEBHOOK_SECRET` | payment-webhook |
| `PORTAL_BASE_URL` | provision-student |
| `PORTAL_SERVICE_ROLE_KEY` | provision-student |
| `PORTAL_SUPABASE_URL` | provision-student |
| `RAVMESSER_C_KEY` | (via _shared: ravmesser) |
| `RAVMESSER_C_SECRET` | (via _shared: ravmesser) |
| `RAVMESSER_U_KEY` | (via _shared: ravmesser) |
| `RAVMESSER_U_SECRET` | (via _shared: ravmesser) |
| `RESEND_API_KEY` | (via _shared: operator-alert, resend) |
| `SLA_WORKER_SECRET` | ai-replay, ai-watchdog, automation-tick, daily-sales-inbox, email-replies-poll, healthz, meta-template-status, nightly-jobs, operator-digest, sla-worker |
| `SUPABASE_ANON_KEY` | make-intake (via _shared: supabase) |
| `SUPABASE_SERVICE_ROLE_KEY` | admin-actions, ai-replay, dispatch-outbound, ig-webhook, orchestrate-message, provision-student (via _shared: email-unsubscribe, service-or-staff, supabase) |
| `SUPABASE_URL` | admin-actions, ai-replay, ai-watchdog, dispatch-outbound, ig-webhook, make-intake, webhook-replay (via _shared: email-unsubscribe, service-or-staff, supabase, whatsapp-diagnostics) |
| `TELEGRAM_ALERT_CHAT_ID` | (via _shared: notify-telegram, operator-alert) |
| `TELEGRAM_ALERT_THREAD_ID` | (via _shared: notify-telegram) |
| `TELEGRAM_BOT_TOKEN` | (via _shared: notify-telegram, operator-alert) |
| `WATI_API_URL` | (via _shared: whatsapp-provider) |
| `WATI_TOKEN` | (via _shared: whatsapp-provider) |
| `WEBHOOK_ALLOW_UNSIGNED` | email-webhook, fb-leadgen-webhook, ig-webhook, instagram-webhook, leads-intake, payment-webhook, provider-status-webhook, webinar-events, whatsapp-webhook |
| `WHATSAPP_APP_SECRET` | provider-status-webhook, whatsapp-webhook |
| `WHATSAPP_FALLBACK_TEMPLATE` | (via _shared: operator-alert) |
| `WHATSAPP_PHONE_ID` | meta-template-status (via _shared: whatsapp-diagnostics, whatsapp-provider) |
| `WHATSAPP_TOKEN` | meta-template-status (via _shared: media-fetch, whatsapp-diagnostics, whatsapp-provider) |
| `WHATSAPP_VERIFY_TOKEN` | whatsapp-webhook |
| `WHATSAPP_WABA_ID` | meta-template-status (via _shared: whatsapp-diagnostics) |

## Log

| Date | What rotated | Reason | Operator |
|------|--------------|--------|----------|
| _pending first rotation_ | — | — | — |
