import { expect, test } from '@playwright/test';
import { choose, mainNav, sheet, signIn, signOut } from './helpers.ts';
import { E2E_USERS } from './users.ts';

const NUMBER = /^ENQ-\d{4}-\d{4,}$/;

// AC14 and AC15: a rep logs a tender enquiry (with a new client), converts it and reaches
// the quotation hand-off; another rep cannot see it; an admin finds it and reassigns it.
test('enquiry: create → convert → quotation draft; RBAC and reassignment', async ({ page }) => {
  const client = `Tender Co ${Date.now()}`;

  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  await mainNav(page).getByRole('link', { name: 'Enquiries' }).click();
  await page.getByRole('button', { name: 'New enquiry' }).click();
  const form = sheet(page, 'New enquiry');

  // New client inline, with a primary contact.
  await form.getByRole('button', { name: 'New client' }).click();
  const dialog = page.getByRole('dialog', { name: 'New client' });
  await dialog.getByLabel('Client name').fill(client);
  await choose(page, 'Client sector', 'Energy', dialog);
  await dialog.getByLabel('Primary contact (optional)').fill('Meera');
  await dialog.getByLabel('Contact email').fill('meera@tender.example');
  await dialog.getByRole('button', { name: 'Create client' }).click();
  await expect(dialog).toBeHidden();
  await expect(form.getByLabel('Client', { exact: true })).toContainText(client);
  await expect(form.getByLabel('Sector', { exact: true })).toContainText('Energy');

  await form.getByLabel('Inspection').click();
  await form.getByLabel('Certification').click();
  await choose(page, 'Source', 'Tender portal', form);
  // Tender portal needs its details (M4 Decision 10).
  await form.getByRole('button', { name: 'Create enquiry' }).click();
  await expect(form.getByText('Add the details for this source')).toBeVisible();
  await form.getByLabel('Portal and tender ID').fill('GeM GEM/2026/B/7777');
  await form.getByRole('button', { name: 'Create enquiry' }).click();

  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(NUMBER);
  const number = (await heading.textContent())!.trim();
  const url = page.url();
  await expect(page.getByText('In progress', { exact: true })).toBeVisible();
  await expect(page.getByText('GeM GEM/2026/B/7777')).toBeVisible();

  // Convert: the dialog records the proposal sent date (defaults to today).
  await page.getByRole('button', { name: 'Convert' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Convert' }).click();
  await expect(page.getByText('Converted', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark lost' })).toHaveCount(0);

  // The quotation form opens in a sheet on the enquiry, pre-filled from the draft.
  await page.getByRole('button', { name: 'Create quotation' }).click();
  const quote = sheet(page, 'New quotation');
  await expect(quote).toContainText(`From ${number}`);
  await expect(quote.getByTestId('quotation-client')).toHaveText(client);
  await expect(quote.getByLabel('Certification')).toBeChecked();
  await expect(quote.getByLabel('Inspection')).toBeChecked();
  await expect(quote.getByLabel('Audit')).not.toBeChecked();
  await expect(quote.getByLabel('Quotation date')).not.toHaveValue('');
  await page.keyboard.press('Escape');
  await signOut(page);

  // AC15: another rep neither lists nor opens it.
  await signIn(page, E2E_USERS.sales2.email, E2E_USERS.sales2.password);
  await page.goto('/enquiries');
  await expect(page.getByRole('heading', { level: 1, name: 'Enquiries' })).toBeVisible();
  await expect(page.getByRole('link', { name: number })).toHaveCount(0);
  await page.goto(url);
  await expect(page.getByText('This page could not be found')).toBeVisible();
  await signOut(page);

  // The admin finds it by number and reassigns it.
  await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await page.goto('/enquiries');
  await page.getByLabel('Search', { exact: true }).fill(number);
  await page.getByLabel('Search', { exact: true }).press('Enter');
  await page.getByRole('link', { name: number }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = sheet(page, `Edit ${number}`);
  await choose(page, 'Owner', 'Sita Sales', edit);
  await edit.getByRole('button', { name: 'Save enquiry' }).click();
  await expect(page.getByText('Enquiry saved')).toBeVisible();
  await expect(page).toHaveURL(url);
  await expect(page.getByLabel('Key facts')).toContainText('Sita Sales');
  // M5 replaced the History panel with the timeline (status changes only); field edits
  // stay in the audit log, where the admin sees their own change.
  await page.goto('/activity');
  await expect(
    page.getByRole('row').filter({ hasText: 'Enquiry' }).filter({ hasText: 'Updated' }).first(),
  ).toContainText('Owner id');
});
