import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { choose, detail, signIn, signOut } from './helpers.ts';
import { E2E_USERS } from './users.ts';

// The fixture's hash is registered with the mock extractor (mock-extractor.json): it reads
// invoice INV/26-27/0101 billed to "Globex Ltd" against PO 4500098765, so on a seeded
// Acme-side PO the review shows the client and PO-number warnings.
const FIXTURE = fileURLToPath(
  new URL('../../../packages/core/test/fixtures/documents/globex-invoice.pdf', import.meta.url),
);
// A seeded PO on net-45 terms (system/seed-enquiries.ts), managed by the dev PM, half
// invoiced and paid, so the rest makes it Paid.
const SEEDED_PO = '4500012345';

// AC13: the PM adds an invoice on a seeded PO with its file → reviews (warnings shown) →
// confirms → marks it paid → the PO is Paid. A second PM cannot see it; the PO's Delete
// explains its invoices go first.
test('invoice: add on a PO → review → mark paid → PO paid; scoped to its PM', async ({ page }) => {
  test.slow(); // three sign-ins and the worker reading the file
  const stamp = Date.now();
  const invoiceNumber = `INV/E2E/${stamp}`;
  const pm2 = {
    name: `Ira PM ${stamp}`,
    email: `ira.pm.${stamp}@example.test`,
    password: 'ira-pm-initial-pass',
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

  await signIn(page, E2E_USERS.pm.email, E2E_USERS.pm.password);
  await page.goto('/purchase-orders');
  await page.getByRole('link', { name: SEEDED_PO, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`PO ${SEEDED_PO}`);
  const poUrl = page.url();
  await expect(page.getByText('Pending', { exact: true }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Add invoice' }).click();
  await expect(page.getByRole('heading', { name: 'New invoice' })).toBeVisible();
  await expect(page.getByTestId('due-hint')).toHaveText(`Net 45 from PO ${SEEDED_PO}`);
  await expect(page.getByText(`Remaining on PO ${SEEDED_PO}`)).toBeVisible();
  await page.getByLabel('Invoice number').fill(invoiceNumber);
  await page.getByLabel('Service', { exact: true }).click();
  await page.getByRole('option').first().click();
  await page.getByLabel('Choose the invoice document').setInputFiles(FIXTURE);
  await page.getByRole('button', { name: 'Create invoice' }).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Invoice ${invoiceNumber}`);
  const invoiceUrl = page.url();
  await expect(detail(page, 'Due date')).toContainText('PO terms');
  const card = page.getByRole('region', { name: 'Invoice document' });
  await expect(card.getByText('Ready to review')).toBeVisible({ timeout: 30_000 });
  await card.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByRole('heading', { name: 'Review globex-invoice.pdf' })).toBeVisible();
  const reviewUrl = page.url();
  await expect(page.getByText(/The document is billed to Globex Ltd/)).toBeVisible();
  await expect(page.getByText(/The invoice quotes PO 4500098765/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm without changes' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page).toHaveURL(invoiceUrl);

  // Mark paid: the PO is now fully invoiced and paid.
  await page.getByRole('button', { name: 'Mark paid' }).click();
  const paid = page.getByRole('dialog', { name: /Mark invoice .* paid/ });
  await paid.getByLabel('Payment reference (optional)').fill('NEFT E2E');
  await paid.getByRole('button', { name: 'Mark paid' }).click();
  await expect(page.getByText('Invoice marked paid')).toBeVisible();
  await expect(detail(page, 'Payment reference')).toHaveText('NEFT E2E');
  await page.goto(poUrl);
  await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
  const section = page.getByRole('region', { name: 'Invoices' });
  await expect(section.getByRole('row', { name: new RegExp(invoiceNumber) })).toContainText('Paid');
  await signOut(page);

  // A second PM gets not-found pages for the invoice and its document's review.
  await signIn(page, pm2.email, pm2.password);
  await page.goto(invoiceUrl);
  await expect(page.getByText('This page could not be found')).toBeVisible();
  await page.goto(reviewUrl);
  await expect(page.getByText('This page could not be found')).toBeVisible();
  await signOut(page);

  // The PO's Delete explains that its invoices go first.
  await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await page.goto(poUrl);
  await page.getByRole('button', { name: `Actions for PO ${SEEDED_PO}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Delete its invoices first');
  await expect(dialog.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
});
