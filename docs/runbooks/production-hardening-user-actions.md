# Production Hardening — User-Action Runbook

After PRs #6, #7, #8, and #9 land, these are the manual steps the
owner has to take. The slash command `/karnaf-deploy` (registered at
`~/.claude/commands/karnaf-deploy.md`) walks through this file
step-by-step.

> **Status (2026-05-15, post `/karnaf-deploy` run):** Sections 2–6 are ✅ DONE.
> Backend hardening is live in production. Sections 1, 7, and Meta-side carry-overs
> remain — they require browser/desktop access or external tokens.

## ⏳ 1. Rotate Supabase keys + delete leaked tmp files

**Why:** Two files at `~/.openclaw/workspace/tmp_supabase_{auth,login}_check.py`
contain hardcoded Supabase keys (open since 2026-05-03). Rotate first,
then delete.

1. Supabase Dashboard → Project `svkzkpgccahwmyflobvn` → Settings → API → Reset `service_role`.
2. Update `SUPABASE_SERVICE_ROLE_KEY` in Vercel envs + Supabase Function secrets.
3. Reset `anon` key, update `VITE_SUPABASE_ANON_KEY` in Vercel.
4. Redeploy frontend + all functions.
5. Smoke: log in to https://karnaf-crm.vercel.app, open a lead.
6. Delete the tmp files.

## ✅ 2. Protect master branch (DONE 2026-05-15)

Applied via `gh api -X PUT ...` — required checks `lint-test` + `supabase-validate`,
1 review, dismiss stale, no force-push, no deletion.

```bash
gh api -X PUT repos/almog-hoc-org/karnaf-crm/branches/master/protection \
  -F required_status_checks='{"strict":true,"contexts":["lint-test","supabase-validate"]}' \
  -F required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true}' \
  -F enforce_admins=false \
  -F restrictions=null \
  -F allow_force_pushes=false \
  -F allow_deletions=false
```

## ✅ 3. Required webhook secrets (verified 2026-05-15)

All 5 present: `INTAKE_WEBHOOK_SECRET`, `PAYMENT_WEBHOOK_SECRET`,
`EMAIL_WEBHOOK_SECRET`, `WHATSAPP_APP_SECRET`, `SLA_WORKER_SECRET`.

### Reference

