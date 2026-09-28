import { describe, expect, it } from 'vitest';
import { can } from '../../rbac/can.ts';
import type { Action, Resource } from '../../rbac/types.ts';
import { actor } from '../helpers.ts';

const admin = actor('ADMIN');
const sales = actor('SALES');
const pm = actor('PROJECT_MANAGER');
const other = 'someone-else';

type Row = [name: string, user: typeof admin, action: Action, resource: Resource, allowed: boolean];

// AC1 — the PLAN.md "done when" test, on an enquiry-shaped object (Enquiry model arrives in M4).
describe('AC1: sales vs another user’s enquiry', () => {
  const own = { type: 'enquiry', ownerId: sales.id, projectManagerIds: [] } as const;
  const theirs = { type: 'enquiry', ownerId: other, projectManagerIds: [] } as const;

  it.each(['read', 'update', 'delete'] as const)('cannot %s another user’s enquiry', (action) => {
    expect(can(sales, action, theirs)).toBe(false);
  });

  it.each(['read', 'update', 'delete'] as const)('can %s their own enquiry', (action) => {
    expect(can(sales, action, own)).toBe(true);
  });
});

// AC2 — every PLAN.md role-table row has an allow and a deny case.
describe('AC2: PLAN.md role table', () => {
  const rows: Row[] = [
    // Users, masters, settings
    ['admin manages users', admin, 'update', { type: 'user', id: other }, true],
    ['sales reads own user record', sales, 'read', { type: 'user', id: sales.id }, true],
    ['sales cannot read another user', sales, 'read', { type: 'user', id: other }, false],
    ['sales cannot list users', sales, 'list', 'user', false],
    ['pm cannot update own user record', pm, 'update', { type: 'user', id: pm.id }, false],
    ['sales reads masters (Decision 2)', sales, 'list', 'master', true],
    // Clients (M3 Decision 11): everyone reads, Sales and admins create, only admins change.
    ['sales creates clients', sales, 'create', 'client', true],
    ['sales lists clients', sales, 'list', 'client', true],
    ['sales cannot update clients', sales, 'update', 'client', false],
    ['sales cannot delete clients', sales, 'delete', 'client', false],
    ['pm reads clients', pm, 'read', 'client', true],
    ['pm cannot create clients', pm, 'create', 'client', false],
    ['admin updates clients', admin, 'update', 'client', true],
    ['sales cannot create sectors or services', sales, 'create', 'master', false],
    ['sales cannot create masters', sales, 'create', 'master', false],
    ['pm reads settings (Decision 2)', pm, 'read', 'settings', true],
    ['pm cannot update settings', pm, 'update', 'settings', false],
    ['admin updates settings', admin, 'update', 'settings', true],

    // Enquiries, quotations
    ['sales creates enquiries', sales, 'create', 'enquiry', true],
    [
      'sales cannot create an enquiry owned by someone else',
      sales,
      'create',
      { type: 'enquiry', ownerId: other, projectManagerIds: [] },
      false,
    ],
    ['pm cannot create quotations', pm, 'create', 'quotation', false],
    [
      'pm reads a quotation on their project',
      pm,
      'read',
      { type: 'quotation', ownerId: other, projectManagerIds: [pm.id] },
      true,
    ],
    [
      'pm cannot read a quotation on another project',
      pm,
      'read',
      { type: 'quotation', ownerId: other, projectManagerIds: [other] },
      false,
    ],
    [
      'pm cannot update a quotation even on their project',
      pm,
      'update',
      { type: 'quotation', ownerId: other, projectManagerIds: [pm.id] },
      false,
    ],
    [
      'admin reads any enquiry',
      admin,
      'read',
      { type: 'enquiry', ownerId: other, projectManagerIds: [] },
      true,
    ],

    // Projects (Decisions 1 and 3)
    ['sales creates projects', sales, 'create', 'project', true],
    [
      'sales reads a project from their quotation',
      sales,
      'read',
      { type: 'project', managerId: pm.id, quotationOwnerId: sales.id },
      true,
    ],
    [
      'sales cannot read another rep’s project',
      sales,
      'read',
      { type: 'project', managerId: pm.id, quotationOwnerId: other },
      false,
    ],
    [
      'sales cannot update projects',
      sales,
      'update',
      { type: 'project', managerId: pm.id, quotationOwnerId: sales.id },
      false,
    ],
    [
      'pm updates an assigned project',
      pm,
      'update',
      { type: 'project', managerId: pm.id, quotationOwnerId: other },
      true,
    ],
    [
      'pm cannot read an unassigned project',
      pm,
      'read',
      { type: 'project', managerId: other, quotationOwnerId: other },
      false,
    ],
    ['pm cannot create projects', pm, 'create', 'project', false],
    [
      'pm cannot delete an assigned project',
      pm,
      'delete',
      { type: 'project', managerId: pm.id, quotationOwnerId: other },
      false,
    ],

    // POs, invoices
    [
      'sales updates a PO in their pipeline',
      sales,
      'update',
      { type: 'purchaseOrder', projectManagerId: pm.id, pipelineOwnerId: sales.id },
      true,
    ],
    [
      'sales cannot read a PO outside their pipeline',
      sales,
      'read',
      { type: 'purchaseOrder', projectManagerId: pm.id, pipelineOwnerId: other },
      false,
    ],
    [
      'pm deletes an invoice on an assigned project',
      pm,
      'delete',
      { type: 'invoice', projectManagerId: pm.id, pipelineOwnerId: other },
      true,
    ],
    [
      'pm cannot read an invoice on another project',
      pm,
      'read',
      { type: 'invoice', projectManagerId: other, pipelineOwnerId: other },
      false,
    ],

    // Follow-ups (M5 Decision 4): read follows the linked record; edits are the author's.
    [
      'sales updates own follow-up',
      sales,
      'update',
      { type: 'followUp', userId: sales.id, canReadLinked: true },
      true,
    ],
    [
      'sales deletes own follow-up after losing access to the record',
      sales,
      'delete',
      { type: 'followUp', userId: sales.id, canReadLinked: false },
      true,
    ],
    [
      'sales reads another user’s follow-up on a record they can read',
      sales,
      'read',
      { type: 'followUp', userId: other, canReadLinked: true },
      true,
    ],
    [
      'sales cannot update another user’s follow-up on their record',
      sales,
      'update',
      { type: 'followUp', userId: other, canReadLinked: true },
      false,
    ],
    [
      'sales cannot delete another user’s follow-up on their record',
      sales,
      'delete',
      { type: 'followUp', userId: other, canReadLinked: true },
      false,
    ],
    [
      'pm cannot read another user’s follow-up on a record they cannot read',
      pm,
      'read',
      { type: 'followUp', userId: other, canReadLinked: false },
      false,
    ],
    [
      'pm reads own follow-up',
      pm,
      'read',
      { type: 'followUp', userId: pm.id, canReadLinked: false },
      true,
    ],
    [
      'sales logs a follow-up on a record they can read',
      sales,
      'create',
      { type: 'followUp', userId: sales.id, canReadLinked: true },
      true,
    ],
    [
      'sales cannot log a follow-up on a record they cannot read',
      sales,
      'create',
      { type: 'followUp', userId: sales.id, canReadLinked: false },
      false,
    ],
    [
      'sales cannot log a follow-up as someone else',
      sales,
      'create',
      { type: 'followUp', userId: other, canReadLinked: true },
      false,
    ],
    ['pm may list follow-ups (rows are scoped)', pm, 'list', 'followUp', true],
    [
      'admin reads any follow-up',
      admin,
      'read',
      { type: 'followUp', userId: other, canReadLinked: false },
      true,
    ],
    [
      'admin updates any follow-up',
      admin,
      'update',
      { type: 'followUp', userId: other, canReadLinked: false },
      true,
    ],

    // Audit log
    ['sales reads own audit rows', sales, 'read', { type: 'auditLog', actorId: sales.id }, true],
    [
      'sales cannot read others’ audit rows',
      sales,
      'read',
      { type: 'auditLog', actorId: other },
      false,
    ],
    ['admin reads all audit rows', admin, 'read', { type: 'auditLog', actorId: other }, true],

    // Dashboards
    ['admin sees company dashboard', admin, 'read', { type: 'dashboard', scope: 'company' }, true],
    [
      'sales sees personal dashboard',
      sales,
      'read',
      { type: 'dashboard', scope: 'personal' },
      true,
    ],
    [
      'sales cannot see company dashboard',
      sales,
      'read',
      { type: 'dashboard', scope: 'company' },
      false,
    ],
    ['pm sees project dashboard', pm, 'read', { type: 'dashboard', scope: 'project' }, true],
    [
      'pm cannot see personal dashboard',
      pm,
      'read',
      { type: 'dashboard', scope: 'personal' },
      false,
    ],

    // My Today (M11 Decision 6)
    ['sales reads own My Today', sales, 'read', { type: 'myToday', userId: sales.id }, true],
    ['pm reads own My Today', pm, 'read', { type: 'myToday', userId: pm.id }, true],
    ['sales cannot read another’s My Today', sales, 'read', { type: 'myToday', userId: other }, false],
    ['pm cannot read another’s My Today', pm, 'read', { type: 'myToday', userId: other }, false],
    ['admin reads anyone’s My Today', admin, 'read', { type: 'myToday', userId: other }, true],
    ['My Today is read-only', sales, 'update', { type: 'myToday', userId: sales.id }, false],
    ['no type-level My Today read', sales, 'read', 'myToday', false],

    // MCP tokens
    ['admin issues API tokens', admin, 'create', 'apiToken', true],
    ['sales cannot issue API tokens', sales, 'create', 'apiToken', false],
    ['pm cannot list API tokens', pm, 'list', 'apiToken', false],

    // Type-level read/update/delete need an instance for non-admins.
    ['sales cannot read the enquiry type without an instance', sales, 'read', 'enquiry', false],
  ];

  it.each(rows)('%s', (_name, user, action, resource, allowed) => {
    expect(can(user, action, resource)).toBe(allowed);
  });
});

