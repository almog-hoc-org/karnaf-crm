// Smoke check for the runtime RPCs. Skipped unless INTEGRATION_* envs are
// supplied (see integration/README.md). Cleans up the rows it creates so
// the suite is safe to rerun against a shared local Supabase.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.INTEGRATION_SUPABASE_URL;
const key = process.env.INTEGRATION_SERVICE_ROLE_KEY;
const skip = !url || !key;

const createdLeadIds: string[] = [];

const describeIfConfigured = skip ? describe.skip : describe;

describeIfConfigured('runtime RPCs', () => {
  let sb: SupabaseClient;

  beforeAll(() => {
    sb = createClient(url!, key!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it('upsert_lead_smart collapses repeated calls by phone', async () => {
    const phone = `0500000${Math.floor(Math.random() * 9000 + 1000)}`;
    const a = await sb.rpc('upsert_lead_smart', {
      p_phone: phone,
      p_email: null,
      p_full_name: 'Integration A',
      p_source: 'manual_entry',
      p_intake_channel: 'manual',
      p_metadata: {},
    });
    const b = await sb.rpc('upsert_lead_smart', {
      p_phone: phone,
      p_email: 'collapse@karnaf.test',
      p_full_name: null,
      p_source: 'manual_entry',
      p_intake_channel: 'manual',
      p_metadata: {},
    });
    const aRow = (Array.isArray(a.data) ? a.data[0] : a.data) as { id: string };
    const bRow = (Array.isArray(b.data) ? b.data[0] : b.data) as { id: string; email: string | null };
    expect(aRow.id).toBe(bRow.id);
    expect(bRow.email).toBe('collapse@karnaf.test');
    createdLeadIds.push(aRow.id);
  });

  it('transition_lead_status rejects illegal moves', async () => {
    const phone = `0500001${Math.floor(Math.random() * 9000 + 1000)}`;
    const create = await sb.rpc('upsert_lead_smart', {
      p_phone: phone,
      p_email: null,
      p_full_name: 'Integration TXN',
      p_source: 'manual_entry',
      p_intake_channel: 'manual',
      p_metadata: {},
    });
    const row = (Array.isArray(create.data) ? create.data[0] : create.data) as { id: string };
    createdLeadIds.push(row.id);
    const illegal = await sb.rpc('transition_lead_status', {
      p_lead_id: row.id,
      p_target: 'won',
      p_actor_type: 'system',
      p_reason: 'illegal',
    });
    expect(illegal.data).toBeNull();

    const legal = await sb.rpc('transition_lead_status', {
      p_lead_id: row.id,
      p_target: 'first_contact_sent',
      p_actor_type: 'system',
      p_reason: 'legal',
    });
    expect(legal.data).not.toBeNull();
  });

  it('check_rate_limit denies after the configured threshold', async () => {
    const bucket = `it_test_${Date.now()}`;
    let allowedCount = 0;
    for (let i = 0; i < 6; i++) {
      const r = await sb.rpc('check_rate_limit', {
        p_key: bucket,
        p_window_seconds: 60,
        p_max_requests: 4,
      });
      if (r.data === true) allowedCount++;
    }
    expect(allowedCount).toBe(4);
  });

  afterAll(async () => {
    if (createdLeadIds.length > 0) {
      await sb.from('leads').delete().in('id', createdLeadIds);
    }
  });
});
