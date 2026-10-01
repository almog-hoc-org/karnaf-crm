// Email channel status + a safe test send.
//
// GET  → the current email_channel config, the scheduling preflight result,
//        and the domains in the Resend account with their verification
//        status. Answers "is the domain really verified, and does the CRM
//        use an address on it?" without anyone opening the Resend dashboard.
// POST {action: 'test_send', broadcast_id?}
//      → sends ONE email to the caller's own address: the signed-in
//        owner/admin's email, or — for the ops report, authenticated with
//        the service-role key — email_channel.replyTo. Never an address
//        from the request body, so this endpoint cannot be used to mail a
//        customer. With broadcast_id the test is that campaign exactly as a
//        recipient gets it (shared renderer), otherwise a short check-in.
//
// Auth: owner/admin JWT (Settings / Broadcasts screens) or the service-role
// key (ops workflow). verify_jwt = true, so the gateway rejects anything
// that is not a project JWT before this code runs.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError } from '../_shared/auth.ts';
import { authenticateServiceOrStaff, type ServiceOrStaffCaller } from '../_shared/service-or-staff.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import {
  formatFromAddress,
  loadEmailChannel,
  preflightEmailChannel,
} from '../_shared/email-channel.ts';
import { emailDomain, listReceivedEmails, listResendDomains, sendResendEmail } from '../_shared/resend.ts';
import { renderBroadcastEmail } from '../_shared/broadcast-email.ts';
import { wrapEmailShell } from '../_shared/email-html.ts';

type Caller = ServiceOrStaffCaller;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const correlationId = correlationFromRequest(req);

  let caller: Caller;
  try {
    caller = await authenticateServiceOrStaff(req);
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();
  const cfg = await loadEmailChannel(supabase);

  if (req.method === 'GET') {
    const noDomains: Awaited<ReturnType<typeof listResendDomains>> = { ok: true, domains: [] };
    const [check, domains, received, pollBeat] = await Promise.all([
      preflightEmailChannel(cfg),
      cfg.provider === 'resend' ? listResendDomains() : Promise.resolve(noDomains),
      listReceivedEmails({ limit: 1 }),
      supabase.from('system_heartbeats').select('last_ok_at, metadata').eq('name', 'email_replies_poll').maybeSingle(),
    ]);
    // Replies reach the CRM only when replyTo IS the inbound address.
    const receiving = {
      inboundAddress: cfg.inboundAddress || null,
      replyToIsInbound: !!cfg.inboundAddress && cfg.replyTo.toLowerCase() === cfg.inboundAddress.toLowerCase(),
      forwardTo: cfg.forwardTo || null,
      apiOk: received.ok,
      apiError: received.ok ? null : `${received.status}: ${received.error ?? ''}`.slice(0, 200),
      lastReceivedAt: received.data[0]?.created_at ?? null,
      lastReceivedTo: received.data[0]?.to ?? null,
      poller: pollBeat.data ?? null,
    };
    const senderDomain = emailDomain(cfg.fromEmail);
    const verified = domains.domains.filter((d) => d.status === 'verified').map((d) => d.name);
    return jsonResponse(req, {
      ok: true,
      emailChannel: cfg,
      readyToSend: check.ok,
      preflight: check,
      senderDomain,
      domains: domains.domains,
      domainsError: domains.error ?? null,
      // The address the CRM would use if the sender were moved onto the
      // first verified domain — shown as a one-click suggestion in Settings.
      suggestedFromEmail: verified.length > 0 && !verified.includes(senderDomain)
        ? `info@${verified[0]}`
        : null,
      receiving,
    });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.action !== 'test_send') return jsonResponse(req, { error: 'Unsupported action' }, 400);

  // target 'inbound' = our own receiving address (proves MX + polling work
  // end to end). Otherwise the caller's own inbox. Never a customer.
  const toInbound = body.target === 'inbound';
  const to = toInbound
    ? cfg.inboundAddress
    : caller.kind === 'staff' ? (caller.email ?? '') : (cfg.forwardTo || cfg.replyTo);
  if (!to) {
    return jsonResponse(req, {
      error: toInbound
        ? 'אין כתובת קליטה (inboundAddress) בהגדרות ערוץ המייל'
        : caller.kind === 'staff'
          ? 'למשתמש שלך אין כתובת מייל — אין לאן לשלוח בדיקה'
          : 'אין כתובת בעלים (forwardTo) בהגדרות ערוץ המייל — אין לאן לשלוח בדיקה',
    }, 400);
  }

  const check = await preflightEmailChannel(cfg);
  if (!check.ok) return jsonResponse(req, { ok: false, code: check.code, error: check.error }, 400);
  if (cfg.provider !== 'resend') {
    return jsonResponse(req, { ok: false, error: 'בדיקת שליחה זמינה רק כשהספק הוא Resend' }, 400);
  }

  let subject: string;
  let html: string;
  let headers: Record<string, string> = {};
  const broadcastId = typeof body.broadcast_id === 'string' ? body.broadcast_id : null;

  if (broadcastId) {
    const { data: b } = await supabase.from('broadcasts').select('*').eq('id', broadcastId).maybeSingle();
    if (!b) return jsonResponse(req, { error: 'broadcast not found' }, 404);
    if (b.channel !== 'email') return jsonResponse(req, { error: 'זו לא תפוצת מייל' }, 400);
    // If the tester is also a lead, the footer link is theirs — clicking it
    // exercises the real unsubscribe path on their own record.
    const { data: lead } = await supabase
      .from('leads').select('id, full_name')
      // Case-insensitive exact match: escape LIKE wildcards ("_" is common
      // in addresses) so the pattern can only match this one address.
      .ilike('email', to.replace(/[\\%_]/g, (c) => `\\${c}`))
      .limit(1).maybeSingle();
    const rendered = await renderBroadcastEmail(
      b as Record<string, unknown>,
      { leadId: lead?.id ?? null, fullName: lead?.full_name ?? null },
      cfg.fromName,
    );
    subject = `[בדיקה] ${rendered.subject}`;
    html = rendered.html;
    headers = rendered.headers;
  } else {
    subject = '[בדיקה] ערוץ המייל של קרנף CRM';
    html = wrapEmailShell(
      `<p>זה מייל בדיקה מה-CRM.</p><p>אם הגיע לתיבה הראשית (ולא לספאם), ערוץ המייל מוכן: השולח <b>${cfg.fromEmail}</b>, תשובות יגיעו אל <b>${cfg.replyTo || cfg.fromEmail}</b>.</p>`,
      cfg.fromName,
    );
  }

  const result = await sendResendEmail({
    from: formatFromAddress(cfg),
    to,
    subject,
    html,
    replyTo: cfg.replyTo || undefined,
    headers,
    tags: [{ name: 'kind', value: 'test_send' }, ...(broadcastId ? [{ name: 'broadcast_id', value: broadcastId }] : [])],
  });

  log.info('email_test_send', {
    fn: 'email-channel-status', correlationId, to, broadcastId, ok: result.ok, status: result.status,
    caller: caller.kind === 'staff' ? caller.userId : 'service',
  });

  if (!result.ok) {
    return jsonResponse(req, { ok: false, status: result.status, error: result.error ?? 'Resend rejected the test' }, 502);
  }
  return jsonResponse(req, { ok: true, to, id: result.id ?? null, subject });
});
