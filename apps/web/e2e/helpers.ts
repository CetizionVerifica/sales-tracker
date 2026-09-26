import { expect, type Locator, type Page } from '@playwright/test';

export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/**
 * Picks an option in a shadcn/Radix Select by its exact label, searched within `scope`
 * (e.g. the open dialog) so list filters with similar labels don't match.
 */
export async function choose(
  page: Page,
  label: string,
  option: string,
  scope: Locator = page.locator('body'),
) {
  await scope.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
