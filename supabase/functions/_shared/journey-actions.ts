import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ensureConversation, logLeadEvent, type LeadRow } from './lead-service.ts';
import { sendWhatsAppTemplate } from './whatsapp-provider.ts';
import { ensurePendingQueueItem } from './queue-service.ts';

export interface EngineContext {
  lead: LeadRow;
  triggerEvent: string;
  correlationId: string;
  data?: Record<string, unknown>;
}

interface MessageTemplate {
  key: string;
  channel: string;
  body: string;
  variables_used: string[];
  metadata: Record<string, unknown>;
}

interface AutomationAction {
  type: string;
  key?: string;
  channel?: string;
  code?: string;
  once?: boolean;
}

type ActionResult = {
  type: string;
  status: 'success' | 'skipped' | 'failed';
  reason?: string;
  payload?: Record<string, unknown>;
};

function firstName(fullName: string | null | undefined): string {
  const trimmed = (fullName ?? '').trim();
  if (!trimmed) return 'שם';
  return trimmed.split(/\s+/)[0] || trimmed;
}

function valueForVariable(name: string, ctx: EngineContext): string {
  if (name === 'first_name') return firstName(ctx.lead.full_name as string | null);
  if (name === 'full_name') return (ctx.lead.full_name as string | null) || firstName(ctx.lead.full_name as string | null);
  if (name === 'phone') return (ctx.lead.phone as string | null) || '';
  if (name === 'email') return (ctx.lead.email as string | null) || '';

  const dataValue = ctx.data?.[name];
  if (dataValue !== undefined && dataValue !== null) return String(dataValue);

  const leadValue = ctx.lead[name];
  if (leadValue !== undefined && leadValue !== null) return String(leadValue);

  return '';
}

function renderBody(template: MessageTemplate, ctx: EngineContext): string {
  let body = template.body;
  for (const variable of template.variables_used ?? []) {
    body = body.replaceAll(`{{${variable}}}`, valueForVariable(variable, ctx));
  }
  return body;
}

async function insertRun(
  supabase: SupabaseClient,
  ruleCode: string,
  ctx: EngineContext,
  status: 'success' | 'skipped' | 'failed' | 'partial',
  actionResults: ActionResult[],
  reason?: string,
  startedAt = Date.now(),
): Promise<void> {
  const { data: rule } = await supabase
    .from('automation_rules')
    .select('id')
    .eq('code', ruleCode)
    .maybeSingle();

  await supabase.from('automation_runs').insert({
    rule_id: rule?.id ?? null,
    rule_code: ruleCode,
    trigger_event: ctx.triggerEvent,
    contact_id: ctx.lead.id,
    context: { lead_id: ctx.lead.id, data: ctx.data ?? {}, correlation_id: ctx.correlationId },
    action_results: actionResults,
    status,
    reason: reason ?? null,
    duration_ms: Date.now() - startedAt,
    correlation_id: ctx.correlationId,
  });
}

export async function startJourney(
  supabase: SupabaseClient,
  code: string,
  ctx: EngineContext,
): Promise<ActionResult> {
  const { data: definition, error } = await supabase
    .from('journey_definitions')
    .select('id, code, enabled, allow_concurrent')
    .eq('code', code)
    .maybeSingle();
  if (error) return { type: 'journey_start', status: 'failed', reason: error.message };
  if (!definition || !definition.enabled) {
    return { type: 'journey_start', status: 'skipped', reason: 'journey_missing_or_disabled', payload: { code } };
  }

  if (!definition.allow_concurrent) {
    const { data: existing, error: existingErr } = await supabase
      .from('journey_runs')
      .select('id')
      .eq('definition_id', definition.id)
      .eq('contact_id', ctx.lead.id)
      .eq('status', 'active')
      .maybeSingle();
    if (existingErr) return { type: 'journey_start', status: 'failed', reason: existingErr.message };
    if (existing) {
      return { type: 'journey_start', status: 'skipped', reason: 'active_journey_exists', payload: { code } };
    }
  }

  const { error: insertErr } = await supabase.from('journey_runs').insert({
    definition_id: definition.id,
    definition_code: definition.code,
    contact_id: ctx.lead.id,
    current_step: 0,
    scheduled_next_at: new Date().toISOString(),
    state: { started_by: ctx.triggerEvent, correlation_id: ctx.correlationId },
  });
  if (insertErr) return { type: 'journey_start', status: 'failed', reason: insertErr.message, payload: { code } };
  await logLeadEvent(supabase, ctx.lead.id, 'journey_started', 'system', { code, correlation_id: ctx.correlationId });
  return { type: 'journey_start', status: 'success', payload: { code } };
}

