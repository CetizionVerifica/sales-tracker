import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  choose,
  convertedEnquiry,
  createQuotation,
  detail,
  istDay,
  signIn,
  signOut,
} from './helpers.ts';
import { E2E_USERS } from './users.ts';

// The fixture's hash is registered with the mock extractor (mock-extractor.json): it reads
// PO 4500098765, ₹3,40,000.00 and the terms "30% advance, balance within 45 days of
// invoice", with the net days misread as 30 (low confidence).
const FIXTURE = fileURLToPath(
  new URL('../../../packages/core/test/fixtures/documents/globex-po.pdf', import.meta.url),
);
const PO_NUMBER = '4500098765';
const TERMS = '30% advance, balance within 45 days of invoice';

/**
 * As the signed-in rep: a won quotation and its project for the dev PM (the M6 → M8 flow).
 * Returns the project's URL and number.
 */
async function projectFor(page: Page, client: string) {
  await convertedEnquiry(page, client);
  const quotationNumber = await createQuotation(page, '1,25,000.50', istDay(7));
  await page.getByRole('button', { name: 'PO received' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'PO received' }).click();
  await page.getByRole('link', { name: 'Create project' }).click();
  await page.getByLabel('Name').fill('Boiler inspection');
  await choose(page, 'Project manager', 'Priya PM');
  await page.getByRole('button', { name: 'Create project' }).click();
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(/^PRJ-\d{4}-\d{4,} · /);
  const projectNumber = (await heading.textContent())!.trim().split(' · ')[0]!;
  return { projectUrl: page.url(), projectNumber, quotationNumber };
}

