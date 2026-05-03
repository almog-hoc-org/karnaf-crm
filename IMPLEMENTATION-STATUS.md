# Karnaf CRM Core - Implementation Status

## Verification (run from repo root)
```bash
npm install
npm run typecheck   # TypeScript strict, noUncheckedIndexedAccess - 0 errors
npm run lint        # ESLint flat config - 0 errors
npm test            # Vitest - 151 tests passing (77 runtime + 74 frontend)
npm run build       # Vite production build with route-level code splitting
```

For a fresh deploy, follow [DEPLOYMENT.md](DEPLOYMENT.md) end-to-end.

## Database (Supabase)
Migrations under `supabase/migrations/`:

| # | File | Purpose |
|---|---|---|
| 001 | `001_initial_schema.sql` | Core tables: leads, conversations, messages, lead_events, work_queue, lead_tasks, payment_events, integration_logs, ai_decisions, crm_config |
| 002 | `002_profiles_and_auth.sql` | `profiles` table + `user_role` enum + `auth.users` trigger + role helpers + FKs |
| 003 | `003_constraints_and_indexes.sql` | Check constraints on every controlled enum, unique partial on `leads.phone`, unique on `messages.provider_message_id` and `payment_events.external_order_id`, perf indexes |
| 004 | `004_triggers.sql` | `updated_at` maintenance, conversation activity sync, lead direction-specific timestamp sync from `messages` |
| 005 | `005_rls_policies.sql` | RLS enabled on every operational table, staff-only read via `is_active_staff()`, restrictive insert block on authenticated |
| 006 | `006_analytics_views.sql` | `v_source_performance`, `v_conversion_funnel`, `v_lead_aging`, `v_recent_activity`, `v_ai_vs_mia_outcomes` views + `dashboard_summary()` RPC |
| 007 | `007_seed_config.sql` | Idempotent inserts into `crm_config` (active_hours, follow_up_delays, sla_thresholds, product, forbidden_claims, ai_runtime, whatsapp_session) |
| 008 | `008_runtime_rpcs.sql` | `upsert_lead_by_phone`, `try_/release_conversation_lock`, `transition_lead_status` (state-machine enforced in DB) |
| 009 | `009_scheduled_jobs.sql` | pg_cron + pg_net job `karnaf_sla_worker` every 10 min |
| 010 | `010_dedup_and_onboarding.sql` | Email unique index (lower), `upsert_lead_smart` (phone→email→create), `bootstrap_onboarding(lead_id)` + trigger on `won`, queue_type extended with `onboarding_action` |
| 011 | `011_rate_limit.sql` | `webhook_rate_limit` table + `check_rate_limit` RPC + hourly purge cron |
| 012 | `012_retention_and_decay.sql` | `apply_lead_score_decay()`, `purge_removed_pii(days)` (GDPR), `compact_integration_logs(days)` |
| 013 | `013_scheduled_nightly.sql` | pg_cron job `karnaf_nightly_jobs` at 02:00 IL |
| 014 | `014_prompt_variants.sql` | `prompt_variants` table (RLS, admin-write) + `pick_prompt_variant(playbook)` weighted selector + `v_prompt_variant_outcomes` view |
| 015 | `015_media_storage.sql` | Private `whatsapp-media` storage bucket (25 MiB cap, restricted MIME types) + `messages.media_storage_path` column + staff-read policy |
| 016 | `016_email_and_summary_config.sql` | `crm_config` seeds for `email_inbox` and `summary_runtime` (`heuristic` / `model`) |
| 017 | `017_prompt_variants.sql` | `prompt_variants` table (RLS, admin-write) + `pick_prompt_variant(playbook)` weighted selector + `v_prompt_variant_outcomes` view |
| 018 | `018_cohort_analytics.sql` | `v_lead_cohorts` + `v_first_response_times` analytics views for cohort/funnel maturity and first-response SLA |

`supabase/config.toml`, `supabase/seed.sql`, `supabase/functions/README.md` populated.

