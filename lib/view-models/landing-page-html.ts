// Landing-page SSR renderer — pure string builder consumed by the
// Vercel edge function api/lp/[slug].ts and unit-tested here. Produces
// a self-contained RTL HTML document (inline CSS, no external assets)
// with a lead form that posts to website-leads-intake.

export interface LandingPageConfig {
  slug: string;
  title: string;
  headline: string;
  subheadline?: string | null;
  body_md?: string | null;
  cta_label?: string | null;
  form_config?: { fields?: string[] } | null;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Minimal markdown: blank-line paragraphs, **bold**, - bullets. */
export function miniMarkdown(md: string): string {
  const blocks = md.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim());
      if (lines.every((l) => l.startsWith('- '))) {
        const items = lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join('');
        return `<ul style="margin:0 0 16px; padding-inline-start:20px;">${items}</ul>`;
      }
      return `<p style="margin:0 0 16px;">${lines.map(inline).join('<br />')}</p>`;
    })
    .join('\n');

  function inline(text: string): string {
    return esc(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }
}

const FIELD_DEFS: Record<string, { label: string; type: string; name: string; required: boolean; dir?: string }> = {
  name: { label: 'שם מלא', type: 'text', name: 'full_name', required: true },
  phone: { label: 'טלפון', type: 'tel', name: 'phone', required: true, dir: 'ltr' },
  email: { label: 'אימייל', type: 'email', name: 'email', required: false, dir: 'ltr' },
};

export function renderLandingPage(lp: LandingPageConfig, intakeUrl: string): string {
  const fields = (lp.form_config?.fields ?? ['name', 'phone', 'email'])
    .map((f) => FIELD_DEFS[f])
    .filter((f): f is (typeof FIELD_DEFS)[string] => !!f);

  const fieldHtml = fields
    .map((f) => [
      `<label style="display:block; margin-bottom:12px;">`,
      `<span style="display:block; font-size:14px; font-weight:600; margin-bottom:4px;">${esc(f.label)}${f.required ? ' *' : ''}</span>`,
      `<input type="${f.type}" name="${f.name}"${f.required ? ' required' : ''}${f.dir ? ` dir="${f.dir}"` : ''} style="width:100%; box-sizing:border-box; padding:12px; border:1px solid #cbd5e1; border-radius:10px; font-size:16px;" />`,
      `</label>`,
    ].join(''))
    .join('\n');

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(lp.title)}</title>
<meta property="og:title" content="${esc(lp.headline)}" />
${lp.subheadline ? `<meta property="og:description" content="${esc(lp.subheadline)}" />` : ''}
</head>
<body style="margin:0; background:#f1f5f9; font-family:Arial,Helvetica,sans-serif; color:#0f172a;">
<div style="max-width:560px; margin:0 auto; padding:32px 16px;">
  <div style="text-align:center; margin-bottom:20px;">
    <div style="font-size:34px;">🦏</div>
    <div style="font-weight:700; color:#334155;">קרנף נדל"ן</div>
  </div>
  <div style="background:#ffffff; border-radius:16px; padding:28px 22px; box-shadow:0 8px 30px rgba(15,23,42,.08);">
    <h1 style="margin:0 0 8px; font-size:26px; line-height:1.3;">${esc(lp.headline)}</h1>
    ${lp.subheadline ? `<p style="margin:0 0 18px; color:#475569; font-size:17px;">${esc(lp.subheadline)}</p>` : ''}
    ${lp.body_md ? `<div style="font-size:16px; line-height:1.65; color:#1e293b;">${miniMarkdown(lp.body_md)}</div>` : ''}
    <form id="lead-form" style="margin-top:20px;">
      ${fieldHtml}
      <input type="text" name="company_website" tabindex="-1" autocomplete="off" style="position:absolute; left:-9999px; opacity:0;" aria-hidden="true" />
      <button type="submit" style="width:100%; padding:14px; border:none; border-radius:12px; background:#0d9488; color:#ffffff; font-size:17px; font-weight:700; cursor:pointer;">
        ${esc(lp.cta_label ?? 'רוצה שיחזרו אליי')}
      </button>
      <p id="form-status" style="margin:12px 0 0; font-size:14px; text-align:center; color:#475569;"></p>
    </form>
  </div>
  <p style="text-align:center; margin-top:16px; font-size:12px; color:#94a3b8;">בשליחת הטופס אני מאשר/ת יצירת קשר מצוות קרנף נדל"ן</p>
</div>
<script>
(function () {
  var form = document.getElementById('lead-form');
  var status = document.getElementById('form-status');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = new FormData(form);
    var payload = {
      source: 'landing-page',
      lp_slug: ${JSON.stringify(lp.slug)},
      full_name: data.get('full_name') || '',
      phone: data.get('phone') || '',
      email: data.get('email') || '',
      company_website: data.get('company_website') || ''
    };
    status.textContent = 'שולח...';
    fetch(${JSON.stringify(intakeUrl)}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (r.ok) {
        form.innerHTML = '<p style="text-align:center; font-size:18px; font-weight:700; color:#0d9488;">קיבלנו! נחזור אליך ממש בקרוב 🦏</p>';
      } else {
        return r.json().catch(function () { return {}; }).then(function (j) {
          status.textContent = j.error || 'משהו השתבש — נסו שוב בעוד רגע';
        });
      }
    }).catch(function () {
      status.textContent = 'בעיית תקשורת — נסו שוב';
    });
  });
})();
</script>
</body>
</html>`;
}
