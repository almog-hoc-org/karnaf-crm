import { test, expect } from '@playwright/test';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

test.describe('Leads list', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!EMAIL || !PASSWORD, 'Set E2E_TEST_EMAIL + E2E_TEST_PASSWORD to run.');
    await page.goto('/login');
    await page.getByLabel('אימייל').fill(EMAIL!);
    await page.getByLabel('סיסמה', { exact: true }).fill(PASSWORD!);
    await page.getByRole('button', { name: 'התחברות' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('filters by status persist in URL', async ({ page }) => {
    await page.goto('/leads');
    await expect(page.getByRole('heading', { name: 'לידים' })).toBeVisible();
    const statusSelect = page.locator('select').nth(0);
    await statusSelect.selectOption('responded');
    await expect(page).toHaveURL(/status=responded/);
  });

  test('switching search mode toggles placeholder', async ({ page }) => {
    await page.goto('/leads');
    const input = page.locator('input[placeholder*="חיפוש"]');
    await expect(input).toBeVisible();
    await page.getByRole('button', { name: 'תוכן הודעות' }).click();
    await expect(page.locator('input[placeholder*="חיפוש בתוכן ההודעות"]')).toBeVisible();
  });
});

test.describe('Queue', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!EMAIL || !PASSWORD, 'Set E2E_TEST_EMAIL + E2E_TEST_PASSWORD to run.');
    await page.goto('/login');
    await page.getByLabel('אימייל').fill(EMAIL!);
    await page.getByLabel('סיסמה', { exact: true }).fill(PASSWORD!);
    await page.getByRole('button', { name: 'התחברות' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('queue page renders status tabs', async ({ page }) => {
    await page.goto('/queue');
    await expect(page.getByRole('button', { name: /פתוח/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /נסגר/ })).toBeVisible();
  });
});
