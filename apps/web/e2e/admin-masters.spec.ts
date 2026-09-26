import { expect, test } from '@playwright/test';
import { choose, signIn, signOut } from './helpers.ts';
import { E2E_USERS } from './users.ts';

// AC18: an admin creates a sector and a client with a primary contact; Sales is forbidden
// from every admin page (and the pages render nothing for them: M3 review fix C).
test('admin sets up masters; a sales user cannot open them', async ({ page }) => {
  await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);

  await page.goto('/admin/sectors');
  await page.getByRole('button', { name: 'New sector' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Aerospace');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('row', { name: /Aerospace/ })).toBeVisible();

  // Case-insensitive duplicate → field error on the name input.
  await page.getByRole('button', { name: 'New sector' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('aerospace');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('dialog')).toContainText('already exists');
  await page.keyboard.press('Escape');

  await page.goto('/admin/clients/new');
  await page.getByLabel('Name').fill('Orbital Labs');
  await choose(page, 'Sector', 'Aerospace');
  await page.getByLabel('GSTIN (optional)').fill('27aapfu0939f1zv');
  await page.getByRole('button', { name: 'Create client' }).click();
  await expect(page.getByRole('heading', { name: 'Orbital Labs' })).toBeVisible();

  await page.getByRole('button', { name: 'Add contact' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Kiran');
  await dialog.getByLabel('Email').fill('kiran@orbital.example');
  await dialog.getByLabel('Primary contact').check();
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('row', { name: /Kiran/ })).toContainText('Primary');
  await signOut(page);

  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  for (const path of ['/admin/clients', '/admin/users', '/admin/settings', '/admin/audit-log']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Forbidden' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
  }
});
