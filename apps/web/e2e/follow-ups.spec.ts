import { expect, type Page, test } from '@playwright/test';
import { choose, signIn, signOut } from './helpers.ts';
import { E2E_USERS } from './users.ts';

/** Timeline event texts, newest first. */
const events = (page: Page) =>
  page.getByRole('list', { name: 'Timeline' }).locator('li[data-kind]').allInnerTexts();

// AC12 and AC13: a rep logs a client-level call and an enquiry follow-up, converts the
// enquiry, and sees all four events in order on the client; another rep sees only the
// client-level call; an admin sees everything.
test('follow-ups: client timeline with mixed events and per-user visibility', async ({ page }) => {
  const client = `Timeline Co ${Date.now()}`;

  // Setup: an enquiry for a new client with a contact (the M4 flow).
  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  await page.goto('/enquiries/new');
  await page.getByRole('button', { name: 'New client' }).click();
  const newClient = page.getByRole('dialog');
  await newClient.getByLabel('Client name').fill(client);
  await choose(page, 'Client sector', 'Energy', newClient);
  await newClient.getByLabel('Primary contact (optional)').fill('Meera');
  await newClient.getByRole('button', { name: 'Create client' }).click();
  await expect(newClient).toBeHidden();
  await page.getByLabel('Inspection').click();
  await choose(page, 'Source', 'Email');
  await page.getByRole('button', { name: 'Create enquiry' }).click();
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(/^ENQ-/);
  const number = (await heading.textContent())!.trim();

  // AC12: open the client from Clients and log a client-level call.
  await page.getByRole('link', { name: 'Clients' }).click();
  await page.getByLabel('Search').fill(client);
  await page.getByLabel('Search').press('Enter');
  await page.getByRole('link', { name: client }).click();
  await expect(page.getByRole('heading', { name: client })).toBeVisible();
  const clientUrl = page.url();

  await page.getByRole('button', { name: 'Log follow-up' }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('About')).toContainText(`${client} (client)`);
  await choose(page, 'Channel', 'Call', dialog);
  await dialog.getByLabel('Notes').fill('Intro call with the plant head');
  await dialog.getByRole('button', { name: 'Log follow-up' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Intro call with the plant head')).toBeVisible();

  // Open the enquiry and log an email with a next date.
  await page.getByRole('link', { name: number }).first().click();
  await expect(heading).toHaveText(number); // wait for the navigation before clicking again
  await page.getByRole('button', { name: 'Log follow-up' }).click();
  dialog = page.getByRole('dialog');
  await choose(page, 'Channel', 'Email', dialog);
  await choose(page, 'Contact', 'Meera', dialog);
  await dialog.getByLabel('Notes').fill('Sent the proposal');
  await dialog.getByRole('button', { name: '+1 week' }).click();
  await dialog.getByRole('button', { name: 'Log follow-up' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Sent the proposal')).toBeVisible();
  await expect(page.getByText('Next follow-up').first()).toBeVisible();

  // Convert it.
  await page.getByRole('button', { name: 'Convert' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Convert' }).click();
  await expect(page.getByText('Converted', { exact: true })).toBeVisible();

  // The client timeline shows all four, newest first.
  await page.goto(clientUrl);
  const mine = await events(page);
  expect(mine).toHaveLength(4);
  expect(mine[0]).toContain('changed status from In progress to Converted');
  expect(mine[1]).toContain('Sent the proposal');
  expect(mine[1]).toContain('with Meera');
  expect(mine[2]).toContain('Intro call with the plant head');
  expect(mine[3]).toContain(`created Enquiry ${number}`);
  await signOut(page);

  // AC13: another rep sees the client-level call only.
  await signIn(page, E2E_USERS.sales2.email, E2E_USERS.sales2.password);
  await page.goto(clientUrl);
  const theirs = await events(page);
  expect(theirs).toHaveLength(1);
  expect(theirs[0]).toContain('Intro call with the plant head');
  await expect(page.getByText(number)).toHaveCount(0);
  // Not the author: no edit or delete.
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await signOut(page);

  // The admin sees everything.
  await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await page.goto(clientUrl);
  expect(await events(page)).toHaveLength(4);
});
