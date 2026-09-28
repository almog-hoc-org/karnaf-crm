// Emit `lead.created` to the automation engine for a lead that an intake
// path has just inserted.
//
// Only leads-intake and website-leads-intake used to emit it, so welcome /
// nurture / email-list rules never saw Facebook Lead Ads or webinar
// registrations. Form-type intakes call this after their upsert.
//
// Deliberately NOT called by the conversational webhooks (WhatsApp,
// Instagram DM): there the customer wrote first and the AI answers in the
// same request — a lead.created welcome template on top of that would
// double-message them.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildLeadContext } from './event-context.ts';
import { runMatchingRules } from './automation-engine.ts';
import { log } from './logger.ts';

// upsert_lead_smart / upsert_lead_by_phone stamp created_at and updated_at
// with the same statement's now() on INSERT and bump only updated_at on a
// match — equality is the "genuinely new" signal (same as
// website-leads-intake). A re-submission must never re-run welcome rules.
export function isNewLeadRow(row: Record<string, unknown>): boolean {
  return typeof row.created_at === 'string' && row.created_at === row.updated_at;
}

// Fail-safe: an automation error must never lose the intake response.
export async function emitLeadCreated(
  supabase: SupabaseClient,
  leadId: string,
  opts: { fn: string; correlationId: string },
): Promise<void> {
  try {
    const lead = await buildLeadContext(supabase, leadId);
    if (!lead) return;
    await runMatchingRules(supabase, {
      triggerEvent: 'lead.created',
      context: { lead },
      contactId: leadId,
      correlationId: opts.correlationId,
    });
  } catch (err) {
    log.warn('lead_created_rules_failed', { fn: opts.fn, correlationId: opts.correlationId, leadId, err: String(err) });
  }
}
