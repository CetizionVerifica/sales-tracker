import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { choose, istDay, mainNav, signIn, signOut } from './helpers.ts';
import { E2E_USERS } from './users.ts';

// M12 dashboard on the dev seed (system/seed-enquiries.ts). Uses facts that do not depend
// on today's date: 3 open quotations, 4 overdue invoices, and the USD quotation that sits
// under negotiation (quoted 100 days ago).

const panel = (page: Page, name: string) =>
  page.getByRole('region', { name: new RegExp(`^${name}`) });

async function openDashboard(page: Page) {
  await mainNav(page).getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
}

// AC13: the admin's company dashboard, a period switch, a drill-down and a CSV.
test('admin: company KPIs, period switch, drill-down and CSV export', async ({ page }) => {
  await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await openDashboard(page);
  await expect(page.getByText('3 quotations')).toBeVisible(); // open pipeline
  await expect(page.getByText('4 invoices')).toBeVisible(); // overdue receivables
  const description = page.getByRole('main').getByText(/compared with/);
  const thisQuarter = await description.textContent();

  await choose(page, 'Period', 'Last quarter');
  await expect(page).toHaveURL(/preset=lastQuarter/);
  await expect(description).not.toHaveText(thisQuarter!);

  await choose(page, 'Period', 'This financial year');
  await expect(page).toHaveURL(/preset=thisFinancialYear/);

  // Drill down from the conversion table (the keyboard path to every bar).
  const conversion = panel(page, 'Conversion');
  await conversion.getByRole('button', { name: 'Table' }).click();
  await conversion.getByRole('table').getByRole('link').first().click();
  await expect(page).toHaveURL(/\/quotations\?.*decidedFrom=/);
  await expect(page.getByRole('heading', { level: 1, name: 'Quotations' })).toBeVisible();

  await page.goBack();
  const download = page.waitForEvent('download');
  await panel(page, 'Top clients')
    .getByRole('link', { name: /Export top clients as CSV/ })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^dashboard-top-clients-.+\.csv$/);
  const text = readFileSync((await file.path())!, 'utf8');
  expect(text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(
    // The comma in "INR, incl. tax" makes that header a quoted field (RFC 4180).
    'Client,"Invoiced (INR, incl. tax)",Collected (INR),Outstanding now (INR),Won (INR),Open pipeline now (INR)',
  );
  await signOut(page);
});

// AC14: Sales see their own numbers; the PM sees the project layout.
test('sales and PM: their own scope and layout', async ({ page }) => {
  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  await openDashboard(page);
  await expect(page.getByText(/· Sam Sales/)).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Owner' })).toHaveCount(0);
  await expect(page.getByText('2 quotations')).toBeVisible(); // Sam's open pipeline
  await signOut(page);

  await signIn(page, E2E_USERS.pm.email, E2E_USERS.pm.password);
  await openDashboard(page);
  await expect(page.getByText('Active projects', { exact: true })).toBeVisible();
  await expect(panel(page, 'Billing by project')).toContainText('Rolling mill maintenance audit');
  await expect(page.getByRole('combobox', { name: 'Project manager' })).toHaveCount(0);
});

// AC15: an admin corrects a month's rate and recalculates; the quotation's INR value follows.
test('admin: edit and recalculate a rate; the quotation shows the new INR value', async ({
  page,
}) => {
  const month = istDay(-100).slice(0, 7);
  const monthName = new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00Z`));

  await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await mainNav(page).getByRole('link', { name: 'Exchange rates' }).click();
  const row = page.getByRole('row', { name: new RegExp(`${monthName}.*USD`) });
  await row.getByRole('button', { name: /Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Edit rate' }).click();
  const dialog = page.getByRole('dialog', { name: /Edit USD rate/ });
  await dialog.getByLabel('INR per unit').fill('90');
  await dialog.getByRole('button', { name: 'Save rate' }).click();
  await expect(page.getByText('Rate saved')).toBeVisible();
  await expect(row).toContainText('at an older rate');

  await row.getByRole('button', { name: /Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Recalculate' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Recalculate' }).click();
  await expect(page.getByText('Rate recalculated')).toBeVisible();

  await page.goto('/quotations?currency=USD&status=UNDER_NEGOTIATION');
  await page.getByRole('link', { name: /^QUO-/ }).first().click();
  await expect(page.getByText('≈ ₹11,25,000.00 at 90.00 INR/USD')).toBeVisible();
});
