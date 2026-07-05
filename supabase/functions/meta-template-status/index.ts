import { jsonResponse, preflight } from '../_shared/cors.ts';
import { env } from '../_shared/env.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse(req, { error: 'Method not allowed' }, 405);
  }

  try {
    await requireStaff(req, { allow: ['owner', 'admin', 'mia'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
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

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
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
    ? templateJson.data.map((template) => ({
      name: template.name,
      language: template.language,
      status: template.status,
      category: template.category,
      bodyText: Array.isArray(template.components)
        ? template.components.find((component) => component.type === 'BODY')?.text ?? null
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
