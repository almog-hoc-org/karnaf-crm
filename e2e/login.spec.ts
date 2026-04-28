import { test, expect } from '@playwright/test';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

test.skip(!EMAIL || !PASSWORD, 'Set E2E_TEST_EMAIL + E2E_TEST_PASSWORD to run.');

test('login redirects to dashboard and renders the operator console', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Karnaf CRM' })).toBeVisible();

  await page.getByLabel('אימייל').fill(EMAIL!);
  await page.getByLabel('סיסמה', { exact: true }).fill(PASSWORD!);
  await page.getByRole('button', { name: 'התחברות' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'מסך מצב' })).toBeVisible();
  await expect(page.getByRole('navigation').first()).toBeVisible();
});