## Edge Functions (Deno)
**Public, signature-verified webhooks** (`verify_jwt = false`, all rate-limited):
- `whatsapp-webhook` — Meta `X-Hub-Signature-256` HMAC + idempotency on `provider_message_id` + race-safe lead upsert + correlation-id-tagged orchestrator dispatch + background media archival to the `whatsapp-media` bucket.
- `payment-webhook` — HMAC verification + idempotent on `external_order_id` + match priority order_id → phone → email → manual review queue.
- `provider-status-webhook` — delivered/read/failed status callbacks for both Meta and WATI shapes.
- `leads-intake` — HMAC + smart upsert (phone→email→create) + source-specific first-response SLA.
- `email-webhook` — HMAC + smart upsert (phone first, email fallback) + `email` conversation + queues Mia for first turn (AI orchestrator stays scoped to WhatsApp).

**Service-role internal**:
- `orchestrate-message` — bearer-auth gated, advisory lock per conversation, AI decision + validation, freeform/template auto-resolve by 24h window, state-machine transitions, escalation queues, async transcript-summary refresh.
- `sla-worker` — bearer-auth gated, scans for SLA risk/breach/payment-pending/dormant; idempotent.
- `nightly-jobs` — bearer-auth gated, runs lead score decay + PII purge + integration log compaction.

**JWT-protected operator endpoints** (role checked via `requireStaff`):
- `dashboard-summary` — single-RPC dashboard metrics.
- `lead-detail` — full lead + conversations + messages + queue + tasks + events.
- `leads-list` — paginated, filterable, search input escaped against PostgREST `or`.
- `queue-list` — joined to leads.
- `analytics-summary` — source performance, lead aging, recent activity, AI vs Mia outcomes, prompt-variant outcomes, cohort breakdowns, first-response SLA timing.
- `users-manage` — owner/admin only: list profiles, create users (auth.admin.createUser + profile upsert), update role/active.
- `prompt-variants` — owner/admin only: list / create / update / delete A/B variants (weight, prompt_overrides, is_active, notes).
- `admin-actions` — assign_to_mia, return_to_ai, mark_phone_escalation, mark_dnc, mark_lost, mark_won, resolve_queue, log_phone_call.
- `send-reply` — manual outbound from Mia / sales rep.
- `queue-resolve` — closes queue items.

**Shared modules:**
- `env.ts`, `cors.ts`, `logger.ts`, `auth.ts`, `webhook-signature.ts`, `supabase.ts`.
- `lead-service.ts` — `upsertLeadByPhone` (WhatsApp path), `upsertLead` (smart, intake path), state-machine transitions.
- `queue-service.ts`, `task-service.ts`.
- `whatsapp-provider.ts` — Meta + WATI adapters, freeform + template, retries with exp-backoff + jitter.
- `ai-contract.ts`, `ai-prompt.ts`, `ai-validation.ts`, `ai-decision-service.ts` — AI runtime.
- `prompt-variant.ts` — A/B variant selector that consumes `pick_prompt_variant` RPC and feeds `prompt_overrides` (objective + guidance) into the system prompt.
- `media-fetch.ts` — fetches Meta media bytes (image/audio/video/document/sticker), uploads to the `whatsapp-media` bucket, and writes `messages.media_storage_path`. Background-only, never throws back into the webhook.
- `playbooks.ts` (9 playbooks + selector), `forbidden-claims.ts`.
- `transcript-summary.ts` — rolling summary maintenance.
- `state-machine.ts`, `conversation-window.ts`, `conversation-lock.ts`, `circuit-breaker.ts`, `idempotency.ts`.
- `rate-limit.ts` — DB-backed sliding window.

## Frontend (`apps/web`)
React 19 + Vite 7 + Tailwind 4 + TanStack Query 5 + React Router 6 + Supabase JS 2.
Routes are lazy-loaded — each page ships as a separate chunk (~4–10 KB each, gzip).