Before merging PR-A (#6), confirm:

```bash
supabase secrets list --project-ref svkzkpgccahwmyflobvn
```

Must include:
- `INTAKE_WEBHOOK_SECRET`
- `PAYMENT_WEBHOOK_SECRET`
- `EMAIL_WEBHOOK_SECRET`
- `WHATSAPP_APP_SECRET`
- `SLA_WORKER_SECRET`

Each missing one → that webhook returns 503 after PR-A merges.

## ✅ 4. Apply migrations 027-032 (DONE 2026-05-15)

All 6 migrations applied via `supabase db push --linked --include-all`.
Verified: `job_runs` + `webhook_inbox` tables exist, `work_queue_pending_dedupe`
+ `ix_leads_status_updated_at` indexes exist, 5 new RPCs registered,
`trg_check_ownership_consistency` trigger active, `supabase_realtime`
publication populated with `conversation_claims`, `lead_events`, `leads`,
`messages`, `work_queue` (= **fixes Mia's missing-live-WhatsApp bug**).

### Reference

```bash
cd "C:\Users\mogi\vs code\karnaf crm\karnaf-crm"
supabase db push --project-ref svkzkpgccahwmyflobvn
```

After PR-B + PR-D both merged:

| Migration | What it adds | Phase |
|---|---|---|
| 027_job_runs | Idempotent cron ledger | PR-B |
| 028_work_queue_idempotency | Partial unique index + dormant scan index | PR-B |
| 029_realtime_publication | messages/leads/work_queue/conversation_claims live | PR-B |
| 030_lifecycle_rpcs | dormant_reactivation + handoff_TTL + won_stalled RPCs | PR-D |
| 031_ownership_consistency_trigger | conv vs lead ownership divergence logger | PR-D |
| 032_webhook_inbox | Payload persistence + replay helper | PR-D |

Verify after apply:

```sql
-- Confirm publication has the live tables (was empty before PR-B)
select schemaname, tablename from pg_publication_tables
 where pubname='supabase_realtime' order by tablename;
-- Expect: conversation_claims, leads, messages, work_queue

-- Confirm partial unique index exists
\d+ work_queue
-- Expect: work_queue_pending_dedupe UNIQUE, partial WHERE (status='pending')
```

## ✅ 5. Deploy edge functions (DONE 2026-05-15)

All 13 functions deployed (4 new + 9 updated). After deploy, added
`[functions.healthz] verify_jwt = false` to `supabase/config.toml` and
re-deployed `healthz` so it's publicly reachable for uptime monitors.
The other 3 new functions (`webhook-replay`, `pii-export`, `pii-delete`)
keep `verify_jwt = true` — admin-only via the function's internal role check.

### Reference

After PR-A + PR-B + PR-C + PR-D all merge:

```bash
# Updated
supabase functions deploy email-webhook leads-intake payment-webhook \
  provider-status-webhook whatsapp-webhook nightly-jobs sla-worker \
  admin-actions lead-detail --project-ref svkzkpgccahwmyflobvn

# New
supabase functions deploy healthz webhook-replay pii-export pii-delete \
  --project-ref svkzkpgccahwmyflobvn
```

## 🟡 6. Production smoke checklist

### ✅ Backend-side (verified 2026-05-15 by `/karnaf-deploy`)

- [x] `GET supabase/healthz` → 200 with shallow ok response
- [x] `GET supabase/healthz?deep=1` → 503 (responds, but reports 2 internal mismatches: see follow-ups below)
- [x] `POST leads-intake` no signature → 401 `Invalid signature` (fail-closed)
- [x] `POST payment-webhook` no signature → 401 `Invalid signature` (fail-closed)
- [x] `POST webhook-replay` no auth → 401 (admin gate active)
- [x] `POST pii-export` no auth → 401 (admin gate active)
- [x] `pg_publication_tables` for `supabase_realtime` includes leads/messages/work_queue/conversation_claims/lead_events

### ⏳ Operator/UI-side (need real CRM session + test phone)

- [ ] `curl https://karnaf-crm.vercel.app/api/healthz?deep=1` — currently returns SPA `index.html` (route never wired in Vercel; see follow-up FU-3)
- [ ] Open a test lead in CRM, send WhatsApp inbound from another phone → message appears within 2s (fixes "Mia missing live messages")
- [ ] On test lead in mia_active mode, click "החזרה ל-AI" → check `integration_logs` for `orchestrate-message` invocation within seconds (fixes "AI returns silent after handoff")
- [ ] Lead header shows clear `CurrentOwnerLine` with operator's full name when mia_active
- [ ] `nightly-jobs` invoked twice same day → second response reports `skipped: already_ran_today` (manual trigger required)
- [ ] `POST /functions/v1/webhook-replay {"filter":"failed_recent","limit":3}` with admin JWT → returns results array
- [ ] `POST /functions/v1/pii-export {"leadId":"<test>"}` with admin JWT → returns 8 tables

### Follow-ups discovered in smoke (file as separate issues / a small PR)

- **FU-1** `healthz` deep query is `select crm_config.key ...` — column doesn't exist on prod schema; `db.ok=false`. Fix: query a column that exists (e.g. `select 1` or read `app_settings`).
- **FU-2** `healthz` AI check tests OpenAI key, but production runs Gemini; reports `ai:openai:missing_key`. Fix: make the AI check honor `AI_PROVIDER` and probe whichever key matches.
- **FU-3** Vercel `/api/healthz` route doesn't exist — request falls through to SPA. Either add a Vercel serverless function or remove this line from the runbook.

## 🟡 7. Activate optional features

| Feature | Env vars | Effect |
|---|---|---|
| Telegram alerts | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID` | sla-worker pushes SLA breach digests |
| Uptime monitor | external (BetterUptime) | Probes `/api/healthz?deep=1` every 1 min |

## External Meta/Google blockers (carried over)

- WhatsApp template `karnaf_followup_v1` Meta approval
- IG webhook subscription + `FACEBOOK_PAGE_ACCESS_TOKEN`
- FB Lead Ads webhook
- Form snippet on karnafnadlan.com
- ManyChat External Request setup
- GAS inbound script

## Pilot rollout (after smoke green)

Follow `docs/pilot/scenarios.md` (TBD if not yet written) — 5 personas × 60 min each.
