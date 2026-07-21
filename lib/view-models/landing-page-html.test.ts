import { describe, expect, it } from 'vitest';
import { miniMarkdown, renderLandingPage } from './landing-page-html';

const LP = {
  slug: 'webinar-august',
  title: 'וובינר אוגוסט',
  headline: 'הדרך לדירה מתחילה כאן',
  subheadline: 'וובינר חינמי',
  body_md: 'שורה ראשונה\n\n- יתרון אחד\n- יתרון **שני**',
  cta_label: 'שריינו מקום',
  form_config: { fields: ['name', 'phone', 'email'] },
};

describe('renderLandingPage', () => {
  it('renders an RTL document with the copy and form fields', () => {
    const html = renderLandingPage(LP, 'https://x.functions.supabase.co/website-leads-intake');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('הדרך לדירה מתחילה כאן');
    expect(html).toContain('name="full_name"');
    expect(html).toContain('name="phone"');
    expect(html).toContain('name="email"');
    expect(html).toContain('שריינו מקום');
    expect(html).toContain('"webinar-august"');
  });

  it('escapes HTML in operator copy', () => {
    const html = renderLandingPage({ ...LP, headline: '<script>x</script>' }, 'https://intake');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('includes the honeypot field', () => {
    const html = renderLandingPage(LP, 'https://intake');
    expect(html).toContain('company_website');
  });

  it('respects form_config field selection', () => {
    const html = renderLandingPage({ ...LP, form_config: { fields: ['name', 'phone'] } }, 'https://intake');
    expect(html).not.toContain('name="email"');
  });
});

describe('miniMarkdown', () => {
  it('renders paragraphs, bullets, and bold', () => {
    const out = miniMarkdown('פסקה\n\n- אחת\n- **שתיים**');
    expect(out).toContain('<p');
    expect(out).toContain('<ul');
    expect(out).toContain('<strong>שתיים</strong>');
  });
});