- `auth/AuthProvider.tsx` + `auth/LoginPage.tsx` + `auth/ProtectedRoute.tsx` — Supabase email/password auth, role pulled from `profiles`, route gating.
- `components/Layout.tsx` — top nav with admin-only links, role badge, sign-out.
- `components/ErrorBoundary.tsx` — top-level boundary with reload action.
- `components/Badge.tsx` — `HeatBadge`, `StatusBadge`, `OwnershipBadge`.
- `pages/DashboardPage.tsx` — KPI cards, conversion funnel bars, queue summary block, top-queue list deep links.
- `pages/LeadsPage.tsx` — paginated table, filters (status, heat, ownership), search.
- `pages/LeadDetailPage.tsx` — header + quick actions + transcript bubble timeline + manual reply box + phone-call log form (sales_rep / mia / admin / owner) + queue/tasks/events panels.
- `pages/QueuePage.tsx` — filtered queue with inline resolve.
- `pages/AnalyticsPage.tsx` — source performance table, aging buckets, AI-vs-Mia outcomes, first-response SLA table, cohort breakdowns, recent activity feed.
- `pages/UsersPage.tsx` — admin-only user provisioning + role / active flag editing.
- `pages/PromptVariantsPage.tsx` — admin-only A/B variant management per playbook (weight, active flag, objective override, guidance bullets, notes, delete).
- `lib/supabase.ts`, `lib/api.ts`, `lib/types.ts`, `lib/format.ts`, `lib/queryClient.ts`, `lib/observability.ts` (Sentry-style POST hook + global error/unhandled-rejection reporters; no-op when `VITE_SENTRY_DSN` unset), `lib/useDebouncedValue.ts`, `lib/useDocumentTitle.ts`, `lib/i18n.ts` (Hebrew + English dictionary seam; `t(key)` reader, `setLocale()` updates `dir`/`lang`) with broader routing of Login / Dashboard / Leads copy through the dictionary seam.
- A11y: `Layout` exposes a "skip to main content" link, `role="navigation"` + `aria-label` on nav, `aria-current="page"` on the active link, `<main id="kf-main" tabIndex={-1}>` so screen readers + keyboard users can jump past the chrome. Toast region has `aria-live="polite"`. Icon-only buttons carry `aria-label`s.
- Routes are lazy-loaded and Vite splits `react-router-dom`, `@tanstack/react-query`, `@supabase/supabase-js` into their own chunks. App shell down to 201 KB raw / 64 KB gzip; no bundle-size warnings.

## DevOps & quality
- `tsconfig.json` strict + `noUncheckedIndexedAccess` + path aliases.
- `vite.config.ts` (Tailwind plugin + alias resolution + envDir).
- `eslint.config.js` (flat, TS + React Hooks + React Refresh).
- `.prettierrc.json`, `.prettierignore`, `.editorconfig`.
- `.env.example` with every secret + frontend env documented.
- `vitest.config.ts` mirroring path aliases.
- `.github/workflows/ci.yml` — typecheck, lint, test, build, plus Supabase config lint and edge function `deno check`.
- `DEPLOYMENT.md` — end-to-end runbook (Supabase project, Vault, secrets, WhatsApp, email, payment, intake, first user, Vercel, pre-flight, rollback, A/B prompt rollout, model summary toggle, day-2 ops).
- `playwright.config.ts` + `e2e/login.spec.ts` — opt-in E2E suite (`npm run e2e`); auto-skips without `E2E_TEST_*` env. README at `e2e/README.md`.
- `vitest.integration.config.ts` + `integration/orm.spec.ts` — opt-in integration suite (`npm run test:integration`) targeting a local `supabase start`. Self-skips without `INTEGRATION_*` env. README at `integration/README.md`.

## Tests (Vitest)
`lib/runtime/`:
- `state-machine.test.ts` — 6 tests: legal forward moves, rejected shortcuts, terminal states, defensive on unknown.
- `phone.test.ts` — 6 tests: separators, prefix conversions, padding, fragment rejection.
- `conversation-window.test.ts` — 7 tests: 24h logic, malformed timestamps, send-mode resolution.
- `forbidden-claims.test.ts` — 5 tests: Hebrew + English, case-insensitive, empty input.
- `ai-validation.test.ts` — 8 tests: DNC suppression, illegal transition, playbook gating, score clamp, claim filtering, JSON-echo rejection, length truncation, escalation→queue auto-fill.
- `webhook-signature.test.ts` — 7 tests: HMAC compute, tampered body rejection, missing/malformed header, empty secret.
- `playbooks.test.ts` — 23 tests: priority ordering (opt-out > phone > payment-pending > price > free-advice), status-driven defaults, Hebrew + English keyword variants, catalog integrity (uniqueness, terminal allowed-statuses).
- `transcript-summary.test.ts` — 10 tests: `firstSentence` cap and terminator handling, `condense` picks every-fourth + last-two with dedup, `synthesise` bucketing per sender role, empty/short input, max-chars cap.
- `client-identifier.test.ts` — 5 tests: Cloudflare/forwarded-for/real-ip precedence, whitespace trim, "unknown" fallback.

