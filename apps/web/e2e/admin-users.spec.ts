import { expect, test } from '@playwright/test';
import { choose, signIn, signOut } from './helpers.ts';
import { E2E_USERS } from './users.ts';

const REP = { name: 'Priya Rep', email: 'priya.rep@example.test', password: 'priya-initial-pass' };

// AC15–AC17: one admin flow over the user lifecycle, then the audit views.
test('admin manages a user end to end, and the audit views show it', async ({ page }) => {
  const { admin } = E2E_USERS;

  // AC17: create a sales user.
  await signIn(page, admin.email, admin.password);
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'New user' }).click();
  const create = page.getByRole('dialog');
  await create.getByLabel('Name').fill(REP.name);
  await create.getByLabel('Email').fill(REP.email);
  await create.getByLabel('Initial password').fill(REP.password);
  await create.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByText('User created')).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(REP.name) });
  await expect(row).toContainText('Sales');
  await signOut(page);

  // The new user can sign in.
  await signIn(page, REP.email, REP.password);
  await expect(page.getByRole('banner')).toContainText(REP.name);
  await signOut(page);

  // Admin changes the role and resets the password.
  await signIn(page, admin.email, admin.password);
  await page.goto('/admin/users');
  await row.getByRole('button', { name: 'Edit' }).click();
  await choose(page, 'Role', 'Project manager', page.getByRole('dialog'));
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('Project manager');

  await row.getByRole('button', { name: 'Reset password' }).click();
  const reset = page.getByRole('dialog');
  await reset.getByRole('button', { name: 'Generate' }).click();
  await reset.getByRole('button', { name: 'Reset password' }).click();
  const issued = (await reset.getByTestId('issued-password').textContent()) ?? '';
  expect(issued).toHaveLength(16);
  await page.keyboard.press('Escape');

  // AC15: the audit log shows the role change, with the changed field highlighted.
  await page.goto('/admin/audit-log');
  const update = page
    .getByRole('row')
    .filter({ hasText: 'UPDATE' })
    .filter({ hasText: 'role' })
    .first();
  await expect(update).toContainText('E2E Admin');
  await update.getByRole('button', { name: 'View' }).click();
  await expect(
    page.getByRole('table', { name: 'Changes' }).locator('tr[data-changed]'),
  ).toContainText(['role']);
  await page.keyboard.press('Escape');
  await signOut(page);

  // AC16: the user changes their own password; /activity shows only their own change.
  await signIn(page, REP.email, issued);
  await page.goto('/account/password');
  await page.getByLabel('Current password').fill(issued);
  await page.getByLabel('New password').fill('priya-chosen-password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed')).toBeVisible();

  await page.goto('/activity');
  const rows = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'View' }) });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Account');
  await expect(page.getByRole('columnheader', { name: 'Who' })).toHaveCount(0);
});
