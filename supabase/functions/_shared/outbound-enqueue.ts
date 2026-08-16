import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// The one way a proactive template leaves the system.
//
// Everything enqueued here inherits the delivery guarantees that live in
// dispatch-outbound + migration 036: the contact guard re-checked at send
// time, retry with 4^n backoff, permanent-error fast-fail, DLQ after 5
// attempts, and the rolling 24h Meta cap (which counts payload.kind =
// 'template', so every producer that goes through this function is
// accounted for).
//
// Journey steps used to call sendWhatsAppTemplate directly, which meant a
// failed lifecycle message was simply lost — no retry, no DLQ, no cap.
// Extracted from automation-engine's enqueue block so both producers share
// one implementation instead of drifting.

export interface EnqueueTemplateInput {
  leadId: string;
  channel: string;
  // Rendered body. Stored for the message record and the operator preview;
  // the actual wire format for a cold send is the Meta template below.
  text: string;
  templateKey: string;
  // Who asked for this send — 'automation_engine' | 'journey' | 'broadcast'.
  source: string;
  metaTemplate?: { name?: string; lang?: string; params?: string[] };
  correlationId?: string | null;
  priority?: number;
  extraPayload?: Record<string, unknown>;
}

export interface EnqueueTemplateResult {
  ok: boolean;
  dispatchId?: string;
  error?: string;
}

export async function enqueueTemplateDispatch(
  supabase: SupabaseClient,
  input: EnqueueTemplateInput,
): Promise<EnqueueTemplateResult> {
  const row: Record<string, unknown> = {
    lead_id: input.leadId,
    payload: {
      kind: 'template',
      channel: input.channel,
      text: input.text,
      template_key: input.templateKey,
      source: input.source,
      ...(input.metaTemplate?.name
        ? {
          meta_template: {
            name: input.metaTemplate.name,
            lang: input.metaTemplate.lang ?? 'he',
            params: input.metaTemplate.params ?? [],
          },
        }
        : {}),
      ...(input.extraPayload ?? {}),
    },
    correlation_id: input.correlationId ?? null,
  };
  if (typeof input.priority === 'number') row.priority = input.priority;

  const { data, error } = await supabase
    .from('outbound_dispatch')
    .insert(row)
    .select('id')
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  return { ok: true, dispatchId: data?.id as string | undefined };
}

// Give back a consumed `once` claim. A transient insert failure must not
// permanently bar the lead from ever receiving this template again.
export async function releaseOnceClaim(
  supabase: SupabaseClient,
  leadId: string,
  templateKey: string,
  channel: string,
): Promise<void> {
  await supabase
    .from('engine_template_sends')
    .delete()
    .eq('lead_id', leadId)
    .eq('template_key', templateKey)
    .eq('channel', channel);
}
