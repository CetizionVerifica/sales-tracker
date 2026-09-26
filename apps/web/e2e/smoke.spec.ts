import { expect, test } from '@playwright/test';

test('home page renders the app name', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sales Tracker' })).toBeVisible();
});

test('GET /api/health reports ok', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'ok' });
});
