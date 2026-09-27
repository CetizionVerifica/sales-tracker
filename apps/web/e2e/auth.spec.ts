import { expect, test, type Page } from '@playwright/test';
import { signOut } from './helpers.ts';
import { E2E_USERS } from './users.ts';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

// AC13: one flow covering redirect, sign-in, admin access, sign-out and a forbidden role.
test('sign-in, admin access, sign-out and forbidden admin area', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);

  await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expect(page).toHaveURL(/\/$/);
  const header = page.getByRole('banner');
  await expect(header).toContainText('E2E Admin');
  await expect(header).toContainText('Admin');

  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toContainText('Audit log');

  await signOut(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);

  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  await expect(page).toHaveURL(/\/$/);
  // The Admin group is hidden, and the page itself says so (UI guide §6).
  await expect(page.getByRole('navigation', { name: 'Main' })).not.toContainText('Audit log');
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
});

test('a wrong password shows one generic error', async ({ page }) => {
  await signIn(page, E2E_USERS.admin.email, 'definitely-wrong-password');
  // Filter by text: Next's route announcer also has role="alert".
  await expect(page.getByRole('alert').filter({ hasText: 'Email or password' })).toHaveText(
    'Email or password is incorrect',
  );
  await expect(page).toHaveURL(/\/login/);
});
