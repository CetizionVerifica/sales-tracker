import { expect, test } from '@playwright/test';
import {
  choose,
  convertedEnquiry,
  mainNav,
  createQuotation,
  detail,
  istDay,
  QUOTATION_NUMBER as NUMBER,
  sheet,
  shown,
  signIn,
  signOut,
} from './helpers.ts';
import { E2E_USERS } from './users.ts';

// AC16: create from a converted enquiry, follow up (highlights and next date sync),
// negotiate, receive the PO and reach the project hand-off; lose a second quotation and
// see it leave the follow-up-due list.
test('quotation: create → follow up → negotiate → PO received → project draft; lost', async ({
  page,
}) => {
  const client = `Quote Co ${Date.now()}`;
  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  const enquiryUrl = await convertedEnquiry(page, client);

  // Pre-filled from the enquiry (M4's quotation draft), in a side sheet on the enquiry.
  await page.getByRole('button', { name: 'Create quotation' }).click();
  const form = sheet(page, 'New quotation');
  await expect(form.getByTestId('quotation-client')).toHaveText(client);
  await expect(form.getByLabel('Inspection')).toBeChecked();
  await expect(form.getByLabel('Audit')).toBeChecked();
  await expect(form.getByLabel('Certification')).not.toBeChecked();
  await expect(form.getByLabel('Quotation date')).toHaveValue(istDay());
  await expect(form.getByLabel('Currency')).toContainText('INR');

  // A next follow-up date is required; the amount preview shows what will be saved.
  await form.getByLabel('Amount').fill('1,25,000.50');
  await expect(form.getByText('₹1,25,000.50')).toBeVisible();
  await form.getByRole('button', { name: 'Create quotation' }).click();
  await expect(form.getByText('Enter the next follow-up date')).toBeVisible();
  await form.getByRole('button', { name: '+1 week' }).click();
  await form.getByRole('button', { name: 'Create quotation' }).click();

  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(NUMBER);
  const number = (await heading.textContent())!.trim();
  await expect(detail(page, 'Amount')).toHaveText('₹1,25,000.50');
  await expect(page.getByText('Sent', { exact: true })).toBeVisible();
  await expect(detail(page, 'Next follow-up')).toContainText(shown(istDay(7)));

  // A follow-up moves the next date and becomes the highlights.
  await page.getByRole('button', { name: 'Log follow-up' }).click();
  const log = sheet(page, 'Log follow-up');
  await choose(page, 'Channel', 'Call', log);
  await log.getByLabel('Notes').fill('Client wants a 5% discount');
  await log.getByRole('button', { name: '+2 weeks' }).click();
  await log.getByRole('button', { name: 'Log follow-up' }).click();
  await expect(log).toBeHidden();
  await expect(detail(page, 'Next follow-up')).toContainText(shown(istDay(14)));
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
  await expect(page.getByRole('link', { name: number }).first()).toBeVisible(); // Quotations
  const second = await createQuotation(page, '50000', istDay());
  const secondUrl = page.url();
  await page.goto(`/quotations?followUpDue=true&q=${second}`);
  await expect(page.getByRole('link', { name: second })).toBeVisible();
  await page.goto(secondUrl);
  await page.getByRole('button', { name: 'Mark lost' }).click();
  const lost = page.getByRole('dialog', { name: /lost/i });
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
  await expect(page.getByRole('heading', { level: 1, name: 'Quotations' })).toBeVisible();
  await expect(page.getByRole('link', { name: number })).toHaveCount(0);
  await page.goto(url);
  await expect(page.getByText('This page could not be found')).toBeVisible();
  await signOut(page);

  await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await mainNav(page).getByRole('link', { name: 'Quotations' }).click();
  await page.getByLabel('Search', { exact: true }).fill(number);
  await page.getByLabel('Search', { exact: true }).press('Enter');
  await page.getByRole('link', { name: number }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = sheet(page, `Edit ${number}`);
  await choose(page, 'Owner', 'Sita Sales', edit);
  await edit.getByRole('button', { name: 'Save quotation' }).click();
  await expect(page.getByText('Quotation saved')).toBeVisible();
  await expect(page).toHaveURL(url);
  await expect(detail(page, 'Owner')).toContainText('Sita Sales');
  await signOut(page);

  // Now it is Sita's.
  await signIn(page, E2E_USERS.sales2.email, E2E_USERS.sales2.password);
  await page.goto('/quotations');
  await expect(page.getByRole('link', { name: number })).toBeVisible();
});
