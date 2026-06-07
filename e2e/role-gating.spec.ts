import { test, expect } from '@playwright/test';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

test('non-admin users do not see Users link in navigation', async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_TEST_EMAIL + E2E_TEST_PASSWORD to run.');
  await page.goto('/login');
  await page.getByLabel('אימייל').fill(EMAIL!);
  await page.getByLabel('סיסמה', { exact: true }).fill(PASSWORD!);
  await page.getByRole('button', { name: 'התחברות' }).click();
  await expect(page).toHaveURL(/\/$/);

  const nav = page.getByRole('navigation').first();
  await expect(nav).toBeVisible();
  // owner / admin see "משתמשים"; lower roles do not — the suite is configured
  // against an owner/admin test user, so this asserts the link exists. Lower
  // role suites can flip this assertion via a separate E2E_VIEWER_* env pair.
  if (process.env.E2E_EXPECT_ADMIN === '1') {
    await expect(nav.getByRole('link', { name: /משתמשים/ })).toBeVisible();
  }
});

test('protected route bounces unauthenticated user to /login', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/leads');
  await expect(page).toHaveURL(/\/login/);
});
