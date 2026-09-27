import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { convertedEnquiry, createQuotation, detail, istDay, signIn, signOut } from './helpers.ts';
import { E2E_USERS } from './users.ts';

// The fixture's hash is registered with the mock extractor (mock-extractor.json): it reads
// Globex Ltd, ₹3,40,000.00 and a scope summary, so the review shows a client mismatch.
const FIXTURE = fileURLToPath(
  new URL('../../../packages/core/test/fixtures/documents/globex-quotation.pdf', import.meta.url),
);

// AC14: upload → extraction by the worker → review with a mismatch warning → correct the
// amount → confirm → the quotation and its timeline show it; the review is then read-only.
// AC15: another rep gets a not-found page at the review URL.
test('document: upload → read → review → confirm; other reps cannot see it', async ({ page }) => {
  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  await convertedEnquiry(page, `Docs Co ${Date.now()}`);
  await createQuotation(page, '1,25,000.50', istDay(7));
  const quotationUrl = page.url();

  await page.getByLabel('Choose a document').setInputFiles(FIXTURE);
  await expect(page.getByText('globex-quotation.pdf', { exact: true })).toBeVisible();
  // The card polls while the worker reads the file.
  await expect(page.getByText('Ready to review')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByRole('heading', { name: 'Review globex-quotation.pdf' })).toBeVisible();
  const reviewUrl = page.url();
  const fileUrl = reviewUrl.replace('/documents/', '/api/documents/').replace(/\/review$/, '/file');
  await expect(page.getByRole('alert').filter({ hasText: 'addressed to' })).toContainText(
    'Globex Ltd',
  );
  const amount = page.getByLabel('Amount from the document');
  await expect(amount).toHaveValue('340000.00');
  await expect(page.getByText('Now on QUO-')).toHaveCount(3); // one line per review field

  // Correct the amount; leave the date alone (it is before the enquiry arrived).
  await amount.fill('3,35,000.00');
  await page.getByRole('checkbox', { name: 'Apply quotation date' }).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Apply amount' })).toBeChecked();
  await page.getByRole('button', { name: 'Confirm and save' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('₹1,25,000.50 → ₹3,35,000.00');
  await dialog.getByRole('button', { name: 'Confirm and save' }).click();

  // Back on the quotation: the corrected amount, the review on the card and the timeline.
  await expect(page).toHaveURL(quotationUrl);
  await expect(detail(page, 'Amount')).toHaveText('₹3,35,000.00');
  await expect(detail(page, 'Scope and notes')).toHaveText('Third-party inspection of two boilers');
  await expect(page.getByText(/^Confirmed by /)).toBeVisible();
  await expect(page.getByText(/confirmed globex-quotation\.pdf on/)).toBeVisible();

  // The review URL is now read-only.
  await page.goto(reviewUrl);
  await expect(page.getByText(/^Confirmed by /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm and save' })).toHaveCount(0);

  // AC15: another rep cannot open the review page or the file.
  await page.goto(quotationUrl);
  await signOut(page);
  await signIn(page, E2E_USERS.sales2.email, E2E_USERS.sales2.password);
  await page.goto(reviewUrl);
  await expect(page.getByText('This page could not be found')).toBeVisible();
  expect((await page.request.get(fileUrl)).status()).toBe(404);
});
