# E2E (Playwright)

These suites are **opt-in** — they hit a real Supabase project plus the Vite
dev server and are not part of the default `npm test` run.

## Setup

```bash
npm install
npx playwright install chromium
```

Provide a `.env` at the repo root with at least:

```
VITE_SUPABASE_URL=https://<staging-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<staging-anon-key>
VITE_FUNCTIONS_BASE_URL=https://<staging-ref>.functions.supabase.co
E2E_TEST_EMAIL=mia+e2e@karnaf.local
E2E_TEST_PASSWORD=<password from §7 of DEPLOYMENT.md>
```

Then run:

```bash
npm run e2e           # headless
npm run e2e:headed    # opens a visible Chrome window
```

If you already have the dev server running on another port, set
`E2E_BASE_URL` to skip Playwright's auto-start.

## What's covered

* `login.spec.ts` — login flow + redirect to dashboard. Smoke check that the
  Supabase-auth wiring, route protection, and the Hebrew copy all align.

These should grow over time. Suggested next flows:

* Lead detail manual-reply round-trip (mock outbound provider).
* Queue resolve action visible to mia.
* Prompt-variants admin form (admin-only redirect + create/update).
