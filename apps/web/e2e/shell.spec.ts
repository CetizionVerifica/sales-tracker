import { expect, test } from '@playwright/test';
import { convertedEnquiry, mainNav, signIn, signOut } from './helpers.ts';
import { E2E_USERS } from './users.ts';

// UI guide §3: the ⌘K palette jumps to records the user can read and to pages; the theme
// choice in the user menu applies and survives a reload; lists become cards on mobile.

test('⌘K finds my records (not other reps’) and pages', async ({ page }) => {
  const client = `Palette Co ${Date.now()}`;
  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  const enquiryUrl = await convertedEnquiry(page, client);
  const number = (await page.getByRole('heading', { level: 1 }).textContent())!.trim();

  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search' });
  await palette.getByRole('combobox', { name: 'Search' }).fill(client);
  await expect(palette.getByRole('option', { name: new RegExp(number) })).toBeVisible();
  await palette.getByRole('option', { name: new RegExp(number) }).click();
  await expect(page).toHaveURL(enquiryUrl);

  // Pages and actions come from the same palette, via the top bar's search button.
  await page
    .getByRole('button', { name: /Search/ })
    .first()
    .click();
  await palette.getByRole('combobox', { name: 'Search' }).fill('quotations');
  await palette.getByRole('option', { name: 'Quotations', exact: true }).click();
  await expect(page).toHaveURL(/\/quotations$/);
  await signOut(page);

  // Another rep finds the client (everyone reads clients) but not the rep's enquiry.
  await signIn(page, E2E_USERS.sales2.email, E2E_USERS.sales2.password);
  await page.keyboard.press('ControlOrMeta+k');
  await palette.getByRole('combobox', { name: 'Search' }).fill(client);
  await expect(palette.getByRole('option', { name: new RegExp(client) })).toBeVisible();
  await expect(palette.getByRole('option', { name: new RegExp(number) })).toHaveCount(0);
});

test('the dark theme applies from the user menu and survives a reload', async ({ page }) => {
  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  const html = page.locator('html');
  await expect(html).not.toHaveClass(/dark/); // light is the default
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(html).toHaveClass(/dark/);
  await page.reload();
  await expect(html).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitemradio', { name: 'Light' }).click();
  await expect(html).not.toHaveClass(/dark/);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('lists become cards and the sidebar becomes a sheet', async ({ page }) => {
    await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByRole('listitem').filter({ hasText: 'E2E Admin' })).toBeVisible();

    await expect(mainNav(page)).toBeHidden();
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await mainNav(page).getByRole('link', { name: 'Audit log' }).click();
    await expect(page).toHaveURL(/\/admin\/audit-log/);
    // No horizontal page scroll at 375px (UI guide §8), on the busiest pages too.
    for (const path of ['/admin/audit-log', '/enquiries', '/quotations', '/admin/users', '/']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflow, path).toBe(false);
    }
  });
});