export async function sendTemplateAction(
  supabase: SupabaseClient,
  action: AutomationAction,
  ctx: EngineContext,
): Promise<ActionResult> {
  const key = action.key;
  const channel = action.channel ?? 'whatsapp';
  if (!key) return { type: 'send_template', status: 'failed', reason: 'missing_template_key' };
  if (channel !== 'whatsapp') return { type: 'send_template', status: 'skipped', reason: 'unsupported_channel', payload: { channel } };
  if (!ctx.lead.phone) return { type: 'send_template', status: 'skipped', reason: 'missing_phone', payload: { key } };
  if (ctx.lead.do_not_contact || ctx.lead.removed_by_request) {
    return { type: 'send_template', status: 'skipped', reason: 'lead_suppressed', payload: { key } };
  }

  if (action.once) {
    const { error: ledgerErr } = await supabase.from('engine_template_sends').insert({
      lead_id: ctx.lead.id,
      template_key: key,
      channel,
    });
    if (ledgerErr) {
      if (ledgerErr.code === '23505') {
        return { type: 'send_template', status: 'skipped', reason: 'already_sent_once', payload: { key } };
      }
      return { type: 'send_template', status: 'failed', reason: ledgerErr.message, payload: { key } };
    }
  }

  const { data: template, error: templateErr } = await supabase
    .from('message_templates')
    .select('key, channel, body, variables_used, metadata')
    .eq('key', key)
    .eq('channel', channel)
    .eq('status', 'active')
    .maybeSingle();
  if (templateErr) return { type: 'send_template', status: 'failed', reason: templateErr.message, payload: { key } };
  if (!template) return { type: 'send_template', status: 'failed', reason: 'template_missing', payload: { key } };

  const row = template as MessageTemplate;
  const metaName = typeof row.metadata?.meta_template_name === 'string'
    ? row.metadata.meta_template_name
    : row.key;
  const language = typeof row.metadata?.meta_language === 'string'
    ? row.metadata.meta_language
    : 'he';
  const params = (row.variables_used ?? []).map((name) => ({ name, value: valueForVariable(name, ctx) }));
  const contentText = renderBody(row, ctx);
  const sendResult = await sendWhatsAppTemplate(ctx.lead.phone as string, metaName, params, language);
  if (!sendResult.ok) {
    await ensurePendingQueueItem(supabase, {
      leadId: ctx.lead.id,
      queueType: 'failed_automation',
      priorityLevel: 1,
      reason: 'Lifecycle template send failed',
      queueSummary: sendResult.error ?? `Template ${key} failed`,
      payloadJson: { key, metaName, error: sendResult.error, correlationId: ctx.correlationId },
      createdByActorType: 'system',
    });
    return { type: 'send_template', status: 'failed', reason: sendResult.error ?? 'send_failed', payload: { key, metaName } };
  }

  const conversation = await ensureConversation(supabase, ctx.lead.id, 'whatsapp', 'meta_cloud_api');
  const { error: messageErr } = await supabase.from('messages').insert({
    conversation_id: conversation.id,
    lead_id: ctx.lead.id,
    provider_message_id: sendResult.providerMessageId ?? null,
    sender_type: 'system',
    sender_name: 'Karnaf lifecycle bot',
    direction: 'outbound',
    message_type: 'template',
    content_text: contentText,
    provider_status: 'sent',
  });
  if (messageErr) return { type: 'send_template', status: 'failed', reason: messageErr.message, payload: { key } };

  await supabase.from('leads').update({
    last_outbound_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  }).eq('id', ctx.lead.id);
  await logLeadEvent(supabase, ctx.lead.id, 'lifecycle_template_sent', 'system', {
    key,
    meta_template_name: metaName,
    correlation_id: ctx.correlationId,
  }, conversation.id);

  return { type: 'send_template', status: 'success', payload: { key, metaName, providerMessageId: sendResult.providerMessageId } };
}

export async function runActions(
  supabase: SupabaseClient,
  actions: AutomationAction[],
  ctx: EngineContext,
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const action of actions) {
    if (action.type === 'send_template') {
      results.push(await sendTemplateAction(supabase, action, ctx));
    } else if (action.type === 'journey_start' && action.code) {
      results.push(await startJourney(supabase, action.code, ctx));
    } else {
      results.push({ type: action.type, status: 'skipped', reason: 'unsupported_action' });
    }
  }
  return results;
}

export async function runRuleActions(
  supabase: SupabaseClient,
  ruleCode: string,
  ctx: EngineContext,
): Promise<ActionResult[]> {
  const startedAt = Date.now();
  const { data: rule, error } = await supabase
    .from('automation_rules')
    .select('actions, enabled')
    .eq('code', ruleCode)
    .maybeSingle();
  if (error) {
    const result = [{ type: 'rule', status: 'failed' as const, reason: error.message }];
    await insertRun(supabase, ruleCode, ctx, 'failed', result, error.message, startedAt);
    return result;
  }
  if (!rule?.enabled || !Array.isArray(rule.actions)) {
    const result = [{ type: 'rule', status: 'skipped' as const, reason: 'rule_missing_disabled_or_no_actions' }];
    await insertRun(supabase, ruleCode, ctx, 'skipped', result, 'rule_missing_disabled_or_no_actions', startedAt);
    return result;
  }

  const results = await runActions(supabase, rule.actions as AutomationAction[], ctx);
  const failed = results.some((r) => r.status === 'failed');
  const success = results.some((r) => r.status === 'success');
  await insertRun(supabase, ruleCode, ctx, failed ? (success ? 'partial' : 'failed') : 'success', results, failed ? 'one_or_more_actions_failed' : undefined, startedAt);
  return results;
}
