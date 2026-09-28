// WhatsApp channel status, asked of Meta — read-only.
//
// GET → the phone number (name, quality, platform, where Meta sends its
//       events), the WABA's subscribed apps, and a verdict. Owner/admin JWT
//       or the service-role key (ops report). Sends nothing, writes nothing.
//
// Why it exists: from 7.9 to 28.9 the CRM received only delivery receipts
// from Meta and not a single customer message. Nothing in the database can
// tell "nobody wrote" from "Meta sends customer messages elsewhere"; Meta
// can.
//
// verify_jwt = true (required by _shared/service-or-staff.ts).

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError } from '../_shared/auth.ts';
import { authenticateServiceOrStaff } from '../_shared/service-or-staff.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { diagnoseWhatsAppSubscription, resolveWabaId } from '../_shared/whatsapp-diagnostics.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'GET') return jsonResponse(req, { error: 'Method not allowed' }, 405);
  const correlationId = correlationFromRequest(req);

  try {
    await authenticateServiceOrStaff(req);
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();
  const waba = await resolveWabaId(supabase);
  if (!waba.wabaId) {
    return jsonResponse(req, { ok: false, stage: 'waba_lookup', error: waba.error ?? 'No WABA id' });
  }
  const diagnosis = await diagnoseWhatsAppSubscription(waba.wabaId);

  // Last customer message vs last receipt, from our own tables — the other
  // half of the picture.
  const { data: lastInbound } = await supabase
    .from('messages').select('created_at').eq('direction', 'inbound')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  log.info('whatsapp_channel_status', { fn: 'whatsapp-channel-status', correlationId, verdict: diagnosis.verdict });
  return jsonResponse(req, { ok: true, ...diagnosis, lastInboundAt: lastInbound?.created_at ?? null });
});
