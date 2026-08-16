import { test, expect, type Page } from '@playwright/test';

// Credential-less visual verification of the inbox "minimum clicks" round:
// inline reply, quick-classify, keyboard triage, leads-list sort.
//
// Unlike the sibling specs (which need E2E_TEST_EMAIL/PASSWORD against a
// live Supabase), this one stubs EVERY network dependency, so it runs
// anywhere — CI included:
//   - the Supabase session is injected straight into localStorage
//     (supabase-js reads it back without any network),
//   - the profiles role lookup (rest/v1) and all edge functions
//     (/functions/v1) are intercepted with page.route.
// Requires only a .env with stub VITE_SUPABASE_URL/ANON_KEY so the Vite
// dev server boots (values never leave the intercepted browser).

// Storage key derives from the VITE_SUPABASE_URL subdomain: stub.supabase.co.
const STORAGE_KEY = 'sb-stub-auth-token';

// Syntactically valid (unsigned) JWT — supabase-js only parses it.
const FAKE_JWT = [
  Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: 'user-e2e', role: 'authenticated', exp: 4102444800 })).toString('base64url'),
  '',
].join('.');

const SESSION = {
  access_token: FAKE_JWT,
  refresh_token: 'stub-refresh',
  token_type: 'bearer',
  expires_in: 3600 * 24 * 365,
  expires_at: 4102444800, // 2100 — never triggers a refresh call
  user: {
    id: 'user-e2e',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'e2e@karnaf.test',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
  },
};

const NOW = Date.now();
const HOURS = 3600_000;

function attentionRows() {
  return [
    {
      kind: 'mia_reply',
      ref_id: 'lead-in-window',
      lead_id: 'lead-in-window',
      lead_name: 'רוני לוי',
      lead_phone: '0500000001',
      lead_status: 'human_handoff',
      lead_heat: 'warm',
      ownership_mode: 'mia_active',
      product_interest: 'digital_program',
      suggested_next_action: null,
      intake_segment: 'needs_human',
      queue_type: null,
      queue_summary: null,
      last_inbound_at: new Date(NOW - 2 * HOURS).toISOString(),
      last_outbound_at: null,
      priority_level: 1,
      reason: 'הלקוח כתב — ממתין לתשובה',
      due_at: new Date(NOW - 2 * HOURS).toISOString(),
      created_at: new Date(NOW - 2 * HOURS).toISOString(),
      is_program_member: false,
      source: 'whatsapp',
      last_inbound_text: 'היי, מתי מתחיל המחזור הבא של הקורס?',
      last_inbound_conversation_id: 'conv-open',
      last_inbound_channel: 'whatsapp',
    },
    {
      kind: 'awaiting_reply',
      ref_id: 'lead-out-window',
      lead_id: 'lead-out-window',
      lead_name: 'איתי כהן',
      lead_phone: '0500000002',
      lead_status: 'human_handoff',
      lead_heat: 'hot',
      ownership_mode: 'mia_active',
      product_interest: 'investor_mentorship',
      suggested_next_action: null,
      intake_segment: 'hot_sales',
      queue_type: null,
      queue_summary: null,
      last_inbound_at: new Date(NOW - 48 * HOURS).toISOString(),
      last_outbound_at: null,
      priority_level: 1,
      reason: 'הלקוח כתב וממתין לתשובה מעל שעתיים!',
      due_at: new Date(NOW - 48 * HOURS).toISOString(),
      created_at: new Date(NOW - 48 * HOURS).toISOString(),
      is_program_member: false,
      source: 'facebook_ads',
      last_inbound_text: 'כמה עולה ליווי משקיעים?',
      last_inbound_conversation_id: 'conv-closed',
      last_inbound_channel: 'whatsapp',
    },
  ];
}

