// integration/handback.spec.ts — Tier 0.G
//
// Locks down the state-machine invariants the AI handback fix relies on.
// The full end-to-end story (customer sends → AI replies → Mia takes
// over → return_to_ai → customer sends → AI replies again) needs OpenAI
// + the dispatch worker; this spec covers the database half of that
// chain so a future migration that tightens transition_lead_status
// cannot silently break the fix from commit ad3e64f without the test
// failing first.
//
// Skipped unless INTEGRATION_SUPABASE_URL / INTEGRATION_SERVICE_ROLE_KEY
// are supplied, matching the convention in integration/orm.spec.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.INTEGRATION_SUPABASE_URL;
const key = process.env.INTEGRATION_SERVICE_ROLE_KEY;
const skip = !url || !key;

const createdLeadIds: string[] = [];
const describeIfConfigured = skip ? describe.skip : describe;

describeIfConfigured('AI handback state machine (Tier 0.G)', () => {
  let sb: SupabaseClient;

  beforeAll(() => {
    sb = createClient(url!, key!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  afterAll(async () => {
    if (!createdLeadIds.length) return;
    await sb.from('leads').delete().in('id', createdLeadIds);
  });

  async function freshLead(phoneSeed: number) {
    const phone = `0500000${phoneSeed.toString().padStart(4, '0')}`;
    const res = await sb.rpc('upsert_lead_smart', {
      p_phone: phone,
      p_email: null,
      p_full_name: 'Handback Test',
      p_source: 'integration_test',
    });
    expect(res.error).toBeNull();
    const id = res.data as string;
    createdLeadIds.push(id);
    return id;
  }

  it('walks lead_status from human_handoff back to responded when AI resumes', async () => {
    // This transition is what admin-actions/return_to_ai relies on to
    // un-park a lead that Mia handed off. If transition_lead_status ever
    // rejects this path, the AI silently stays parked at human_handoff
    // and never replies again — the exact bug the v3 fix closed.
    const leadId = await freshLead(2001);

    // Stage the lead the way the bot would have left it just before
    // Mia took over: AI is reading, fresh state.
    await sb.from('leads').update({ lead_status: 'responded' }).eq('id', leadId);

    // Mia takes the lead.
    const toHandoff = await sb.rpc('transition_lead_status', {
      p_lead_id: leadId, p_target: 'human_handoff', p_actor_type: 'mia', p_reason: 'integration_test',
    });
    expect(toHandoff.error).toBeNull();

    // Mia returns the lead to the AI — this is the transition the bug
    // fix depends on.
    const backToResponded = await sb.rpc('transition_lead_status', {
      p_lead_id: leadId, p_target: 'responded', p_actor_type: 'mia', p_reason: 'manual_return_to_ai',
    });
    expect(backToResponded.error).toBeNull();
    expect(backToResponded.data).toBeTruthy();

    const after = await sb.from('leads').select('lead_status, ownership_mode').eq('id', leadId).single();
    expect(after.error).toBeNull();
    expect(after.data?.lead_status).toBe('responded');
  });

  it('records the handback walk-back in lead_events for audit', async () => {
    // Every transition_lead_status call logs to lead_events. The Mia
    // operator UI surfaces this audit line when explaining "why did
    // status change?" — losing it would make handback debugging
    // mysterious for whoever inherits this code.
    const leadId = await freshLead(2002);
    await sb.from('leads').update({ lead_status: 'human_handoff' }).eq('id', leadId);

    await sb.rpc('transition_lead_status', {
      p_lead_id: leadId, p_target: 'responded', p_actor_type: 'mia', p_reason: 'manual_return_to_ai',
    });

    const events = await sb
      .from('lead_events')
      .select('event_type, event_payload')
      .eq('lead_id', leadId)
      .eq('event_type', 'lead_status_changed')
      .order('created_at', { ascending: false })
      .limit(1);

    expect(events.error).toBeNull();
    expect(events.data?.length).toBeGreaterThan(0);
    const payload = events.data?.[0]?.event_payload as { from?: string; to?: string; reason?: string } | null;
    expect(payload?.from).toBe('human_handoff');
    expect(payload?.to).toBe('responded');
    expect(payload?.reason).toContain('return_to_ai');
  });

  it('mirrors the status change into activities via the trigger from migration 054', async () => {
    // Tier 0.A's trigger is the bridge that makes status changes visible
    // in the Universal Record Screen timeline. If a future migration
    // disables trg_sync_lead_event_to_activity, the operator would still
    // see correct DB state but the feed would silently miss the audit
    // line — which is exactly the kind of fall-between-chairs bug the
    // v4 plan is fighting.
    const leadId = await freshLead(2003);
    await sb.from('leads').update({ lead_status: 'human_handoff' }).eq('id', leadId);

    await sb.rpc('transition_lead_status', {
      p_lead_id: leadId, p_target: 'responded', p_actor_type: 'mia', p_reason: 'manual_return_to_ai',
    });

    // Give the trigger a moment to settle (Supabase JS pools commit fast
    // but tests can race ahead of replication).
    await new Promise((resolve) => setTimeout(resolve, 200));

    const activities = await sb
      .from('activities')
      .select('activity_type, title, payload')
      .eq('contact_id', leadId)
      .eq('source_table', 'lead_events')
      .order('occurred_at', { ascending: false });

    expect(activities.error).toBeNull();
    const statusChange = activities.data?.find((a) => a.title === 'lead_status_changed');
    expect(statusChange).toBeDefined();
    expect(statusChange?.activity_type).toBe('event');
    const payload = statusChange?.payload as { from?: string; to?: string } | null;
    expect(payload?.from).toBe('human_handoff');
    expect(payload?.to).toBe('responded');
  });
});