// AC14: Add PO from the project (pre-filled) → attach the client's PDF → the worker reads it
// → review: correct the net days, confirm → the PO shows the terms, the project lists it.
test('purchase order: add from the project → read the PDF → review → confirm', async ({ page }) => {
  test.slow(); // the whole pipeline, plus the worker reading the file
  const client = `PO Co ${Date.now()}`;
  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  const { projectUrl, projectNumber, quotationNumber } = await projectFor(page, client);

  await page.getByRole('link', { name: 'Add PO' }).click();
  await expect(page.getByRole('heading', { name: 'New purchase order' })).toBeVisible();
  await expect(page.getByTestId('po-client')).toHaveText(client);
  await expect(page.getByLabel('Inspection')).toBeChecked();
  await expect(page.getByLabel('Audit')).toBeChecked();
  await expect(page.getByLabel('Amount')).toHaveValue('125000.50');
  await expect(page.getByText(`Remaining on ${projectNumber}`)).toBeVisible();
  await expect(page.getByLabel('Received on')).toHaveValue(istDay(0));
  await expect(page.getByText(`From ${quotationNumber}’s PO received date`)).toBeVisible();

  await page.getByLabel('PO number').fill(PO_NUMBER);
  await page.getByLabel('Choose the PO document').setInputFiles(FIXTURE);
  await expect(page.getByText('globex-po.pdf')).toBeVisible();
  await page.getByRole('button', { name: 'Create purchase order' }).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`PO ${PO_NUMBER}`);
  const poUrl = page.url();
  await expect(page.getByText('Pending', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Status follows this PO’s invoices')).toBeVisible();
  const card = page.getByRole('region', { name: 'PO document' });
  await expect(card.getByText(/Reading document…|Ready to review/)).toBeVisible();
  await expect(card.getByText('Ready to review')).toBeVisible({ timeout: 30_000 });

  await card.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByRole('heading', { name: 'Review globex-po.pdf' })).toBeVisible();
  await expect(page.getByLabel('Amount from the document')).toHaveValue('340000.00');
  await expect(page.getByLabel('Payment terms from the document')).toHaveValue(TERMS);
  await expect(page.getByText(`Now on PO ${PO_NUMBER}`)).toHaveCount(4); // one per review row
  await expect(page.getByText('Date on the PO')).toBeVisible();

  // The net days were misread with low confidence, so they are not ticked; correct them.
  const days = page.getByLabel('Net days from the document');
  await expect(days).toHaveValue('30');
  await expect(page.getByRole('checkbox', { name: 'Apply net days' })).not.toBeChecked();
  await days.fill('45');
  await page.getByRole('checkbox', { name: 'Apply net days' }).check();
  // Keep the quoted amount: the PO total includes tax.
  await page.getByRole('checkbox', { name: 'Apply amount' }).uncheck();
  await page.getByRole('button', { name: 'Confirm and save' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm and save' }).click();

  await expect(page).toHaveURL(poUrl);
  await expect(detail(page, 'Payment terms')).toHaveText(TERMS);
  await expect(detail(page, 'Net days')).toHaveText('45');
  await expect(detail(page, 'Amount')).toHaveText('₹1,25,000.50');
  await expect(page.getByText(/^Confirmed by /)).toBeVisible();

  // The project lists it as Pending, and its pipeline strip's PO stage links to it.
  await page.goto(projectUrl);
  const section = page.getByRole('region', { name: 'Purchase orders' });
  await expect(section.getByRole('row', { name: new RegExp(PO_NUMBER) })).toContainText('Pending');
  await expect(section.getByText(/POs cover ₹1,25,000\.50 of ₹1,25,000\.50 revenue/)).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Pipeline' })
    .getByRole('link', { name: 'PO' })
    .click();
  await expect(page).toHaveURL(poUrl);
});

// The PO is saved before its file uploads; a rejected file keeps the PO and says so
// (M9 Decision 3).
test('purchase order: a failed upload keeps the PO and asks to upload again', async ({ page }) => {
  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  const { projectUrl } = await projectFor(page, `Upload Co ${Date.now()}`);
  await page.goto(`/purchase-orders/new?projectId=${projectUrl.split('/').pop()}`);
  await page.getByLabel('PO number').fill('PO-UPLOAD-1');
  await page.getByLabel('Choose the PO document').setInputFiles({
    name: 'not-really.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('this is not a PDF'),
  });
  await page.getByRole('button', { name: 'Create purchase order' }).click();
  await expect(page.getByText(/The PO was saved, but its document did not upload/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('PO PO-UPLOAD-1');
  await expect(
    page.getByRole('region', { name: 'PO document' }).getByText('Upload PO document'),
  ).toBeVisible();
});

// AC15: the project's PM edits the PO; a second PM gets not-found pages; an admin cannot
// delete the project while it has POs.
test('purchase order: PM edits, another PM cannot see it, project delete is blocked', async ({
  page,
}) => {
  test.slow(); // four sign-ins and the worker reading the file
  const stamp = Date.now();
  const pm2 = {
    name: `Paro PM ${stamp}`,
    email: `paro.pm.${stamp}@example.test`,
    password: 'paro-pm-initial-pass',
  };
  await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'New user' }).click();
  const create = page.getByRole('dialog', { name: 'New user' });
  await create.getByLabel('Name').fill(pm2.name);
  await create.getByLabel('Email').fill(pm2.email);
  await create.getByLabel('Initial password').fill(pm2.password);
  await choose(page, 'Role', 'Project manager', create);
  await create.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByText('User created')).toBeVisible();
  await signOut(page);

  // The Sales owner records a PO with its document.
  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  const { projectUrl } = await projectFor(page, `Scoped PO Co ${stamp}`);
  await page.getByRole('link', { name: 'Add PO' }).click();
  await page.getByLabel('PO number').fill(`SC-${stamp}`);
  await page.getByLabel('Choose the PO document').setInputFiles(FIXTURE);
  await page.getByRole('button', { name: 'Create purchase order' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`PO SC-${stamp}`);
  const poUrl = page.url();
  const card = page.getByRole('region', { name: 'PO document' });
  await expect(card.getByText('Ready to review')).toBeVisible({ timeout: 30_000 });
  await card.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByRole('heading', { name: 'Review globex-po.pdf' })).toBeVisible();
  const reviewUrl = page.url();
  await signOut(page);

  // The project's PM sees it and edits its description.
  await signIn(page, E2E_USERS.pm.email, E2E_USERS.pm.password);
  await page.goto('/purchase-orders');
  await page.getByRole('link', { name: `SC-${stamp}` }).click();
  await expect(page).toHaveURL(poUrl);
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Edit PO SC-${stamp}` })).toBeVisible();
  await page.getByLabel('Scope and notes (optional)').fill('Covers phase 1 only');
  await page.getByRole('button', { name: 'Save purchase order' }).click();
  await expect(page).toHaveURL(poUrl);
  await expect(detail(page, 'Scope and notes')).toHaveText('Covers phase 1 only');
  await signOut(page);

  // A second PM gets not-found pages for the PO and its document's review.
  await signIn(page, pm2.email, pm2.password);
  await page.goto(poUrl);
  await expect(page.getByText('This page could not be found')).toBeVisible();
  await page.goto(reviewUrl);
  await expect(page.getByText('This page could not be found')).toBeVisible();
  await signOut(page);

  // An admin's Delete on the project explains that its POs go first.
  await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await page.goto(projectUrl);
  await page.getByRole('button', { name: /^Actions for PRJ-/ }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Delete its purchase orders first (1)');
  await expect(dialog.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^PRJ-/);
});
