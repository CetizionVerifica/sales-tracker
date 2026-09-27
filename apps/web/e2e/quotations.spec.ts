import { expect, type Page, test } from '@playwright/test';
import { choose, signIn, signOut } from './helpers.ts';
import { E2E_USERS } from './users.ts';

const NUMBER = /^QUO-\d{4}-\d{4,}$/;

/** Today in IST as YYYY-MM-DD, plus `days`. */
function istDay(days = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** How the app shows a calendar date (lib/format.ts). */
const shown = (day: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));

/** The value next to a label in a detail page's field list. */
const detail = (page: Page, label: string) =>
  page.locator('dt', { hasText: new RegExp(`^${label}`) }).locator('xpath=following-sibling::dd');

/** As the signed-in rep: a converted enquiry for a new client (the M4 flow); returns its URL. */
async function convertedEnquiry(page: Page, client: string): Promise<string> {
  await page.goto('/enquiries/new');
  await page.getByRole('button', { name: 'New client' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Client name').fill(client);
  await choose(page, 'Client sector', 'Energy', dialog);
  await dialog.getByRole('button', { name: 'Create client' }).click();
  await expect(dialog).toBeHidden();
  await page.getByLabel('Inspection').click();
  await page.getByLabel('Audit').click();
  await choose(page, 'Source', 'Email');
  await page.getByRole('button', { name: 'Create enquiry' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^ENQ-/);
  await page.getByRole('button', { name: 'Convert' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Convert' }).click();
  await expect(page.getByText('Converted', { exact: true })).toBeVisible();
  return page.url();
}

/** From a converted enquiry's page: creates a quotation and returns its number. */
async function createQuotation(page: Page, amount: string, next: string): Promise<string> {
  await page.getByRole('link', { name: 'Create quotation' }).click();
  await expect(page.getByRole('heading', { name: 'New quotation' })).toBeVisible();
  await page.getByLabel('Amount').fill(amount);
  await page.getByLabel('Next follow-up').fill(next);
  await page.getByRole('button', { name: 'Create quotation' }).click();
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(NUMBER);
  return (await heading.textContent())!.trim();
}

// AC16: create from a converted enquiry, follow up (highlights and next date sync),
// negotiate, receive the PO and reach the project hand-off; lose a second quotation and
// see it leave the follow-up-due list.
test('quotation: create → follow up → negotiate → PO received → project draft; lost', async ({
  page,
}) => {
  const client = `Quote Co ${Date.now()}`;
  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  const enquiryUrl = await convertedEnquiry(page, client);

  // Pre-filled from the enquiry (M4's quotation draft).
  await page.getByRole('link', { name: 'Create quotation' }).click();
  await expect(page.getByLabel('Client', { exact: true })).toHaveValue(client);
  await expect(page.getByLabel('Inspection')).toBeChecked();
  await expect(page.getByLabel('Audit')).toBeChecked();
  await expect(page.getByLabel('Certification')).not.toBeChecked();
  await expect(page.getByLabel('Quotation date')).toHaveValue(istDay());
  await expect(page.getByLabel('Currency')).toContainText('INR');

  // A next follow-up date is required; the amount preview shows what will be saved.
  await page.getByLabel('Amount').fill('1,25,000.50');
  await expect(page.getByText('₹1,25,000.50')).toBeVisible();
  await page.getByRole('button', { name: 'Create quotation' }).click();
  await expect(page.getByText('Enter the next follow-up date')).toBeVisible();
  await page.getByRole('button', { name: '+1 week' }).click();
  await page.getByRole('button', { name: 'Create quotation' }).click();

  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(NUMBER);
  const number = (await heading.textContent())!.trim();
  await expect(detail(page, 'Amount')).toHaveText('₹1,25,000.50');
  await expect(page.getByText('Sent', { exact: true })).toBeVisible();
  await expect(detail(page, 'Next follow-up')).toHaveText(shown(istDay(7)));

  // A follow-up moves the next date and becomes the highlights.
  await page.getByRole('button', { name: 'Log follow-up' }).click();
  const log = page.getByRole('dialog');
  await choose(page, 'Channel', 'Call', log);
  await log.getByLabel('Notes').fill('Client wants a 5% discount');
  await log.getByRole('button', { name: '+2 weeks' }).click();
  await log.getByRole('button', { name: 'Log follow-up' }).click();
  await expect(log).toBeHidden();
  await expect(detail(page, 'Next follow-up')).toHaveText(shown(istDay(14)));
  await expect(detail(page, 'Follow-up highlights')).toHaveText('Client wants a 5% discount');

  // Negotiate, then the PO arrives.
  await page.getByRole('button', { name: 'Mark under negotiation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark under negotiation' }).click();
  await expect(page.getByText('Under negotiation', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'PO received' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'PO received' }).click();
  // The "done when": the project prompt, and the draft it hands to M8.
  const createProject = page.getByRole('link', { name: 'Create project' });
  await expect(createProject).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark lost' })).toHaveCount(0);
  await expect(detail(page, 'PO received on')).toHaveText(shown(istDay()));
  await createProject.click();
  await expect(page.getByRole('heading', { name: 'New project' })).toBeVisible();
  await expect(detail(page, 'Quotation')).toHaveText(number);
  await expect(detail(page, 'Client')).toHaveText(client);
  await expect(detail(page, 'Services')).toHaveText('Audit, Inspection');
  await expect(detail(page, 'Revenue')).toHaveText('₹1,25,000.50');

  // A second quotation, due today, is lost and leaves the follow-up-due list.
  await page.goto(enquiryUrl);
  await expect(page.getByRole('link', { name: number })).toBeVisible(); // Quotations section
  const second = await createQuotation(page, '50000', istDay());
  const secondUrl = page.url();
  await page.goto(`/quotations?followUpDue=true&q=${second}`);
  await expect(page.getByRole('link', { name: second })).toBeVisible();
  await page.goto(secondUrl);
  await page.getByRole('button', { name: 'Mark lost' }).click();
  const lost = page.getByRole('dialog');
  await lost.getByRole('button', { name: 'Mark lost' }).click();
  await expect(lost.getByText('Say why the quotation was lost')).toBeVisible();
  await lost.getByLabel('Why was it lost?').fill('Price too high');
  await lost.getByRole('button', { name: 'Mark lost' }).click();
  await expect(detail(page, 'Lost because')).toHaveText('Price too high');
  await page.goto(`/quotations?followUpDue=true&q=${second}`);
  await expect(page.getByText('No quotations match these filters.')).toBeVisible();
});

// AC17: another rep neither lists nor opens it; an admin finds it by number and reassigns it.
test('quotation: RBAC and admin reassignment', async ({ page }) => {
  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  await convertedEnquiry(page, `Private Co ${Date.now()}`);
  const number = await createQuotation(page, '75000', istDay(3));
  const url = page.url();
  await signOut(page);

  await signIn(page, E2E_USERS.sales2.email, E2E_USERS.sales2.password);
  await page.goto('/quotations');
  await expect(page.getByRole('heading', { name: 'Quotations' })).toBeVisible();
  await expect(page.getByRole('link', { name: number })).toHaveCount(0);
  await page.goto(url);
  await expect(page.getByText('This page could not be found')).toBeVisible();
  await signOut(page);

  await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await page.getByRole('link', { name: 'Quotations' }).click();
  await page.getByLabel('Search').fill(number);
  await page.getByLabel('Search').press('Enter');
  await page.getByRole('link', { name: number }).click();
  await page.getByRole('link', { name: 'Edit' }).click();
  await choose(page, 'Owner', 'Sita Sales');
  await page.getByRole('button', { name: 'Save quotation' }).click();
  await expect(page).toHaveURL(url);
  await expect(detail(page, 'Owner')).toHaveText('Sita Sales');
  await signOut(page);

  // Now it is Sita's.
  await signIn(page, E2E_USERS.sales2.email, E2E_USERS.sales2.password);
  await page.goto('/quotations');
  await expect(page.getByRole('link', { name: number })).toBeVisible();
});
