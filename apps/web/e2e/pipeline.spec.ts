import { expect, test } from '@playwright/test';
import { choose, convertedEnquiry, createQuotation, istDay, signIn } from './helpers.ts';
import { E2E_USERS } from './users.ts';

// AC14 (CLAUDE.md): one flow through the whole pipeline — enquiry → quotation → project → PO
// → invoice → paid — ending with every pipeline-strip stage filled and linked.
test('pipeline: enquiry → quotation → project → PO → invoice → paid', async ({ page }) => {
  test.slow();
  const stamp = Date.now();
  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);

  const enquiryUrl = await convertedEnquiry(page, `Pipeline Co ${stamp}`);
  await createQuotation(page, '2,00,000', istDay(7));
  const quotationUrl = page.url();
  await page.getByRole('button', { name: 'PO received' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'PO received' }).click();

  await page.getByRole('link', { name: 'Create project' }).click();
  await page.getByLabel('Name').fill('Pipeline project');
  await choose(page, 'Project manager', 'Priya PM');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^PRJ-/);
  const projectUrl = page.url();

  await page.getByRole('link', { name: 'Add PO' }).click();
  await page.getByLabel('PO number').fill(`PIPE-${stamp}`);
  await page.getByLabel('Net days (optional)').fill('30');
  await page.getByRole('button', { name: 'Create purchase order' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`PO PIPE-${stamp}`);
  const poUrl = page.url();

  await page.getByRole('link', { name: 'Add invoice' }).click();
  await expect(page.getByTestId('due-hint')).toHaveText(`Net 30 from PO PIPE-${stamp}`);
  await page.getByLabel('Invoice number').fill(`INV/PIPE/${stamp}`);
  await page.getByLabel('Service', { exact: true }).click();
  await page.getByRole('option', { name: 'Inspection' }).click();
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Invoice INV/PIPE/${stamp}`);
  const invoiceUrl = page.url();

  await page.getByRole('button', { name: 'Mark paid' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark paid' }).click();
  await expect(page.getByText('Invoice marked paid')).toBeVisible();

  // Every stage is reached: from the invoice, the four before it link to their records
  // (the current stage is not a link); from the enquiry, the four after it do.
  const strip = page.getByRole('navigation', { name: 'Pipeline' });
  const links: [string, string][] = [
    ['Enquiry', enquiryUrl],
    ['Quotation', quotationUrl],
    ['Project', projectUrl],
    ['PO', poUrl],
    ['Invoice', invoiceUrl],
  ];
  const expectLinks = async (stages: [string, string][]) => {
    for (const [stage, url] of stages) {
      await expect(strip.getByRole('link', { name: stage, exact: true })).toHaveAttribute(
        'href',
        new URL(url).pathname,
      );
    }
  };
  await expect(strip.locator('[aria-current="step"]')).toHaveText('Invoice');
  await expectLinks(links.slice(0, 4));
  await page.goto(enquiryUrl);
  await expectLinks(links.slice(1));
  // The PO is fully invoiced and paid.
  await page.goto(poUrl);
  await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
});
