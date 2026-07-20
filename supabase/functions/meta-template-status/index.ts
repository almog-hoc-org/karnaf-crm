import { jsonResponse, preflight } from '../_shared/cors.ts';
import { env } from '../_shared/env.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { notifyTelegram } from '../_shared/notify-telegram.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse(req, { error: 'Method not allowed' }, 405);
  }

  const postBody: Record<string, unknown> | null =
    req.method === 'POST' ? await req.json().catch(() => ({})) : null;

  // Staff auth for everything; the nightly cron may call the 'sync'
  // action with the shared worker secret instead (same pattern as the
  // other cron-driven workers).
  try {
    await requireStaff(req, { allow: ['owner', 'admin', 'mia'] });
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
    const workerSecret = env.slaWorkerSecret();
    const isCronSync =
      postBody?.action === 'sync' && !!workerSecret && verifyBearer(req, workerSecret);
    if (!isCronSync) return jsonResponse(req, { error: err.message }, err.status);
  }

  const token = env.whatsappToken();
  const phoneId = env.whatsappPhoneId();
  if (!token || !phoneId) {
    return jsonResponse(req, { ok: false, error: 'WhatsApp Meta provider is not configured' }, 500);
  }

  const graphVersion = 'v21.0';
  const url = new URL(req.url);
  const explicitWabaId = url.searchParams.get('wabaId');
  const phoneUrl = new URL(`https://graph.facebook.com/${graphVersion}/${phoneId}`);
  phoneUrl.searchParams.set('fields', 'id,display_phone_number,verified_name,whatsapp_business_account');

  const phoneRes = await fetch(phoneUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const phoneText = await phoneRes.text();
  const phoneJson = JSON.parse(phoneText || '{}');
  if (!phoneRes.ok && !explicitWabaId) {
    return jsonResponse(req, { ok: false, stage: 'phone_lookup', errorText: phoneText }, 200);
  }

  const wabaId = explicitWabaId ?? phoneJson?.whatsapp_business_account?.id;
  if (!wabaId) {
    return jsonResponse(req, { ok: false, stage: 'phone_lookup', error: 'No WABA id on phone number' }, 500);
  }

  if (req.method === 'POST' && postBody?.action === 'sync') {
    return await syncTemplates(req, token, wabaId, graphVersion);
  }

  if (req.method === 'POST') {
    const body = postBody ?? {};
    if (body?.action !== 'create_karnaf_followup_v1' && body?.action !== 'create_lifecycle_templates') {
      return jsonResponse(req, { ok: false, error: 'Unsupported action' }, 400);
    }

    const templateSpecs = body?.action === 'create_lifecycle_templates'
      ? [
        {
          name: 'karnaf_landing_welcome_v1',
          category: 'MARKETING',
          text: 'היי {{1}}, ראינו שהתעניינת בתוכנית ״הדרך לדירה״ של קרנף נדל״ן. נשמח לעזור לך להבין מה הצעד הבא בדרך לרכישת דירה בצורה עצמאית ואחראית.\n\nאפשר לענות כאן ונכוון אותך.',
          example: 'מוגי',
        },
        {
          name: 'karnaf_student_welcome_v1',
          category: 'MARKETING',
          text: 'ברוך הבא ל״הדרך לדירה״, {{1}}! שמחים שאתה איתנו. אם יש שאלה, התלבטות או משהו שלא ברור במהלך הדרך, אפשר לכתוב כאן ונעזור.\n\nבהצלחה מהצוות של קרנף.',
          example: 'מוגי',
        },
        {
          name: 'karnaf_student_checkin_14d_v1',
          category: 'MARKETING',
          text: 'היי {{1}}, בודקים איתך איך מתקדם בדרך לדירה. יש משהו שתקוע, שאלה על השיעורים או החלטה שצריך לחשוב עליה יחד?\n\nאפשר לענות כאן ונעזור.',
          example: 'מוגי',
        },
      ]
      : [{
        name: 'karnaf_followup_v1',
        category: 'UTILITY',
        text: 'הודעה מצוות קרנף נדל"ן: {{1}}\n\nאפשר לענות כאן ונמשיך לעזור.',
        example: 'היי, חוזרים אליך בהמשך לשיחה הקודמת כדי לעזור לך להבין את הצעד הבא.',
      }];

    const results = [];
    for (const spec of templateSpecs) {
      const createRes = await fetch(`https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: spec.name,
          language: 'he',
          category: spec.category,
          components: [{
          type: 'BODY',
          text: spec.text,
          example: {
            body_text: [[spec.example]],
          },
        }],
        }),
      });
      const createText = await createRes.text();
      let createJson: unknown = {};
      try {
        createJson = JSON.parse(createText || '{}');
      } catch {
        createJson = { raw: createText };
      }
      results.push({
        name: spec.name,
        ok: createRes.ok,
        status: createRes.status,
        response: createJson,
      });
    }
    return jsonResponse(req, {
      ok: results.every((result) => result.ok),
      stage: 'create_template',
      results,
    }, 200);
  }

  const templateUrl = new URL(`https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates`);
  templateUrl.searchParams.set('fields', 'name,language,status,category,components');
  templateUrl.searchParams.set('limit', '100');

  const templateRes = await fetch(templateUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const templateText = await templateRes.text();
  const templateJson = JSON.parse(templateText || '{}');
  if (!templateRes.ok) {
    return jsonResponse(req, { ok: false, stage: 'template_lookup', errorText: templateText }, 200);
  }

  const templates = Array.isArray(templateJson.data)
    ? templateJson.data.map((template: Record<string, unknown>) => ({
      name: template.name,
      language: template.language,
      status: template.status,
      category: template.category,
      bodyText: Array.isArray(template.components)
        ? (template.components as Array<Record<string, unknown>>).find((component) => component.type === 'BODY')?.text ?? null
        : null,
    }))
    : [];

  return jsonResponse(req, {
    ok: true,
    phone: {
      id: phoneJson.id,
      displayPhoneNumber: phoneJson.display_phone_number,
      verifiedName: phoneJson.verified_name,
      wabaId,
    },
    templates,
  });
});

// Pull the live template list from Meta and record status + body on the
// matching local message_templates rows (metadata.meta). The local body
// is NOT overwritten — the journey engine renders from it with named
// variables, so adoption of a changed Meta text stays a human decision;
// the UI surfaces the drift instead. Fires a Telegram warning when a
// matched template is no longer APPROVED.
async function syncTemplates(
  req: Request,
  token: string,
  wabaId: string,
  graphVersion: string,
): Promise<Response> {
  const templateUrl = new URL(`https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates`);
  templateUrl.searchParams.set('fields', 'name,language,status,category,components');
  templateUrl.searchParams.set('limit', '100');
  const res = await fetch(templateUrl, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) return jsonResponse(req, { ok: false, stage: 'template_lookup', errorText: text }, 200);
  const json = JSON.parse(text || '{}');

  const metaByName = new Map<string, { status: string; category: string; language: string; body: string | null }>();
  for (const t of (Array.isArray(json.data) ? json.data : []) as Array<Record<string, unknown>>) {
    const name = String(t.name ?? '');
    // Prefer the Hebrew variant when a template exists in several languages.
    if (metaByName.has(name) && t.language !== 'he') continue;
    metaByName.set(name, {
      status: String(t.status ?? ''),
      category: String(t.category ?? ''),
      language: String(t.language ?? ''),
      body: Array.isArray(t.components)
        ? ((t.components as Array<Record<string, unknown>>).find((c) => c.type === 'BODY')?.text as string | undefined) ?? null
        : null,
    });
  }

  const supabase = getServiceSupabase();
  const { data: locals, error } = await supabase
    .from('message_templates')
    .select('id, key, body, metadata')
    .eq('channel', 'whatsapp');
  if (error) return jsonResponse(req, { ok: false, stage: 'local_lookup', error: error.message }, 500);

  const syncedAt = new Date().toISOString();
  const drifted: string[] = [];
  const nonApproved: Array<{ key: string; status: string }> = [];
  let matched = 0;

  for (const local of locals ?? []) {
    const meta = metaByName.get(local.key as string);
    if (!meta) continue;
    matched += 1;
    if (meta.body && meta.body !== local.body) drifted.push(local.key as string);
    if (meta.status && meta.status !== 'APPROVED') nonApproved.push({ key: local.key as string, status: meta.status });
    const metadata = { ...(local.metadata as Record<string, unknown> ?? {}), meta: { ...meta, synced_at: syncedAt } };
    await supabase.from('message_templates').update({ metadata }).eq('id', local.id);
  }

  if (nonApproved.length > 0) {
    await notifyTelegram({
      source: 'meta-template-status',
      severity: 'warn',
      title: 'תבניות וואטסאפ שאינן מאושרות במטא',
      lines: nonApproved.map((t) => `${t.key}: ${t.status}`),
    });
  }

  const localKeys = new Set((locals ?? []).map((l) => l.key as string));
  const unmatchedMeta = [...metaByName.keys()].filter((name) => !localKeys.has(name));

  return jsonResponse(req, {
    ok: true,
    stage: 'sync',
    matched,
    drifted,
    nonApproved,
    unmatchedMeta,
    syncedAt,
  });
}
