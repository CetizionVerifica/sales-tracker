import { expect, type Locator, type Page } from '@playwright/test';

export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** The sidebar's main navigation (UI guide §3). */
export const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

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

// ─── Shared pipeline steps (M6, reused by M7) ─────────────────────────────────────

export const QUOTATION_NUMBER = /^QUO-\d{4}-\d{4,}$/;

/** Today in IST as YYYY-MM-DD, plus `days`. */
export function istDay(days = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** How the app shows a calendar date (lib/format.ts). */
export const shown = (day: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));

/**
 * The value next to a label in a detail page's field list. The first match: a fact can
 * appear both in the Overview and the Key facts panel.
 */
export const detail = (page: Page, label: string) =>
  page
    .locator('dt', { hasText: new RegExp(`^${label}`) })
    .locator('xpath=following-sibling::dd')
    .first();

/** As the signed-in rep: a converted enquiry for a new client (the M4 flow); returns its URL. */
export async function convertedEnquiry(page: Page, client: string): Promise<string> {
  // New enquiries open in a side sheet (old /new links land on it).
  await page.goto('/enquiries/new');
  const sheet = page.getByRole('dialog', { name: 'New enquiry' });
  await sheet.getByRole('button', { name: 'New client' }).click();
  const dialog = page.getByRole('dialog', { name: 'New client' });
  await dialog.getByLabel('Client name').fill(client);
  await choose(page, 'Client sector', 'Energy', dialog);
  await dialog.getByRole('button', { name: 'Create client' }).click();
  await expect(dialog).toBeHidden();
  await sheet.getByLabel('Inspection').click();
  await sheet.getByLabel('Audit').click();
  await choose(page, 'Source', 'Email', sheet);
  await sheet.getByRole('button', { name: 'Create enquiry' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^ENQ-/);
  await page.getByRole('button', { name: 'Convert' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Convert' }).click();
  await expect(page.getByText('Converted', { exact: true })).toBeVisible();
  return page.url();
}

/** The open side sheet with this title (create and edit forms, UI guide §4.3). */
export const sheet = (page: Page, title: string) => page.getByRole('dialog', { name: title });

/** From a converted enquiry's page: creates a quotation and returns its number. */
export async function createQuotation(page: Page, amount: string, next: string): Promise<string> {
  await page.getByRole('button', { name: 'Create quotation' }).click();
  const form = page.getByRole('dialog', { name: 'New quotation' });
  await form.getByLabel('Amount').fill(amount);
  await form.getByLabel('Next follow-up').fill(next);
  await form.getByRole('button', { name: 'Create quotation' }).click();
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(QUOTATION_NUMBER);
  return (await heading.textContent())!.trim();
}
