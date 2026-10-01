// Collect replies to email campaigns from Resend and act on them.
//
// Campaign emails carry `reply_to = email_channel.inboundAddress` (an
// address on a Resend receiving domain) once receiving is set up. Every 5
// minutes (pg_cron, migration 135) this:
//   1. lists mail received since the last run (watermark in crm_config),
//   2. fetches each message, ingests it — removal requests ("הסר") revoke
//      email consent at once (חוק הספאם) — via the same path as
//      email-webhook,
//   3. forwards every reply to the owner (email_channel.forwardTo) with a
//      one-line verdict on top, so nothing is lost and he can answer with
//      plain "Reply".
//
// Before 1.10 replies went straight to the owner's gmail, which the CRM
// cannot see: people who answered the 29.9 campaign with "הסר" stayed on
// the list.
//
// Auth: shared worker secret (same as sla-worker / operator-digest).

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { env, optional } from '../_shared/env.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { formatFromAddress, loadEmailChannel } from '../_shared/email-channel.ts';
import {
  getReceivedEmail,
  listReceivedEmails,
  parseAddress,
  sendResendEmail,
  type ReceivedEmailSummary,
} from '../_shared/resend.ts';
import { ingestInboundEmail } from '../_shared/inbound-email.ts';
import { wrapEmailShell } from '../_shared/email-html.ts';

const WATERMARK_KEY = 'email_inbound_watermark';
const MAX_PAGES = 5;
const MAX_PER_RUN = 50;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);
  const correlationId = correlationFromRequest(req);

  const secret = optional('EMAIL_REPLIES_POLL_SECRET') || env.slaWorkerSecret();
  if (!secret) return jsonResponse(req, { error: 'Worker secret not configured' }, 500);
  if (!verifyBearer(req, secret)) return jsonResponse(req, { error: 'Unauthorized' }, 401);

  const supabase = getServiceSupabase();
  const cfg = await loadEmailChannel(supabase);

  const { data: wmRow } = await supabase
    .from('crm_config').select('config_value').eq('config_key', WATERMARK_KEY).maybeSingle();
  const watermark = (wmRow?.config_value ?? {}) as { id?: string; created_at?: string };

  // Walk newest → older until the watermark; first run starts from now so a
  // backlog of unrelated mail is never replayed.
  const fresh: ReceivedEmailSummary[] = [];
  let after: string | undefined;
  let reachedWatermark = false;
  let listError: string | undefined;
  for (let page = 0; page < MAX_PAGES && !reachedWatermark; page++) {
    const res = await listReceivedEmails({ limit: 100, after });
    if (!res.ok) { listError = `${res.status}: ${res.error ?? ''}`; break; }
    for (const m of res.data) {
      const older = watermark.created_at && m.created_at <= watermark.created_at;
      if (m.id === watermark.id || older) { reachedWatermark = true; break; }
      fresh.push(m);
    }
    if (!res.hasMore || res.data.length === 0) break;
    after = res.data[res.data.length - 1]?.id;
  }

  if (listError) {
    // 403/404 here usually means receiving is not enabled on the account yet.
    log.warn('email_replies_list_failed', { fn: 'email-replies-poll', correlationId, err: listError });
    await heartbeat(supabase, correlationId, { listError, processed: 0 });
    return jsonResponse(req, { ok: false, error: listError });
  }

  if (!watermark.created_at) {
    // First run: remember where "now" is and process nothing.
    const newest = fresh[0];
    await saveWatermark(supabase, newest ? { id: newest.id, created_at: newest.created_at } : { created_at: new Date().toISOString() });
    await heartbeat(supabase, correlationId, { initialised: true, skipped: fresh.length });
    return jsonResponse(req, { ok: true, initialised: true, skipped: fresh.length });
  }

  const batch = fresh.reverse().slice(0, MAX_PER_RUN); // oldest first
  const results: Array<Record<string, unknown>> = [];
  for (const summary of batch) {
    const full = await getReceivedEmail(summary.id);
    if (!full.ok || !full.email) {
      log.warn('email_reply_fetch_failed', { fn: 'email-replies-poll', correlationId, id: summary.id, err: full.error });
      break; // retry from here next run — the watermark stays before it
    }
    const email = full.email;
    const sender = parseAddress(email.from);
    // Our own test sends and bounce notices are not replies from leads.
    const ownAddress = sender.email === cfg.fromEmail.toLowerCase();

    const ingest = ownAddress
      ? { status: 'own_address' as const, optOut: false, replyText: '' }
      : await ingestInboundEmail(supabase, {
          from: sender.email,
          fromName: sender.name,
          to: email.to,
          subject: email.subject,
          text: email.text ?? (email.html ? email.html.replace(/<[^>]+>/g, ' ') : ''),
          messageId: email.message_id ?? `resend:${email.id}`,
          correlationId,
          raw: { resend_received_id: email.id, from: email.from, to: email.to, subject: email.subject },
          createLeadIfMissing: false,
          origin: 'email_reply',
        });

    let forwarded = false;
    if (cfg.forwardTo && ingest.status !== 'duplicate') {
      const verdict = ingest.optOut
        ? '✅ הוסר מרשימת הדיוור אוטומטית (ביקש הסרה).'
        : ingest.status === 'unknown_sender'
          ? '⚠️ השולח לא נמצא ב-CRM — לא בוצע שינוי.'
          : 'ℹ️ תשובה רגילה — נשמרה בכרטיס הליד ומחכה לך במסך "היום".';
      const quoted = escapeHtml(email.text ?? '').replace(/\n/g, '<br />');
      const res = await sendResendEmail({
        from: formatFromAddress(cfg),
        to: cfg.forwardTo,
        replyTo: sender.email,
        subject: `[תשובה לדיוור] ${email.subject ?? ''}`.slice(0, 200),
        html: wrapEmailShell(
          `<p><b>${escapeHtml(sender.name ?? sender.email)}</b> &lt;${escapeHtml(sender.email)}&gt; השיב/ה:</p>` +
          `<p>${verdict}</p><hr />` +
          `<div style="color:#475569;">${quoted}</div>`,
          cfg.fromName,
        ),
        tags: [{ name: 'kind', value: 'reply_forward' }],
        idempotencyKey: `reply-forward-${email.id}`,
      });
      forwarded = res.ok;
      if (!res.ok) log.warn('email_reply_forward_failed', { fn: 'email-replies-poll', correlationId, id: email.id, err: res.error });
    }

    results.push({ id: email.id, status: ingest.status, optOut: ingest.optOut, forwarded });
    await saveWatermark(supabase, { id: summary.id, created_at: summary.created_at });
  }

  const removed = results.filter((r) => r.optOut).length;
  await heartbeat(supabase, correlationId, { processed: results.length, removed });
  log.info('email_replies_polled', { fn: 'email-replies-poll', correlationId, processed: results.length, removed });
  return jsonResponse(req, { ok: true, processed: results.length, removed, results });
});

async function saveWatermark(
  supabase: ReturnType<typeof getServiceSupabase>,
  value: { id?: string; created_at: string },
) {
  await supabase.from('crm_config').upsert(
    { config_key: WATERMARK_KEY, config_value: value, updated_at: new Date().toISOString() },
    { onConflict: 'config_key' },
  );
}

async function heartbeat(
  supabase: ReturnType<typeof getServiceSupabase>,
  correlationId: string,
  metadata: Record<string, unknown>,
) {
  await supabase.from('system_heartbeats').upsert({
    name: 'email_replies_poll',
    last_ok_at: new Date().toISOString(),
    last_run_id: correlationId,
    metadata,
  }, { onConflict: 'name' });
}
