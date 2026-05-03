# Karnaf CRM

WhatsApp-first AI-operated CRM for selling the digital program **"הדרך לדירה"**. Inbound leads from forms / WhatsApp / email → AI playbook handles first contact, qualification, and checkout push → Mia (operator) takes over only when needed → payment webhook → onboarding kicks off.

> **Are you a developer joining this project?** Read [HANDOFF.md](HANDOFF.md) first — it's the single source of truth for what's done, what's missing, and the recommended order of work.

## Repo map

| File | What it's for |
|---|---|
| [HANDOFF.md](HANDOFF.md) | Developer onboarding & prioritised backlog |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Step-by-step production setup runbook |
| [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) | Snapshot of what each layer of the codebase contains |
| [karnaf-crm-full-spec.md](karnaf-crm-full-spec.md) | Original product specification (still authoritative for behaviour) |
| `apps/web/` | React 19 operator console (Vite root) |
| `lib/runtime/` | Node-side mirrors of the Deno `_shared` modules — exists so the runtime is unit-testable from Vitest |
| `supabase/migrations/` | 18 SQL migrations: schema, RLS, state-machine RPCs, scheduled jobs, A/B prompts, media storage, cohort analytics |
| `supabase/functions/` | 18 Edge Functions: 5 signed webhooks, 3 cron workers, 10 JWT-gated operator endpoints |
| `e2e/`, `integration/` | Opt-in Playwright + supabase-start harnesses |

## Quickstart (local development)

```bash
npm install
cp .env.example .env       # fill the VITE_* values from your Supabase project
npm run dev                # http://localhost:5173
```

Without a Supabase project you'll see the login screen and can't proceed past it. To run the back end against your own database:

```bash
supabase start             # boots Postgres + Edge Functions on :54321
supabase db reset          # applies migrations + seed.sql
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full production walkthrough.

## Pipeline

```bash
npm run typecheck          # TypeScript strict + noUncheckedIndexedAccess
npm run lint               # ESLint flat config
npm test                   # Vitest unit + component suites
npm run build              # Vite production build
```

CI (`.github/workflows/ci.yml`) runs all four on every push.

Opt-in suites:
```bash
npm run e2e                # Playwright (needs E2E_TEST_EMAIL / E2E_TEST_PASSWORD)
npm run test:integration   # Hits a local `supabase start` (needs INTEGRATION_* env)
```

## Tech stack

- **Database** — Supabase Postgres 15, RLS on every operational table, pg_cron + pg_net for scheduling, Storage for media archival.
- **Backend** — Supabase Edge Functions (Deno), structured JSON logging with correlation IDs, DB-backed rate limiting, signature verification on every public webhook.
- **AI** — OpenAI Chat Completions with a 9-playbook system, forbidden-claim filter, state-machine enforcement, circuit breaker, weighted A/B prompt variants.
- **Frontend** — React 19 + Vite 7 + Tailwind 4 + TanStack Query 5 + React Router 6 + Supabase JS 2, RTL by default, lazy-loaded routes, vendor-split bundle.

## Status

A snapshot of what is and isn't done lives in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md); the prioritised gap list lives in [HANDOFF.md](HANDOFF.md). The system is **deployable today** subject to obtaining the external credentials listed in HANDOFF §6 (Supabase, Meta WhatsApp, OpenAI, payment provider, intake form HMAC).
