import type { Prisma } from '@sales-tracker/db';
import type { Db } from '../../clients.ts';
import type { Ctx } from '../../context.ts';
import { assertCan } from '../../context.ts';
import { ForbiddenError, NotFoundError } from '../../errors.ts';
import { scopeEnquiries, scopeInvoices, scopeProjects, scopeQuotations } from '../../rbac/scope.ts';
import type { Actor } from '../../rbac/types.ts';
import type { DashboardScope, DashboardScopeKind } from '../../schemas/dashboard.ts';

/*
 * Whose numbers the dashboard shows (M12 Decision 4), and the row filters that go with it.
 * Every filter ANDs the viewer's own scope function, so a panel never counts a record the
 * viewer cannot read; the owner or manager filter then narrows it.
 */

export interface ResolvedScope extends DashboardScope {
  viewer: Actor;
  /** Pipeline panels by quotation owner (personal scope). */
  ownerId: string | null;
  /** Project panels by project manager (project scope). */
  managerId: string | null;
}

const liveClient = { client: { deletedAt: null } };

/**
 * Sales: their own pipeline, and no owner or manager filter. PMs: their projects. Admins:
 * the company, or one Sales user (`ownerId`) or one PM (`managerId`).
 */
export async function resolveScope(
  db: Db,
  ctx: Ctx,
  input: { ownerId?: string | undefined; managerId?: string | undefined },
): Promise<ResolvedScope> {
  const viewer = ctx.user;
  const picksSomeone = Boolean(input.ownerId || input.managerId);
  if (viewer.role !== 'ADMIN' && picksSomeone) {
    throw new ForbiddenError('read', 'dashboard');
  }

  let kind: DashboardScopeKind;
  let userId: string | null = null;
  if (viewer.role === 'SALES') {
    kind = 'personal';
    userId = viewer.id;
  } else if (viewer.role === 'PROJECT_MANAGER') {
    kind = 'project';
    userId = viewer.id;
  } else if (input.ownerId) {
    kind = 'personal';
    userId = input.ownerId;
  } else if (input.managerId) {
    kind = 'project';
    userId = input.managerId;
  } else {
    kind = 'company';
  }
  assertCan(ctx, 'read', { type: 'dashboard', scope: kind });

  let user: DashboardScope['user'] = null;
  if (userId) {
    // An admin's pick must be a Sales user (owner) or a PM (manager).
    const role = kind === 'personal' ? 'SALES' : 'PROJECT_MANAGER';
    const row = await db.user.findFirst({
      where: { id: userId, role, isSystem: false },
      select: { id: true, name: true },
    });
    if (!row) throw new NotFoundError('user');
    user = row;
  }
  return {
    kind,
    user,
    viewer,
    ownerId: kind === 'personal' ? userId : null,
    managerId: kind === 'project' ? userId : null,
  };
}

/** Live quotations (with live clients) in scope. `deletedAt` is explicit: used nested too. */
export function quotationsIn(s: ResolvedScope): Prisma.QuotationWhereInput {
  return {
    AND: [
      scopeQuotations(s.viewer),
      { deletedAt: null, ...liveClient },
      s.ownerId ? { ownerId: s.ownerId } : {},
    ],
  };
}

export function enquiriesIn(s: ResolvedScope): Prisma.EnquiryWhereInput {
  return {
    AND: [
      scopeEnquiries(s.viewer),
      { deletedAt: null, ...liveClient },
      s.ownerId ? { ownerId: s.ownerId } : {},
    ],
  };
}

/** Live invoices on live POs and projects, by pipeline owner or project manager. */
export function invoicesIn(s: ResolvedScope): Prisma.InvoiceWhereInput {
  return {
    AND: [
      scopeInvoices(s.viewer),
      {
        deletedAt: null,
        ...liveClient,
        purchaseOrder: { deletedAt: null, project: { deletedAt: null } },
      },
      s.ownerId ? { purchaseOrder: { project: { quotation: { ownerId: s.ownerId } } } } : {},
      s.managerId ? { purchaseOrder: { project: { managerId: s.managerId } } } : {},
    ],
  };
}

export function projectsIn(s: ResolvedScope): Prisma.ProjectWhereInput {
  return {
    AND: [
      scopeProjects(s.viewer),
      { deletedAt: null, ...liveClient },
      s.managerId ? { managerId: s.managerId } : {},
      s.ownerId ? { quotation: { ownerId: s.ownerId } } : {},
    ],
  };
}
