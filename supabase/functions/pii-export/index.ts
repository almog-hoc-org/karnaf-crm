// GDPR-style data export: returns every row referencing a single lead
// across the CRM tables, as a single JSON bundle the operator can hand
// to the data subject.
//
// Auth: owner / admin only. Lead is identified by lead_id, phone, or
// email — but the export only ever returns one lead's data (no
// cross-subject leakage).

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

interface ExportInput {
  leadId?: string;
  phone?: string;
  email?: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  let staff;
  try {
    staff = await requireStaff(req, { allow: ['owner', 'admin'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const body = await req.json().catch(() => ({})) as ExportInput;
  const supabase = getServiceSupabase();

  let leadId = body.leadId;
  if (!leadId && body.phone) {
    const normalized = normalizeIsraeliPhone(body.phone);
    if (!normalized) return jsonResponse(req, { error: 'Invalid phone' }, 400);
    const { data } = await supabase.from('leads').select('id').eq('phone', normalized).maybeSingle();
    leadId = data?.id;
  }
  if (!leadId && body.email) {
    const email = body.email.trim().toLowerCase();
    const { data } = await supabase.from('leads').select('id').eq('email', email).maybeSingle();
    leadId = data?.id;
  }
  if (!leadId) return jsonResponse(req, { error: 'No matching lead' }, 404);

  const [
    leadRow, conversations, messages, leadEvents, leadTasks, queueItems,
    aiDecisions, paymentEvents,
  ] = await Promise.all([
    supabase.from('leads').select('*').eq('id', leadId).single(),
    supabase.from('conversations').select('*').eq('lead_id', leadId),
    supabase.from('messages').select('*').eq('lead_id', leadId).order('created_at'),
    supabase.from('lead_events').select('*').eq('lead_id', leadId).order('created_at'),
    supabase.from('lead_tasks').select('*').eq('lead_id', leadId),
    supabase.from('work_queue').select('*').eq('lead_id', leadId),
    supabase.from('ai_decisions').select('*').eq('lead_id', leadId).order('created_at'),
    supabase.from('payment_events').select('*').eq('lead_id', leadId),
  ]);

  if (leadRow.error) return jsonResponse(req, { error: leadRow.error.message }, 500);

  await supabase.from('integration_logs').insert({
    source: 'pii_export',
    status: 'success',
    lead_id: leadId,
    request_data: { exported_by: staff.userId, requested: body },
    response_data: { tables_included: 8 },
  });

  log.info('pii_exported', { fn: 'pii-export', correlationId, by: staff.userId, leadId });

  return jsonResponse(req, {
    ok: true,
    exportedAt: new Date().toISOString(),
    exportedBy: staff.email,
    leadId,
    data: {
      lead: leadRow.data,
      conversations: conversations.data ?? [],
      messages: messages.data ?? [],
      lead_events: leadEvents.data ?? [],
      lead_tasks: leadTasks.data ?? [],
      work_queue: queueItems.data ?? [],
      ai_decisions: aiDecisions.data ?? [],
      payment_events: paymentEvents.data ?? [],
    },
  });
});
