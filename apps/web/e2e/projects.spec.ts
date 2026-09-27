import { expect, test, type Page } from '@playwright/test';
import {
  choose,
  convertedEnquiry,
  createQuotation,
  detail,
  istDay,
  mainNav,
  signIn,
  signOut,
} from './helpers.ts';
import { E2E_USERS } from './users.ts';

const PROJECT_TITLE = /^PRJ-\d{4}-\d{4,} · /;

/** As the signed-in rep: a quotation with a PO received; returns its number and URL. */
async function wonQuotation(page: Page, client: string) {
  await convertedEnquiry(page, client);
  const number = await createQuotation(page, '1,25,000.50', istDay(7));
  await page.getByRole('button', { name: 'PO received' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'PO received' }).click();
  await expect(page.getByRole('link', { name: 'Create project' })).toBeVisible();
  return { number, url: page.url() };
}

/** From a PO_RECEIVED quotation's page: creates the project for the dev PM; returns its URL. */
async function createProject(page: Page, name: string, manager = 'Priya PM') {
  await page.getByRole('link', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'New project' })).toBeVisible();
  await page.getByLabel('Name').fill(name);
  await choose(page, 'Project manager', manager);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(PROJECT_TITLE);
  return page.url();
}

/** Opens a status dialog from the page header and submits it. */
async function move(page: Page, action: string, fill?: { label: string; value: string }) {
  await page.getByRole('button', { name: action, exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (fill) await dialog.getByLabel(fill.label).fill(fill.value);
  await dialog.getByRole('button', { name: action, exact: true }).click();
  await expect(dialog).toBeHidden();
}

// AC15: Sales creates the project from the won quotation; the PM runs it to completion.
test('project: create from a PO received → PM starts, updates, holds, resumes, completes', async ({
  page,
}) => {
  const client = `Project Co ${Date.now()}`;
  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  const { url: quotationUrl } = await wonQuotation(page, client);

  // Pre-filled from the quotation's draft.
  await page.getByRole('link', { name: 'Create project' }).click();
  await expect(page.getByTestId('project-client')).toHaveText(client);
  await expect(page.getByLabel('Inspection')).toBeChecked();
  await expect(page.getByLabel('Audit')).toBeChecked();
  await expect(page.getByLabel('Revenue')).toHaveValue('125000.50');
  await page.goBack();
  const projectUrl = await createProject(page, 'Kiln line inspection');
  const title = (await page.getByRole('heading', { level: 1 }).textContent())!.trim();
  const projectNumber = title.split(' · ')[0]!;
  await expect(page.getByText('Not started', { exact: true })).toBeVisible();
  await expect(detail(page, 'Project manager')).toContainText('Priya PM');

  // The quotation now links to its project instead of offering a new one.
  await page.goto(quotationUrl);
  await expect(page.getByRole('link', { name: 'Create project' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: projectNumber }).first()).toBeVisible();
  await signOut(page);

  // The PM finds it under Projects and runs it.
  await signIn(page, E2E_USERS.pm.email, E2E_USERS.pm.password);
  await mainNav(page).getByRole('link', { name: 'Projects' }).click();
  await page.getByLabel('Search', { exact: true }).fill(projectNumber);
  await page.getByLabel('Search', { exact: true }).press('Enter');
  await page.getByRole('link', { name: projectNumber }).click();
  await expect(page).toHaveURL(projectUrl);

  await move(page, 'Start project');
  await expect(page.getByText('In progress', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Update progress' }).click();
  await page.getByLabel('Completion %').fill('40');
  await page.getByRole('dialog').getByRole('button', { name: 'Update progress' }).click();
  await expect(page.getByRole('progressbar', { name: 'Completion' }).first()).toHaveAttribute(
    'aria-valuenow',
    '40',
  );

  await page.getByRole('button', { name: 'Put on hold', exact: true }).click();
  const hold = page.getByRole('dialog');
  await hold.getByRole('button', { name: 'Put on hold', exact: true }).click();
  await expect(hold.getByText('Say why the project is on hold')).toBeVisible();
  await hold.getByLabel('Why is it on hold?').fill('Client site closed for audit');
  await hold.getByRole('button', { name: 'Put on hold', exact: true }).click();
  await expect(detail(page, 'On hold because')).toHaveText('Client site closed for audit');

  await move(page, 'Resume');
  await move(page, 'Mark completed');
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Put on hold' })).toHaveCount(0);

  // The list shows it completed at 100%; the timeline shows each move.
  await page.goto(`/projects?q=${projectNumber}`);
  const row = page.getByRole('row', { name: new RegExp(projectNumber) });
  await expect(row).toContainText('Completed');
  await expect(row).toContainText('100%');
  await page.goto(`${projectUrl}?tab=timeline`);
  await expect(page.getByText('Client site closed for audit')).toBeVisible();
  await expect(page.getByText(/from In progress to On hold/)).toBeVisible();
  await expect(page.getByText(/from On hold to In progress/)).toBeVisible();
  await expect(page.getByText(/from In progress to Completed/)).toBeVisible();
});

// AC16: another PM neither lists nor opens it (nor its quotation); the Sales owner sees it
// read-only; an admin reassigns it to the second PM, who then sees it.
test('project: PM scoping, read-only owner, admin reassignment', async ({ page }) => {
  const stamp = Date.now();
  const pm2 = {
    name: `Pat PM ${stamp}`,
    email: `pat.pm.${stamp}@example.test`,
    password: 'pat-pm-initial-pass',
  };

  // An admin adds a second project manager.
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

  await signIn(page, E2E_USERS.sales.email, E2E_USERS.sales.password);
  const { url: quotationUrl } = await wonQuotation(page, `Scoped Co ${stamp}`);
  const projectUrl = await createProject(page, 'Scoped audit');
  const projectNumber = (await page.getByRole('heading', { level: 1 }).textContent())!
    .trim()
    .split(' · ')[0]!;

  // The Sales owner reads it but cannot change it.
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start project' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Update progress' })).toHaveCount(0);
  await signOut(page);

  // The second PM sees nothing of it.
  await signIn(page, pm2.email, pm2.password);
  await page.goto('/projects');
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('link', { name: projectNumber })).toHaveCount(0);
  await page.goto(projectUrl);
  await expect(page.getByText('This page could not be found')).toBeVisible();
  await page.goto(quotationUrl);
  await expect(page.getByText('This page could not be found')).toBeVisible();
  await signOut(page);

  // An admin reassigns it.
  await signIn(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'Reassign' }).click();
  const reassign = page.getByRole('dialog');
  await choose(page, 'Project manager', pm2.name, reassign);
  await reassign.getByRole('button', { name: 'Reassign project' }).click();
  await expect(page.getByText('Project reassigned')).toBeVisible();
  await expect(detail(page, 'Project manager')).toContainText(pm2.name);
  await signOut(page);

  await signIn(page, pm2.email, pm2.password);
  await page.goto('/projects');
  await expect(page.getByRole('link', { name: projectNumber })).toBeVisible();
  await page.goto(quotationUrl);
  await expect(page.getByRole('link', { name: projectNumber }).first()).toBeVisible();
});
