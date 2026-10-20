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
import { verifyAnyBearer } from '../_shared/webhook-signature.ts';
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
import { notifyOperator } from '../_shared/operator-alert.ts';

const WATERMARK_KEY = 'email_inbound_watermark';
const MAX_PAGES = 5;
const MAX_PER_RUN = 50;
// A reply Resend lists but will not hand over (fetch keeps failing), or a
// reply from a non-lead whose forward to the owner keeps failing, blocks
// everything behind it — including later removal requests. After this many
// runs it is skipped, and the owner is told which one.
const MAX_FETCH_FAILURES = 3;

interface Watermark {
  id?: string;
  created_at?: string;
  /**
   * Per-message failure counters (fetch or forward), keyed by the Resend id;
   * an entry is removed once its message is passed or skipped.
   */
  fetchFailures?: Record<string, number>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// An HTML-only reply used to be flattened to one line (tags stripped, no
// newlines), so extractReplyText could not find where the quoted campaign
// began and a reply of "הסר" above it was never recognised. Block-level
// tags become line breaks first; entities are decoded.
export function htmlToReplyText(html: string): string {
  return html
    .replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6]|blockquote|pre|table)\s*>/gi, '\n')
    .replace(/<\s*(style|script)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isNewerThan(a: string | undefined, b: string | undefined): boolean {
  // ISO strings from Resend are comparable, but a watermark saved from a
  // different clock format is not — compare instants, not strings.
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return a !== undefined && b === undefined;
  return ta > tb;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);
  const correlationId = correlationFromRequest(req);

  // pg_cron (135) sends vault `sla_worker_secret`; a dedicated secret is
  // accepted in addition, never instead — exclusive-when-set meant one
  // extra project secret turned every tick into a 401.
  const expectedSecrets = [optional('EMAIL_REPLIES_POLL_SECRET'), env.slaWorkerSecret()].filter(Boolean);
  if (expectedSecrets.length === 0) return jsonResponse(req, { error: 'Worker secret not configured' }, 500);
  if (!verifyAnyBearer(req, expectedSecrets)) return jsonResponse(req, { error: 'Unauthorized' }, 401);

  const supabase = getServiceSupabase();
  const cfg = await loadEmailChannel(supabase);

  const { data: wmRow } = await supabase
    .from('crm_config').select('config_value').eq('config_key', WATERMARK_KEY).maybeSingle();
  const watermark = (wmRow?.config_value ?? {}) as Watermark;
  const fetchFailures: Record<string, number> = { ...(watermark.fetchFailures ?? {}) };

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
      const older = !!watermark.created_at && !isNewerThan(m.created_at, watermark.created_at);
      if (m.id === watermark.id || older) { reachedWatermark = true; break; }
      fresh.push(m);
    }
    if (!res.hasMore || res.data.length === 0) break;
    after = res.data[res.data.length - 1]?.id;
  }

  if (listError) {
    // 403/404 here usually means receiving is not enabled on the account yet.
    log.warn('email_replies_list_failed', { fn: 'email-replies-poll', correlationId, err: listError });
    await heartbeat(supabase, correlationId, { listError, processed: 0, degraded: true });
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
  const errors: string[] = [];
  for (const summary of batch) {
    const full = await getReceivedEmail(summary.id);
    if (!full.ok || !full.email) {
      const failures = (fetchFailures[summary.id] ?? 0) + 1;
      fetchFailures[summary.id] = failures;
      log.warn('email_reply_fetch_failed', { fn: 'email-replies-poll', correlationId, id: summary.id, failures, err: full.error });
      if (failures < MAX_FETCH_FAILURES) {
        errors.push(`fetch ${summary.id}: ${full.error ?? 'failed'} (attempt ${failures})`);
        await saveWatermark(supabase, { ...watermarkValue(watermark), fetchFailures });
        break; // retry from here next run — the watermark stays before it
      }
      // Give up on this one so the replies behind it are not held hostage,
      // and tell the owner which message to look at in the Resend dashboard.
      await notifyOperator(supabase, {
        kind: 'email_reply_unreadable',
        dedupeKey: `email_reply_unreadable:${summary.id}`,
        throttleMinutes: 7 * 24 * 60,
        severity: 'warn',
        title: 'תשובה למייל לא נקראה אחרי 3 ניסיונות — דולגה',
        lines: [`מזהה ב-Resend: ${summary.id}`, `שגיאה: ${(full.error ?? 'unknown').slice(0, 160)}`, 'אפשר לקרוא אותה ישירות בלוח הבקרה של Resend (Emails → Receiving).'],
        correlationId,
      });
      delete fetchFailures[summary.id];
      results.push({ id: summary.id, status: 'skipped_unreadable' });
      await saveWatermark(supabase, { id: summary.id, created_at: summary.created_at, fetchFailures });
      continue;
    }
    // Fetched fine now: a counter from an earlier transient failure would
    // otherwise sit in crm_config forever.
    delete fetchFailures[summary.id];
    const email = full.email;
    const sender = parseAddress(email.from);
    // Our own test sends and bounce notices are not replies from leads.
    const ownAddress = sender.email === cfg.fromEmail.toLowerCase();

    const ingest = ownAddress
      ? { status: 'own_address' as const, optOut: false, resubscribed: false, replyText: '' }
      : await ingestInboundEmail(supabase, {
          from: sender.email,
          fromName: sender.name,
          to: email.to,
          subject: email.subject,
          text: email.text ?? (email.html ? htmlToReplyText(email.html) : ''),
          messageId: email.message_id ?? `resend:${email.id}`,
          correlationId,
          raw: { resend_received_id: email.id, from: email.from, to: email.to, subject: email.subject },
          createLeadIfMissing: false,
          origin: 'email_reply',
        });

    let forwarded = false;
    let forwardError: string | undefined;
    if (cfg.forwardTo && ingest.status !== 'duplicate') {
      const verdict = ingest.optOut
        ? '✅ הוסר מרשימת הדיוור אוטומטית (ביקש הסרה).'
        : ingest.resubscribed
          ? '✅ חזר/ה לרשימת הדיוור אוטומטית (ביקש/ה לחזור).'
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
      if (!res.ok) {
        forwardError = res.error ?? `status ${res.status}`;
        log.warn('email_reply_forward_failed', { fn: 'email-replies-poll', correlationId, id: email.id, err: res.error });
      }
    }

    // A reply from someone who is not a lead exists ONLY as the forward to
    // the owner. If that forward failed, moving the watermark past it would
    // lose the reply for good — stop here and retry from it next run. A
    // reply that was stored on a lead's card is safe to pass.
    // But not forever: a forward that fails the same way every run (sending
    // domain lost verification, forwardTo mistyped, key revoked) held every
    // later reply — opt-outs included — behind it with no alert. Same
    // budget as an unreadable message, then the owner is told where to
    // read it in Resend and the watermark moves on.
    if (forwardError && ingest.status === 'unknown_sender') {
      const failures = (fetchFailures[summary.id] ?? 0) + 1;
      if (failures < MAX_FETCH_FAILURES) {
        fetchFailures[summary.id] = failures;
        errors.push(`forward ${email.id}: ${forwardError} (attempt ${failures})`);
        await saveWatermark(supabase, { ...watermarkValue(watermark), fetchFailures });
        break;
      }
      await notifyOperator(supabase, {
        kind: 'email_reply_unforwardable',
        dedupeKey: `email_reply_unforwardable:${summary.id}`,
        throttleMinutes: 7 * 24 * 60,
        severity: 'warn',
        title: 'תשובה למייל משולח לא מוכר לא הועברה אליך אחרי 3 ניסיונות — דולגה',
        lines: [
          `מאת: ${sender.email}`,
          `נושא: ${(email.subject ?? '').slice(0, 120)}`,
          `שגיאת ההעברה: ${forwardError.slice(0, 160)}`,
          'אפשר לקרוא אותה ישירות בלוח הבקרה של Resend (Emails → Receiving). אם ההעברה נכשלת לכולם — בדקו את כתובת ההעברה ואימות הדומיין בהגדרות המייל.',
        ],
        correlationId,
      });
      delete fetchFailures[summary.id];
      errors.push(`forward ${email.id}: ${forwardError} (skipped after ${failures} attempts)`);
      results.push({ id: email.id, status: 'skipped_unforwardable', forwardError });
      await saveWatermark(supabase, { id: summary.id, created_at: summary.created_at, fetchFailures });
      continue;
    }

    results.push({ id: email.id, status: ingest.status, optOut: ingest.optOut, forwarded, forwardError });
    await saveWatermark(supabase, { id: summary.id, created_at: summary.created_at, fetchFailures });
  }

  const removed = results.filter((r) => r.optOut).length;
  await heartbeat(supabase, correlationId, {
    processed: results.length, removed, errors: errors.length > 0 ? errors : undefined, degraded: errors.length > 0,
  });
  log.info('email_replies_polled', { fn: 'email-replies-poll', correlationId, processed: results.length, removed, errors });
  return jsonResponse(req, { ok: errors.length === 0, processed: results.length, removed, results, errors });
});

function watermarkValue(w: Watermark): { id?: string; created_at: string } {
  return { id: w.id, created_at: w.created_at ?? new Date().toISOString() };
}

async function saveWatermark(
  supabase: ReturnType<typeof getServiceSupabase>,
  value: { id?: string; created_at: string; fetchFailures?: Record<string, number> },
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