function leadsRows() {
  return [
    {
      id: 'lead-1', full_name: 'דנה כהן', phone: '0501234567', email: 'dana@example.com',
      source: 'whatsapp', source_detail: null, source_campaign: null, utm_campaign: null,
      utm_source: null, landing_page: null, lead_status: 'responded', lead_heat: 'hot',
      ownership_mode: 'ai_active', lead_score: 85, payment_status: null,
      last_message_at: null, last_inbound_at: new Date(NOW - HOURS).toISOString(),
      last_outbound_at: null, do_not_contact: false, removed_by_request: false,
      updated_at: new Date(NOW - HOURS).toISOString(), created_at: new Date(NOW - 30 * HOURS).toISOString(),
      inquiry_type: null, product_interest: 'digital_program', interest_topic: null,
      intake_segment: 'hot_sales', suggested_next_action: null, outcome: null,
      outcome_note: null, outcome_at: null, snoozed_until: null, no_proactive_contact: false,
      is_program_member: false, awaiting_reply: true,
    },
    {
      id: 'lead-2', full_name: 'יוסי לוי', phone: '0507654321', email: null,
      source: 'website', source_detail: null, source_campaign: null, utm_campaign: null,
      utm_source: null, landing_page: null, lead_status: 'new', lead_heat: 'cool',
      ownership_mode: 'ai_active', lead_score: 20, payment_status: null,
      last_message_at: null, last_inbound_at: null, last_outbound_at: null,
      do_not_contact: false, removed_by_request: false,
      updated_at: new Date(NOW - 5 * HOURS).toISOString(), created_at: new Date(NOW - 5 * HOURS).toISOString(),
      inquiry_type: null, product_interest: null, interest_topic: null,
      intake_segment: 'info_seeker', suggested_next_action: null, outcome: null,
      outcome_note: null, outcome_at: null, snoozed_until: null, no_proactive_contact: false,
      is_program_member: false, awaiting_reply: false,
    },
  ];
}

// Captured mutation payloads, per test.
type Captured = { sendReply: unknown[]; adminActions: unknown[]; leadsListUrls: string[] };

async function stubNetwork(page: Page): Promise<Captured> {
  const captured: Captured = { sendReply: [], adminActions: [], leadsListUrls: [] };

  // Playwright matches the LAST registered route first, so the broad
  // catch-alls go in before the specific handlers that must win.
  await page.route('https://stub.supabase.co/**', (route) => route.fulfill({ json: {} }));
  await page.route('**/functions/v1/**', (route) =>
    route.fulfill({ json: { ok: true, items: [], leads: [], total: 0 } }));

  await page.route('**/rest/v1/profiles**', (route) =>
    route.fulfill({ json: { role: 'admin', is_active: true } }));
  await page.route('**/functions/v1/attention-inbox**', (route) =>
    route.fulfill({ json: { ok: true, items: attentionRows() } }));
  await page.route('**/functions/v1/send-reply', (route) => {
    captured.sendReply.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, mode: 'sent' } });
  });
  await page.route('**/functions/v1/admin-actions', (route) => {
    const body = route.request().postDataJSON();
    captured.adminActions.push(body);
    return route.fulfill({ json: { ok: true, action: body?.action ?? 'unknown' } });
  });
  await page.route('**/functions/v1/leads-list**', (route) => {
    captured.leadsListUrls.push(route.request().url());
    return route.fulfill({ json: { ok: true, leads: leadsRows(), total: 2, limit: 50, offset: 0 } });
  });

  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key as string, JSON.stringify(session));
  }, [STORAGE_KEY, SESSION] as const);

  return captured;
}

// Sandboxes that pre-install a Chromium build (PLAYWRIGHT_BROWSERS_PATH)
// may carry a different browser revision than this Playwright version
// expects; point at the stable wrapper instead of failing the launch.
test.use(
  process.env.PW_CHROMIUM_PATH
    ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
    : {},
);