`apps/web/src/`:
- `lib/format.test.ts` — 13 tests: STATUS / HEAT / OWNERSHIP / QUEUE label catalogs, `heatBadgeClass`, `formatDateTime` (nullish + invalid + valid), `formatRelative` for "הרגע" / minutes / hours / days windows.
- `components/Badge.test.tsx` — 11 tests: `HeatBadge` Hebrew labels + tone classes + null fallback, `StatusBadge` won/warm/muted/cool tone routing, `OwnershipBadge` warm vs cool routing.
- `components/ErrorBoundary.test.tsx` — 3 tests: passes children through, renders Hebrew fallback panel + reload button when a child throws, logs `[ui-error]` to `console.error`.
- `auth/ProtectedRoute.test.tsx` — 4 tests: shows loading indicator, redirects to `/login` when no session, redirects when session exists but role is null (deactivated profile), renders the outlet when both are present.
- `auth/LoginPage.test.tsx` — 5 tests: renders Hebrew form labels, redirects to `/` when authenticated with role, keeps form visible + warning when session has no role (deactivated profile), forwards entered credentials to `signIn`, surfaces error message returned from `signIn`.
- `components/Layout.test.tsx` — 7 tests: always-visible nav links + outlet, admin-only Users link hidden from `viewer`/`sales_rep`/`mia` and shown to `admin`/`owner`, user email + role badge rendering, `signOut` invoked on the exit button.
- `pages/DashboardPage.test.tsx` — 6 tests: loading indicator, KPI card values from summary, funnel rows with Hebrew labels, pending-queue list with deep links, empty queue state, error message on summary failure.
- `pages/LeadsPage.test.tsx` — 6 tests: loading row, lead links + total count, empty state, search filter forwarded to query (resets offset), prev disabled / next enabled on first full page, next button advances offset.
- `pages/LeadDetailPage.test.tsx` — 9 tests: header + transcript + back link, `mark_won` / `mark_lost` (with `manual_close` note) admin actions, manual reply trims and clears textarea, reply box disabled when `do_not_contact`, queue resolve with `resolved_by_user` note, phone-call log form for `sales_rep`, phone-call form hidden for `viewer`, error message on detail-query failure.
- `pages/UsersPage.test.tsx` — 7 tests: redirects `sales_rep` and `mia` away, renders list + create form for admins, create form forwards entered values, role select dispatches `postUpdateUser`, active checkbox toggles `is_active`, current user's row select + checkbox disabled with `(אתה)` marker.

Test infrastructure: `vitest.config.ts` runs `lib/**/*.test.ts` under node and `apps/web/src/**/*.test.tsx` under happy-dom via `environmentMatchGlobs`. `apps/web/src/test/setup.ts` wires `@testing-library/jest-dom/vitest` matchers and an `afterEach(cleanup)`.

Test coverage has grown beyond the original 151 baseline, including dedicated component suites for AnalyticsPage, QueuePage, PromptVariantsPage and i18n seam checks.

## What's deployable today
- WhatsApp inbound + AI-driven outbound with playbook system, forbidden-claim filter, freeform/template auto-resolution.
- Form intake → smart phone/email dedup → first-response SLA queue.
- Payment webhook → match → `won` → automatic onboarding queue + tasks (via DB trigger).
- SLA worker every 10 min: risk + breach + payment-pending + dormant.
- Nightly worker at 02:00 IL: lead score decay + GDPR PII purge for `removed_by_request` after 30 days + integration log compaction.
- Rate limiting on every public webhook (DB-backed sliding-window bucket).
- Operator console: dashboard, leads, queue, lead detail with manual reply + call log, analytics, user management, all gated by Supabase auth + role.
- CI green on every push.

## Still future work (not blocking deploy)
- Mobile UI smoke test pass on real devices (no remote way to do this; needs hands).
- Outbound email composer (current email channel is inbound-only; outbound replies still flow through WhatsApp or a manual provider).
- Translating the rest of the Hebrew strings via the `t()` seam (some high-traffic flows now use it, but coverage is still partial).
- Expand `e2e/` and `integration/` suites past the smoke specs.
- Wire a real Sentry SDK if the lightweight observability POST hook isn't enough.
