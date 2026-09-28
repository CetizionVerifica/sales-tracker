import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { choose, istDay, mainNav, signIn, signOut } from './helpers.ts';
import { E2E_USERS } from './users.ts';

// M11 My today, on the dev seed (system/seed-enquiries.ts). Relies on seeded records the
// other specs do not touch: sales2's negotiating quotation with a missed follow-up
// ("Client asked for revised payment terms"), the overdue invoice INV/26-27/0003 and the
// invoice due in 3 days, INV/26-27/0004, both on the dev PM's projects.

const FIXTURE = fileURLToPath(
  new URL('../../../packages/core/test/fixtures/documents/globex-invoice.pdf', import.meta.url),
);

const section = (page: Page, name: 'Overdue' | 'Due today' | 'Coming up') =>
  page.getByRole('region', { name: new RegExp(`^${name}`) });

/** The My today badge in the sidebar: "N due". */
async function badgeCount(page: Page): Promise<number> {
  const badge = mainNav(page).getByLabel(/^\d+ due$/);
  if ((await badge.count()) === 0) return 0;
  return Number(await badge.textContent());
}

// AC12: a Sales user lands on My today, logs a follow-up on a missed quotation follow-up,
// and the row moves from Overdue to Coming up.
test('sales: sign in to My today, log a follow-up, the row moves to Coming up', async ({
  page,
}) => {
  await signIn(page, E2E_USERS.sales2.email, E2E_USERS.sales2.password);
  await expect(page.getByRole('heading', { level: 1, name: 'My today' })).toBeVisible();
  const before = await badgeCount(page);
  expect(before).toBeGreaterThan(0);

  const row = section(page, 'Overdue')
    .getByRole('listitem')
    .filter({ hasText: 'Client asked for revised payment terms' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Log follow-up' }).click();
  const sheet = page.getByRole('dialog', { name: 'Log follow-up' });
  await choose(page, 'Channel', 'Call', sheet);
  await sheet.getByLabel('Notes').fill('Sent revised terms; call next week');
  await sheet.getByLabel('Next follow-up').fill(istDay(5));
  await sheet.getByRole('button', { name: 'Log follow-up' }).click();
  await expect(page.getByText('Follow-up logged')).toBeVisible();

  await expect(
    section(page, 'Overdue').getByText('Client asked for revised payment terms'),
  ).toHaveCount(0);
  await expect(
    section(page, 'Coming up').getByRole('listitem').filter({ hasText: 'Sent revised terms' }),
  ).toBeVisible();
  await expect.poll(() => badgeCount(page)).toBe(before - 1);
});

// AC13: a PM marks an overdue invoice paid from My today, then reviews a document from it.
test('pm: mark an overdue invoice paid, then open a document to review', async ({ page }) => {
  test.slow(); // the worker reads the uploaded file
  await signIn(page, E2E_USERS.pm.email, E2E_USERS.pm.password);
  const before = await badgeCount(page);

  const invoice = section(page, 'Overdue')
    .getByRole('listitem')
    .filter({ hasText: 'INV/26-27/0003' });
  await expect(invoice).toContainText('Chase payment');
  await invoice.getByRole('button', { name: 'Mark paid' }).click();
  const paid = page.getByRole('dialog', { name: /Mark invoice .* paid/ });
  await paid.getByRole('button', { name: 'Mark paid' }).click();
  await expect(page.getByText('Invoice marked paid')).toBeVisible();
  await expect(section(page, 'Overdue').getByText('INV/26-27/0003')).toHaveCount(0);
  await expect.poll(() => badgeCount(page)).toBe(before - 1);

  // Upload a document on the invoice due in 3 days; once read, it is due for review today.
  await section(page, 'Coming up')
    .getByRole('listitem')
    .filter({ hasText: 'INV/26-27/0004' })
    .getByRole('link', { name: /^Open / })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Invoice INV/26-27/0004');
  await page.getByLabel('Choose a document').setInputFiles(FIXTURE);
  const card = page.getByRole('region', { name: 'Invoice document' });
  await expect(card.getByText('Ready to review')).toBeVisible({ timeout: 30_000 });

  await mainNav(page)
    .getByRole('link', { name: /My today/ })
    .click();
  const review = section(page, 'Due today')
    .getByRole('listitem')
    .filter({ hasText: 'Review extracted fields' })
    .filter({ hasText: 'INV/26-27/0004' });
  await review.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByRole('heading', { name: 'Review globex-invoice.pdf' })).toBeVisible();
});

// AC14: an admin views a Sales user's list, read-only.
test('admin: view a Sales user’s My today with Open as the only action', async ({ page }) => {
  await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await choose(page, 'Viewing', 'Sam Sales');
  await expect(page).toHaveURL(/\/today\?user=/);
  await expect(page.getByText(/Sam Sales, read-only/)).toBeVisible();

  const rows = page
    .getByRole('region', { name: /^(Overdue|Due today|Coming up)/ })
    .getByRole('listitem');
  await expect(rows.first()).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: 'Log follow-up' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('main').getByRole('button', { name: 'Mark paid' })).toHaveCount(0);
  await expect(rows.first().getByRole('link', { name: /^Open / })).toBeVisible();

  await choose(page, 'Viewing', 'Me');
  await expect(page).toHaveURL(/\/today$/);
  await signOut(page);
});
