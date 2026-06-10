// daily-sales-inbox — runs once a day (cron 05:00 UTC ≈ 08:00 IL).
// Pulls the attention_inbox snapshot, summarises by kind + lane, and
// sends a Telegram digest to Mia so she opens her day knowing exactly
// which leads are at risk. Implements automation B19 from the v4 spec.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { notifyTelegram } from '../_shared/notify-telegram.ts';

// Hebrew label for each attention kind. Keep in sync with the RPC's
// case dispatch in migration 055 — adding a new kind there means adding
// it here too so the morning digest doesn't bucket it under "אחר".
const KIND_LABELS: Record<string, string> = {
  mia_reply: 'הלקוח השיב',
  overdue_action: 'פעולה הבאה באיחור',
  phone_overdue: 'שיחת טלפון באיחור',
  phone_escalation: 'הוסלם לטלפון',
  ai_stuck: 'AI תקוע',
  deal_stalled: 'עסקה תקועה',
  meeting_outcome_pending: 'פגישה לסיכום',
  queue: 'משימת תור',
};

// The lanes match InboxPage.tsx so the digest groups the same way Mia
// sees the inbox UI.
const KIND_LANES: Record<string, 'reply' | 'call' | 'risk' | 'ops'> = {
  mia_reply: 'reply',
  overdue_action: 'risk',
  phone_overdue: 'call',
  phone_escalation: 'call',
  ai_stuck: 'risk',
  deal_stalled: 'risk',
  meeting_outcome_pending: 'ops',
  queue: 'ops',
};

interface AttentionRow {
  kind: string;
  priority_level: number;
  ownership_mode: string;
  lead_status: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  // Same shared secret as the SLA worker — they run from the same pg_cron
  // chain and Almog doesn't need a separate token to manage.
  const expected = env.slaWorkerSecret();
  if (!expected) {
    log.error('daily_inbox_secret_missing', { fn: 'daily-sales-inbox', correlationId });
    return jsonResponse(req, { error: 'Worker secret not configured' }, 500);
  }
  if (!verifyBearer(req, expected)) return jsonResponse(req, { error: 'Unauthorized' }, 401);

  try {
    const supabase = getServiceSupabase();
    // Take a generous snapshot so even a busy morning (200+ items) gets
    // counted accurately. The summary itself stays terse.
    const { data, error } = await supabase.rpc('attention_inbox', { p_limit: 500 });
    if (error) {
      log.error('daily_inbox_rpc_failed', { fn: 'daily-sales-inbox', correlationId, err: error.message });
      return jsonResponse(req, { ok: false, error: error.message }, 500);
    }
    const rows = (data ?? []) as AttentionRow[];

    const byKind = new Map<string, number>();
    const byLane: Record<'reply' | 'call' | 'risk' | 'ops', number> = { reply: 0, call: 0, risk: 0, ops: 0 };
    let critical = 0;
    for (const row of rows) {
      byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
      const lane = KIND_LANES[row.kind] ?? 'ops';
      byLane[lane]++;
      // Priority 1 = critical regardless of kind. Captures phone_overdue
      // + investor-track deal_stalled + ai_stuck in one signal.
      if (row.priority_level <= 1) critical++;
    }

    const total = rows.length;

    // Compose Hebrew digest. Order kinds by descending count so the
    // worst signal lands at the top — Mia scans line 1 first.
    const sortedKinds = Array.from(byKind.entries()).sort((a, b) => b[1] - a[1]);
    const lines: string[] = [];
    lines.push(`📋 בוקר טוב! בתיבה היום ${total} פריטים${critical > 0 ? ` (מהם ${critical} דחופים)` : ''}.`);
    if (total > 0) {
      lines.push('');
      lines.push(`לפי מסלול עבודה: מענה ${byLane.reply} · שיחות ${byLane.call} · סיכון ${byLane.risk} · תפעול ${byLane.ops}`);
      lines.push('');
      lines.push('פירוט לפי סוג:');
      for (const [kind, count] of sortedKinds) {
        const label = KIND_LABELS[kind] ?? kind;
        lines.push(`• ${label}: ${count}`);
      }
    } else {
      lines.push('');
      lines.push('🎉 התיבה ריקה — אין פריטים פתוחים. יום נעים!');
    }

    await notifyTelegram({
      source: 'daily-sales-inbox',
      severity: critical > 0 ? 'warn' : 'info',
      title: 'Karnaf CRM — תיבת בוקר',
      lines,
      link: 'https://karnaf-crm.vercel.app/inbox',
      correlationId,
    });

    log.info('daily_inbox_sent', {
      fn: 'daily-sales-inbox', correlationId, total, critical, byLane,
    });
    return jsonResponse(req, { ok: true, total, critical, byLane, correlationId });
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log.error('daily_inbox_unhandled', { fn: 'daily-sales-inbox', correlationId, err: message });
    return jsonResponse(req, { ok: false, error: message, correlationId }, 500);
  }
});
