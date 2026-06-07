// HTTP integration tests for the signed public webhooks. Hits the
// supabase functions serve endpoint at INTEGRATION_FUNCTIONS_BASE_URL
// with valid HMAC signatures and asserts the system responds as
// expected. Skipped unless the optional INTEGRATION_* envs are set so
// `npm run test:integration` stays safe in CI without Supabase running.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHmac } from 'node:crypto';

const supabaseUrl = process.env.INTEGRATION_SUPABASE_URL;
const serviceRoleKey = process.env.INTEGRATION_SERVICE_ROLE_KEY;
const functionsBase = process.env.INTEGRATION_FUNCTIONS_BASE_URL ?? supabaseUrl;
const intakeSecret = process.env.INTEGRATION_INTAKE_SECRET ?? 'integration-secret';

const skip = !supabaseUrl || !serviceRoleKey || !functionsBase;

const createdLeadIds: string[] = [];

function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

const describeIfConfigured = skip ? describe.skip : describe;

describeIfConfigured('public webhooks', () => {
  let sb: SupabaseClient;

  beforeAll(() => {
    sb = createClient(supabaseUrl!, serviceRoleKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it('leads-intake creates a lead and is idempotent on repeat', async () => {
    const phone = `0501234${Math.floor(Math.random() * 900 + 100)}`;
    const payload = JSON.stringify({
      phone,
      full_name: 'Webhook Integration',
      source: 'integration_test',
      utm_campaign: 'integration',
    });
    const signature = signBody(intakeSecret, payload);

    const res = await fetch(`${functionsBase}/functions/v1/leads-intake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Intake-Signature': signature,
      },
      body: payload,
    });
    expect([200, 201, 202]).toContain(res.status);
    const json = (await res.json()) as { ok?: boolean; leadId?: string };
    expect(json.ok).toBe(true);
    if (json.leadId) createdLeadIds.push(json.leadId);

    // Replay must not create a second row when the phone is identical.
    const replay = await fetch(`${functionsBase}/functions/v1/leads-intake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Intake-Signature': signature,
      },
      body: payload,
    });
    expect([200, 201, 202]).toContain(replay.status);

    const { data } = await sb.from('leads').select('id, phone').eq('phone', phone);
    expect((data ?? []).length).toBe(1);
  });

  it('leads-intake rejects missing/invalid signature', async () => {
    const payload = JSON.stringify({ phone: '0509999999', source: 'integration_test' });
    const res = await fetch(`${functionsBase}/functions/v1/leads-intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    expect([401, 403]).toContain(res.status);
  });

  afterAll(async () => {
    if (createdLeadIds.length > 0) {
      await sb.from('leads').delete().in('id', createdLeadIds);
    }
  });
});
