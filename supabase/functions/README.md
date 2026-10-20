# supabase/functions

> **Registry: `supabase/config.toml`.** Every function directory must have a
> `[functions.<name>]` entry there (`verify_jwt` true/false) — CI fails
> otherwise. The list below is the original design note and covers only the
> first wave; `ls supabase/functions` + `config.toml` are the current truth.
> Auth styles: Meta HMAC webhooks and bearer-secret cron workers run with
> `verify_jwt = false` and verify inside; operator endpoints use
> `requireStaff` (JWT + profile role).

Public, signature-verified webhooks (no JWT required):
- `whatsapp-webhook` — Meta / WATI inbound message webhook. Verifies `X-Hub-Signature-256` against `WHATSAPP_APP_SECRET`.
- `payment-webhook` — payment completion / pending / failure ingestion. HMAC verified against `PAYMENT_WEBHOOK_SECRET`.
- `provider-status-webhook` — delivery / read / failed status callbacks.
- `leads-intake` — form / lead-magnet / manual lead intake. HMAC verified against `INTAKE_WEBHOOK_SECRET`.

Service-role-only internal endpoints:
- `orchestrate-message` — invoked by `whatsapp-webhook` after persisting an inbound message. Loads context, calls the AI decision service, sends the reply, and writes CRM state. Requires bearer auth equal to `SUPABASE_SERVICE_ROLE_KEY`.
- `sla-worker` — invoked by `pg_cron` every 10 minutes. Emits SLA-risk and dormant queue items. Bearer auth = `SLA_WORKER_SECRET` (or service role key as fallback).

Authenticated operator endpoints (Supabase JWT required, profile.role checked):
- `dashboard-summary`
- `lead-detail`
- `leads-list`
- `queue-list`
- `admin-actions` — assign_to_mia / return_to_ai / mark_phone_escalation / mark_dnc / mark_lost / mark_won / resolve_queue.
- `send-reply` — manual outbound from Mia / sales rep.
- `queue-resolve` — close a work-queue entry with a resolution note.

Shared modules under `_shared/`:
- `env.ts`, `cors.ts`, `logger.ts` — environment access, CORS allowlist, structured JSON logger.
- `auth.ts` — JWT verification + role gate.
- `webhook-signature.ts` — Meta + HMAC + bearer signature helpers.
- `supabase.ts` — service-role and request-scoped Supabase clients.
- `lead-service.ts` — race-safe upsert, conversation creation, state-machine transitions.
- `queue-service.ts`, `task-service.ts` — work_queue / lead_tasks helpers.
- `whatsapp-provider.ts` — provider-aware send (freeform + template) with retries.
- `ai-contract.ts`, `ai-prompt.ts`, `ai-validation.ts`, `ai-decision-service.ts` — AI runtime.
- `playbooks.ts`, `forbidden-claims.ts` — policy layer.
- `transcript-summary.ts` — rolling summary maintenance.
- `state-machine.ts`, `conversation-window.ts`, `conversation-lock.ts`, `circuit-breaker.ts`, `idempotency.ts`.

See `supabase/config.toml` for `verify_jwt` settings and `karnaf-crm-env-secrets-deploy-map.md` for the secret inventory.
