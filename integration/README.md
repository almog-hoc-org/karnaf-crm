# Integration tests

These run against a live Supabase instance — typically the local one started
by the Supabase CLI. They are **not part of `npm test`**; trigger them
explicitly with `npm run test:integration` after the env is wired.

## Prerequisites

```bash
supabase start         # boots Postgres + Edge Functions on :54321
supabase db reset      # applies all migrations + seed.sql
```

`supabase start` prints the local anon + service-role keys. Export them:

```bash
export INTEGRATION_SUPABASE_URL=http://localhost:54321
export INTEGRATION_SERVICE_ROLE_KEY=<the printed service_role key>
```

You can use `supabase functions serve` in another terminal so the Edge
Functions are reachable at `http://localhost:54321/functions/v1`.

## Layout

* `integration/orm.spec.ts` — verifies the migrations + RPCs (smart upsert,
  state-machine RPC, prompt-variant selector) behave atomically against a
  real Postgres.
* `integration/edge.spec.ts` — round-trips through the Edge Functions via
  HTTP, exercising the rate limiter + auth guards.

Each spec self-skips if `INTEGRATION_SUPABASE_URL` is missing so plain
`vitest run` stays clean.

## Adding a spec

```ts
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const url = process.env.INTEGRATION_SUPABASE_URL;
const key = process.env.INTEGRATION_SERVICE_ROLE_KEY;
const skip = !url || !key;

(skip ? describe.skip : describe)('upsert_lead_smart', () => {
  it('returns the same row when called twice with same email', async () => {
    const sb = createClient(url!, key!);
    const a = await sb.rpc('upsert_lead_smart', { p_phone: null, p_email: 'x@y.test' });
    const b = await sb.rpc('upsert_lead_smart', { p_phone: null, p_email: 'x@y.test' });
    expect(a.data?.id).toBe(b.data?.id);
  });
});
```
