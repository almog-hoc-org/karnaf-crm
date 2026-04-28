# Karnaf CRM — Deployment Runbook

This is a step-by-step guide for taking the repo to a working production
deployment. Each step lists what to do, where to do it, and what should be
true once it's done.

> **Order matters.** Do the steps in sequence. Pre-flight check at the bottom
> verifies everything is wired correctly before pointing the live WhatsApp
> number at the system.

---

## 0. Prerequisites
- Node 20.x + npm.
- [Supabase CLI](https://supabase.com/docs/guides/cli) `>=1.200`.
- Access to: a Supabase organisation, a Vercel team, Meta Business Manager
  (or WATI), the payment provider (Responder/רב מסר), and an OpenAI account.

---

## 1. Supabase project

1. Create a new project at <https://supabase.com/dashboard>. Choose region
   `eu-central-1` (closest to IL traffic). Note the Project ref.
2. Save these env values in your password manager — you will reuse them:
   - `SUPABASE_URL` (`https://<ref>.supabase.co`)
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (keep server-only)
3. Link the local repo:
   ```bash
   supabase login
   supabase link --project-ref <ref>
   ```
4. Apply migrations and seed:
   ```bash
   supabase db push
   psql "$SUPABASE_DB_URL" -f supabase/seed.sql   # optional, for dev profile
   ```
5. Enable required Postgres extensions in `Database > Extensions`:
   - `pgcrypto` (already used by 001)
   - `pg_cron`
   - `pg_net`
   - `vault` (auto-enabled on Supabase, verify it's there)

---

## 2. Vault secrets (cron auth)

The pg_cron jobs (`karnaf_sla_worker`, `karnaf_nightly_jobs`,
`karnaf_purge_rate_limit`) need to call the Edge Functions with a bearer
token. Store the token once via SQL:

```sql
-- Pick a strong random string. Mirror it into Supabase project secrets as
-- SLA_WORKER_SECRET so the Edge Functions also know it.
select vault.create_secret('paste-the-strong-random-string-here', 'sla_worker_secret');

-- Set the URLs the cron functions will hit.
alter database postgres set app.sla_worker_url = 'https://<ref>.functions.supabase.co/sla-worker';
alter database postgres set app.nightly_jobs_url = 'https://<ref>.functions.supabase.co/nightly-jobs';
```

Both `app.*` settings are read with `current_setting(..., true)` so a
missing value silently no-ops the cron call (verified in
[009_scheduled_jobs.sql](supabase/migrations/009_scheduled_jobs.sql) and
[013_scheduled_nightly.sql](supabase/migrations/013_scheduled_nightly.sql)).

---

## 3. Edge Function secrets

In Supabase: `Project Settings > Edge Functions > Secrets`. Add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | from §1 |
| `SUPABASE_ANON_KEY` | from §1 |
| `SUPABASE_SERVICE_ROLE_KEY` | from §1 |
| `WHATSAPP_TOKEN` | Meta permanent token (or WATI) |
| `WHATSAPP_PHONE_ID` | Meta WABA phone-number id |
| `WHATSAPP_VERIFY_TOKEN` | random string, supplied to Meta webhook config |
| `WHATSAPP_APP_SECRET` | Meta app secret (for X-Hub-Signature-256) |
| `WHATSAPP_FALLBACK_TEMPLATE` | name of approved Hebrew template, e.g. `karnaf_followup_v1` |
| `WATI_TOKEN`, `WATI_API_URL` | only if using WATI instead of Meta |
| `OPENAI_API_KEY` | sk-... |
| `OPENAI_MODEL` | `gpt-4o-mini` (default) |
| `INTAKE_WEBHOOK_SECRET` | random string used by your form provider HMAC |
| `PAYMENT_WEBHOOK_SECRET` | shared secret with payment provider |
| `EMAIL_WEBHOOK_SECRET` | shared secret with the email provider (Mailgun/Postmark/SendGrid) |
| `SLA_WORKER_SECRET` | same string as the vault secret in §2 |
| `CORS_ALLOWED_ORIGINS` | e.g. `https://crm.karnaf.com,http://localhost:5173` |

Deploy all functions:
```bash
supabase functions deploy whatsapp-webhook payment-webhook provider-status-webhook \
  leads-intake email-webhook orchestrate-message sla-worker nightly-jobs send-reply queue-resolve \
  admin-actions dashboard-summary lead-detail leads-list queue-list \
  analytics-summary users-manage prompt-variants
```

The first time you apply migrations 015+ make sure the `whatsapp-media`
storage bucket is private (it's created that way by the migration but worth
verifying in `Storage > Buckets`).

---

## 4. WhatsApp setup (Meta)

1. Create a WhatsApp Business app in Meta Business Manager.
2. Generate a **permanent system-user access token** with
   `whatsapp_business_messaging` + `whatsapp_business_management` scopes →
   `WHATSAPP_TOKEN`.
3. Note the WABA Phone Number ID → `WHATSAPP_PHONE_ID`.
4. Configure the webhook at
   <https://developers.facebook.com/apps/<app-id>/webhooks/>:
   - Callback URL: `https://<ref>.functions.supabase.co/whatsapp-webhook`
   - Verify Token: same as `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to `messages` and `message_status`.
5. Submit the Hebrew follow-up template:
   - Name: `karnaf_followup_v1`
   - Category: `MARKETING`
   - Language: Hebrew
   - Body example: `היי {{1}}, נסיתי להגיע אליך בנוגע להדרך לדירה. אם זה רלוונטי, שלח לי "כן" ונמשיך.`
   - Wait 24-48 hours for Meta approval.

---

## 4b. Email inbound (optional)

If you want email leads to flow into the same CRM:

1. Pick an email provider (Mailgun parsed-message, Postmark inbound, or
   SendGrid inbound parse all work). Configure their inbound parser to POST
   to `https://<ref>.functions.supabase.co/email-webhook`.
2. Sign the body with HMAC-SHA256 using `EMAIL_WEBHOOK_SECRET` and place
   the digest in the `X-Karnaf-Signature` header (most providers can do
   this with a webhook-signing setting; otherwise route through a small
   intermediary).
3. The expected JSON shape is:
   ```json
   {
     "from": "lead@example.com",
     "from_name": "Israel Israeli",
     "subject": "שאלה על התוכנית",
     "text": "...",
     "message_id": "<provider-id>",
     "phone": "+972501234567"
   }
   ```
4. The webhook smart-upserts the lead (phone first, then email), creates an
   `email` conversation, logs the inbound message, and queues `human_handoff`
   for Mia — the AI orchestrator currently only owns the WhatsApp channel.

## 5. Payment provider (Responder/רב מסר)

1. In your Responder/Skooler admin, configure the purchase webhook URL to
   `https://<ref>.functions.supabase.co/payment-webhook`.
2. Share `PAYMENT_WEBHOOK_SECRET` with the provider so they sign the
   webhook with HMAC-SHA256 and place it in `X-Karnaf-Signature` (or
   `X-Signature` / `X-Hub-Signature-256` — all three are accepted).
3. Verify a `payment_status: paid` event flows to the Supabase logs and
   moves the matching lead to `won`.

If your provider can't HMAC-sign, leave `PAYMENT_WEBHOOK_SECRET` empty —
the webhook will accept unsigned payloads. **Not recommended for
production.**

---

## 6. Lead intake source wiring

For each form / landing page that should drop leads into the CRM:

1. Configure the form provider to POST JSON to
   `https://<ref>.functions.supabase.co/leads-intake` with HMAC-SHA256
   signature of the body using `INTAKE_WEBHOOK_SECRET` in
   `X-Karnaf-Signature`.
2. Required JSON fields: at least one of `phone` / `email`.
   Optional: `full_name`, `source`, `source_detail`, `campaign_name`,
   `webinar_name`, `lead_magnet_name`, `city`.
3. Allowed values for `source`:
   `landing_page`, `webinar`, `responder_form`, `lead_magnet`,
   `whatsapp_direct`, `instagram_dm`, `manual_entry`,
   `screenshot_manual`, `unknown`.

---

## 7. First user (Mia / admin)

```bash
# Pick a strong password; the front-end enforces 12+ chars but you can also
# use the Supabase dashboard.
supabase auth admin create-user mia@karnaf.com --password '<strong>'
```

Then run in SQL:
```sql
update profiles set role = 'owner', full_name = 'Mia', is_active = true
where email = 'mia@karnaf.com';
```

From now on, additional users can be created in the UI under
`/users` (visible to owner+admin only).

---

## 8. Frontend (Vercel)

1. Import the repo into Vercel.
2. Project Settings > Environment Variables:
   - `VITE_SUPABASE_URL` = same as §1
   - `VITE_SUPABASE_ANON_KEY` = same as §1
   - `VITE_FUNCTIONS_BASE_URL` = `https://<ref>.functions.supabase.co`
3. Build command: `npm run build`. Output: `dist/`. Install command: `npm ci`.
4. Add the production domain to `CORS_ALLOWED_ORIGINS` in §3 (re-deploy
   functions afterward).

---

## 9. Pre-flight checks

Before pointing real traffic at the system, verify each path manually:

- [ ] `GET /whatsapp-webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=42` returns `42`.
- [ ] Send a test message from a real WhatsApp number → row appears in
  `messages` and orchestrator log shows `orchestrate_completed`.
- [ ] Submit a test form → row appears in `leads`, queue item
  `first_response_due` is created.
- [ ] Trigger a test payment → matching lead transitions to `won`,
  `lead_tasks` rows for onboarding appear.
- [ ] `select * from cron.job` shows `karnaf_sla_worker`,
  `karnaf_nightly_jobs`, `karnaf_purge_rate_limit` enabled.
- [ ] Sign in with Mia, confirm dashboard renders, leads/queue/lead-detail
  load, send a manual reply, log a phone call, mark a lead `won`.
- [ ] Sign in as a non-admin and confirm `/users` redirects.
- [ ] Curl `/admin-actions` without bearer → 401.

---

## 10. Rollback plan

| Layer | Rollback |
|---|---|
| Frontend | `vercel rollback` to last known-good deploy |
| Edge function | `supabase functions deploy <name>` from previous git tag |
| Migration | Forward-only: write a new migration that reverses the change. Do NOT delete migrations from `supabase/migrations/`. |
| WhatsApp routing | Switch the webhook in Meta back to the previous endpoint |
| Cron | `select cron.unschedule('karnaf_sla_worker');` (idempotent) |

---

## 11a. AI prompt A/B rollout

Owner/admin users can manage prompt variants in-app at `/prompts`. The page
maps to the `prompt_variants` table — set `weight` (0-100), toggle
`is_active`, and override `objective` / `guidance` per playbook. Active
weights are normalised at runtime by `pick_prompt_variant`. Outcomes per
variant show up in the Analytics page.

## 11b. Optional: model-driven transcript summary

The rolling conversation summary defaults to a cheap heuristic. To switch
to model-generated summaries, set `crm_config.summary_runtime.mode` to
`"model"`:

```sql
update crm_config
set config_value = jsonb_set(config_value, '{mode}', '"model"')
where config_key = 'summary_runtime';
```

`OPENAI_API_KEY` must be configured for the model path; the orchestrator
silently falls back to the heuristic if the model call fails.

## 11. Day-2 ops

- **Logs**: Supabase Studio > Logs > Edge Functions (filter by `fn` or `correlationId`).
- **Database health**: Supabase Studio > Reports > Performance.
- **Monitoring**: hook up Logflare or Sentry by adding the appropriate env
  in §3 and wiring the front-end with `import.meta.env.VITE_SENTRY_DSN`
  (not yet implemented; add when ready).
- **Backups**: Supabase auto-PITR is on by default. Verify retention
  matches your RPO target in `Project Settings > Database > Backups`.
- **Secrets rotation**: rotate `WHATSAPP_TOKEN` every 90 days, the
  webhook HMAC secrets every 30 days. Update the Vault entry + Edge
  Function secrets together to avoid a brief mismatch window.