describe('AC3: inactive users are denied everything', () => {
  const cases: [typeof admin, Action, Resource][] = [
    [actor('ADMIN', { active: false }), 'read', 'settings'],
    [actor('ADMIN', { active: false }), 'list', 'user'],
    [
      actor('SALES', { active: false }),
      'read',
      { type: 'enquiry', ownerId: 'sales-1', projectManagerIds: [] },
    ],
    [actor('PROJECT_MANAGER', { active: false }), 'read', 'master'],
  ];

  it.each(cases)('%o cannot %s %o', (user, action, resource) => {
    expect(can(user, action, resource)).toBe(false);
  });
});

describe('AC4: audit rows are immutable, even for admins', () => {
  it.each([
    ['update', { type: 'auditLog', actorId: admin.id }],
    ['delete', { type: 'auditLog', actorId: admin.id }],
    ['create', 'auditLog'],
  ] as const)('admin cannot %s audit rows', (action, resource) => {
    expect(can(admin, action, resource)).toBe(false);
  });
});

// M7 Decision 4: a document's permissions are its record's.
describe('documents follow their record', () => {
  const doc = (canReadParent: boolean, canUpdateParent: boolean) =>
    ({ type: 'document', canReadParent, canUpdateParent }) as const;

  it.each([
    ['reads with read on the record', sales, 'read', doc(true, false), true],
    ['cannot read without it', sales, 'read', doc(false, false), false],
    ['uploads with update on the record', sales, 'create', doc(true, true), true],
    ['cannot upload with read only', pm, 'create', doc(true, false), false],
    ['confirms with update on the record', sales, 'update', doc(true, true), true],
    ['cannot confirm with read only', pm, 'update', doc(true, false), false],
    ['deletes with update on the record', sales, 'delete', doc(true, true), true],
    ['cannot delete with read only', sales, 'delete', doc(true, false), false],
    ['type-level create passes (record checked later)', pm, 'create', 'document', true],
    ['type-level list passes (scoped later)', sales, 'list', 'document', true],
    ['type-level update needs a record', sales, 'update', 'document', false],
    ['admins do everything', admin, 'delete', doc(false, false), true],
  ] as const)('%s', (_name, user, action, resource, allowed) => {
    expect(can(user, action, resource)).toBe(allowed);
  });
});
