# Karnaf CRM Core - Environment, Secrets, and Deployment Map

## Purpose
This document defines how Karnaf CRM Core should be deployed and how secrets and environments should be managed.

The goal is to avoid secret sprawl, unclear ownership, and accidental production breakage.

---

# 1. Environment model

## Required environments
- local/dev
- staging
- production

## Rules
- local/dev is for development and debugging
- staging is for integration testing before production
- production is the only live business system
- no direct experimental coding against production

---

# 2. Main systems

## Supabase
Used for:
- database
- auth
- edge functions
- storage if needed
- operational runtime persistence

## Vercel
Used for:
- frontend deployment
- optional server-side routes if needed
- environment variable hosting for app layer

## WhatsApp provider / Meta app
Used for:
- message send/receive
- webhook registration
- template management
- delivery status callbacks

## Payment provider connection
Used for:
- payment completion signals
- order reference mapping
- purchase state completion

---

# 3. Secret ownership principles

## Never store secrets in
- repo
- markdown docs
- frontend static files
- screenshots
- public drive folders

## Secrets may live in
- Supabase secrets
- Vercel environment variables
- secure local `.env` files
- password manager / secure vault owned by the business

---

# 4. Expected secrets inventory

## Supabase application
- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY

## WhatsApp / Meta / provider
- WHATSAPP_TOKEN
- WHATSAPP_PHONE_ID
- WHATSAPP_VERIFY_TOKEN
- WATI_TOKEN (only if applicable)
- WATI_API_URL (if applicable)
- provider-specific webhook secrets if supported

## AI runtime
- model provider API key(s)
- prompt/config version references if externalized

## Payment integration
- payment webhook secret if available (`PAYMENT_WEBHOOK_SECRET`, HMAC lane)
- `PAYMENT_STATIC_TOKEN` — static ?token= lane for PSPs that can't HMAC
  (currently safelisted to `provider=grow`); generate with
  `openssl rand -hex 24`
- payment provider API token if needed
- product mapping config identifiers (`course_5490` → program track)

## Meta Conversions API (server-side events)
- `META_PIXEL_ID` — Events Manager dataset/pixel id
- `META_CAPI_TOKEN` — CAPI access token (Events Manager > Settings)
- `META_CAPI_TEST_EVENT_CODE` — optional, set temporarily to verify
  wiring in Test Events, then remove
- both META_PIXEL_ID + META_CAPI_TOKEN must be set for events to send;
  absence = feature off (intake/payment flows unaffected)

## App auth / session
- app auth secret(s) if using middleware/session layers

---

# 5. Separation of secrets by environment

## local/dev
Used by:
- developer machine
- local testing only

## staging
Used by:
- test deployment
- non-production webhooks/templates if possible

## production
Used by:
- live customer traffic only

## Rule
Secrets should not be copied casually between environments unless intentionally required.

---

# 6. Vercel deployment model

## Recommended deployment structure
- one primary Vercel project for Karnaf CRM Core web app
- optional preview deployments per branch for frontend review
- production branch clearly defined

## Recommended branch model
- `main` or `master` for stable integration
- feature branches for active development
- production deploys only from agreed stable branch

## Vercel env management
Store only the frontend/server-adjacent secrets Vercel actually needs.
Do not duplicate unnecessary secrets into Vercel if they are only needed inside Supabase edge functions.

---

# 7. Supabase deployment model

## Supabase should own
- database schema
- edge functions
- service-role privileged operations
- message/runtime persistence
- secured backend behavior

## Recommended practices
- version all schema changes as migrations
- version edge functions with the repo
- document all manual dashboard settings required
- restrict service-role exposure to server-only runtime

---

# 8. WhatsApp deployment/integration model

## Recommended production setup
- one dedicated business number for Karnaf CRM
- one Meta/provider configuration mapped to the new system
- webhook target pointing only to the new production runtime

## Transition caution
Do not point the live WhatsApp number at two systems at once.
During migration, ensure only one runtime is the authoritative receiver.

---

# 9. Payment deployment/integration model

## Recommended approach
- payment webhook lands in controlled backend runtime
- webhook validates signature/secret if supported
- payment event is stored before state mutation
- lead resolution to payment should use deterministic matching rules

## Matching priority example
- external order/customer reference
- phone
- email
- fallback manual review queue if ambiguous

---

# 10. Config versus secret distinction

## Secrets
Sensitive values that grant access.
Examples:
- tokens
- private keys
- service role keys

## Config
Operational values safe to manage in DB/app config.
Examples:
- active hours
- queue thresholds
- template names
- escalation windows
- product codes

Do not confuse them.

---

# 11. Recommended `.env` categories

## Frontend-safe public envs
Only values safe for client usage, such as:
- public Supabase URL
- public anon key
- non-sensitive environment labels

## Server-only envs
- service role key
- WhatsApp tokens
- AI provider keys
- payment secrets
- webhook secrets

These must never be exposed to the browser.

---

# 12. Deployment readiness checklist

Before first staging deploy:
- repo structure settled
- schema migrations ready
- env variable list finalized
- WhatsApp provider plan finalized
- webhook URLs known

Before first production deploy:
- staging flow tested
- inbound/outbound WhatsApp tested
- Mia queue tested
- DNC handling tested
- payment callback tested
- logs visible
- rollback plan documented

---

# 13. Rollback philosophy

At minimum, be able to roll back:
- frontend deployment
- edge function deployment
- environment variable changes
- provider webhook target changes

Rollback should be documented before going live.

---

# 14. Operational ownership

## Owner responsibilities
- approve access
- approve production cutover
- control account ownership

## Kobi responsibilities
- define deployment architecture
- define secret map
- define operational rules
- guide cutover sequence

## Developer responsibilities
- implement the deployment shape correctly
- wire envs without leakage
- document required console steps

---

# 15. Recommended next implementation artifact

The developer should receive a concrete secret checklist as a separate operational worksheet, but without actual secret values committed anywhere.

Examples:
- required secret name
- which environment needs it
- who owns it
- where it is stored
- whether rotation is expected

---

# 16. Final recommendation

Karnaf CRM Core should have:
- one clear deployment stack
- one clear secret map
- one clear production runtime
- no scattered credential handling

This will prevent a lot of chaos later.