test.describe('Inbox minimum-clicks round (stubbed backend)', () => {
  test('inline reply: compose on the card, Enter sends, card leaves', async ({ page }) => {
    const captured = await stubNetwork(page);
    await page.goto('/inbox');

    await expect(page.getByRole('button', { name: 'השב כאן 💬' })).toHaveCount(2);
    await page.screenshot({ path: 'e2e-artifacts/01-inbox-cards.png', fullPage: true });

    // Scope to the in-window card by name — sort order (urgency first)
    // is not this test's concern.
    const card = page.locator('article', { hasText: 'רוני לוי' });
    await card.getByRole('button', { name: 'השב כאן 💬' }).click();
    const textarea = card.getByPlaceholder(/הקלד תשובה ידנית/);
    await expect(textarea).toBeFocused();
    await expect(page.getByText('חלון 24 השעות פתוח')).toBeVisible();
    await textarea.fill('המחזור הבא נפתח בספטמבר, אשמח לפרט');
    await page.screenshot({ path: 'e2e-artifacts/02-composer-open.png', fullPage: true });
    await textarea.press('Enter');

    await expect.poll(() => captured.sendReply.length).toBe(1);
    expect(captured.sendReply[0]).toMatchObject({
      leadId: 'lead-in-window',
      conversationId: 'conv-open',
      text: 'המחזור הבא נפתח בספטמבר, אשמח לפרט',
    });
    await expect(page.getByText('רוני לוי')).toHaveCount(0);
  });

  test('out-of-window card: composer explains template mode', async ({ page }) => {
    await stubNetwork(page);
    await page.goto('/inbox');

    // איתי's card is 48h stale — its chip already says so.
    const card = page.locator('article', { hasText: 'איתי כהן' });
    await expect(card.getByText('WhatsApp מחוץ ל-24ש׳')).toBeVisible();
    await card.getByRole('button', { name: 'השב כאן 💬' }).click();
    await expect(card.getByText('מחוץ לחלון 24 שעות תישלח תבנית')).toBeVisible();
    await page.screenshot({ path: 'e2e-artifacts/03-out-of-window.png', fullPage: true });
  });

  test('quick-classify popover sets heat with one click', async ({ page }) => {
    const captured = await stubNetwork(page);
    await page.goto('/inbox');

    const card = page.locator('article', { hasText: 'רוני לוי' });
    await card.getByRole('button', { name: 'סיווג ⚡' }).click();
    await expect(page.getByRole('dialog', { name: 'סיווג מהיר' })).toBeVisible();
    await page.screenshot({ path: 'e2e-artifacts/04-classify-popover.png', fullPage: true });
    await page.getByRole('button', { name: 'חם', exact: true }).click();

    await expect.poll(() => captured.adminActions.length).toBeGreaterThan(0);
    expect(captured.adminActions[0]).toMatchObject({
      action: 'update_lead_meta',
      leadId: 'lead-in-window',
      metaUpdates: { lead_heat: 'hot' },
    });
  });

  test('keyboard: J focuses a card, D marks it done', async ({ page }) => {
    const captured = await stubNetwork(page);
    await page.goto('/inbox');
    await expect(page.getByText('רוני לוי')).toBeVisible();

    await page.keyboard.press('KeyJ');
    // First card in screen order is the CRITICAL one (איתי, 48h late) —
    // exactly what the operator should hit first.
    const focusedCard = page.locator('article:focus');
    await expect(focusedCard).toContainText('איתי כהן');
    await page.screenshot({ path: 'e2e-artifacts/05-keyboard-focus.png', fullPage: true });

    await page.keyboard.press('KeyD');
    await expect.poll(() =>
      (captured.adminActions as Array<{ action?: string }>).filter((a) => a.action === 'mark_reviewed').length,
    ).toBe(1);
  });

  test('leads list: sort select drives the query and the URL', async ({ page }) => {
    const captured = await stubNetwork(page);
    await page.goto('/leads');
    await expect(page.getByRole('link', { name: 'דנה כהן' })).toBeVisible();

    await page.getByLabel('מיון הרשימה').selectOption('score_desc');
    await expect(page).toHaveURL(/sort=score_desc/);
    await expect.poll(() =>
      captured.leadsListUrls.filter((u) => u.includes('sort=score_desc')).length,
    ).toBeGreaterThan(0);
    await page.screenshot({ path: 'e2e-artifacts/06-leads-sort.png', fullPage: true });
  });
});
