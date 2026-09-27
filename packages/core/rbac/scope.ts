import type { Prisma } from '@sales-tracker/db';
import type { FollowUpEntityTypeValue as FollowUpEntityType } from '../schemas/follow-up.ts';
import type { Actor } from './types.ts';

/**
 * Row filters for type-level `list` checks: can() answers "may this role list the type?",
 * scopeWhere answers "which rows?". Each entity module adds its entry (auditLog in M2,
 * enquiry in M4, ...).
 */
export function scopeUsers(user: Actor): Prisma.UserWhereInput {
  // The system actor is never listed (M1 Decision 5).
  return user.role === 'ADMIN' ? { isSystem: false } : { id: user.id, isSystem: false };
}

/** Admins see every audit row; everyone else sees only the changes they made (PLAN.md). */
export function scopeAuditLog(user: Actor): Prisma.AuditLogWhereInput {
  return user.role === 'ADMIN' ? {} : { actorId: user.id };
}

// ─── Project managers' reach (M8) ─────────────────────────────────────────────────
//
// A PM reads the enquiry and quotation behind each live project they manage (M1 policy:
// `projectManagerIds`). Relation filters are not soft-delete filtered by the extension, so
// the live-project condition is spelled out here.

const liveProjectOf = (userId: string) => ({ managerId: userId, deletedAt: null });

/** Selects the managers of a quotation's live projects, for quotationResource. */
export const quotationManagersSelect = {
  projects: { where: { deletedAt: null }, select: { managerId: true } },
} satisfies Prisma.QuotationSelect;

/** Selects the managers of live projects under an enquiry's quotations, for enquiryResource. */
export const enquiryManagersSelect = {
  quotations: { select: quotationManagersSelect },
} satisfies Prisma.EnquirySelect;

type ManagedProjects = { projects: readonly { managerId: string | null }[] };

function managerIds(projects: ManagedProjects['projects']): string[] {
  return projects.flatMap((p) => (p.managerId ? [p.managerId] : []));
}

/**
 * Admins see every enquiry; Sales see their own; project managers see enquiries behind the
 * live projects they manage (M8).
 */
export function scopeEnquiries(user: Actor): Prisma.EnquiryWhereInput {
  if (user.role === 'ADMIN') return {};
  if (user.role === 'SALES') return { ownerId: user.id };
  return { quotations: { some: { projects: { some: liveProjectOf(user.id) } } } };
}

/**
 * The can() instance for an enquiry row. Load the row with `enquiryManagersSelect`, so PMs
 * of its live projects can read it.
 */
export function enquiryResource(row: { ownerId: string; quotations: readonly ManagedProjects[] }) {
  return {
    type: 'enquiry' as const,
    ownerId: row.ownerId,
    projectManagerIds: row.quotations.flatMap((q) => managerIds(q.projects)),
  };
}

/**
 * Admins see every quotation; Sales see their own; project managers see quotations whose
 * live project they manage (M8).
 */
export function scopeQuotations(user: Actor): Prisma.QuotationWhereInput {
  if (user.role === 'ADMIN') return {};
  if (user.role === 'SALES') return { ownerId: user.id };
  return { projects: { some: liveProjectOf(user.id) } };
}

/**
 * The can() instance for a quotation row. Load the row with `quotationManagersSelect`, so
 * the PM of its live project can read it.
 */
export function quotationResource(row: { ownerId: string } & ManagedProjects) {
  return {
    type: 'quotation' as const,
    ownerId: row.ownerId,
    projectManagerIds: managerIds(row.projects),
  };
}

/**
 * Admins see every project; Sales see projects on quotations they currently own (M1
 * Decision 3, M8 Decision 4); project managers see the ones assigned to them (the M8
 * "done when").
 */
export function scopeProjects(user: Actor): Prisma.ProjectWhereInput {
  if (user.role === 'ADMIN') return {};
  if (user.role === 'SALES') return { quotation: { ownerId: user.id } };
  return { managerId: user.id };
}

/** Selects what projectResource needs. */
export const projectAccessSelect = {
  managerId: true,
  quotation: { select: { ownerId: true } },
} satisfies Prisma.ProjectSelect;

/**
 * The can() instance for a project. `quotationOwnerId` is read through the quotation, not
 * stored, so reassigning the quotation moves the project with it (M8 Decision 4).
 */
export function projectResource(row: { managerId: string | null; quotation: { ownerId: string } }) {
  return {
    type: 'project' as const,
    managerId: row.managerId,
    quotationOwnerId: row.quotation.ownerId,
  };
}

/**
 * Follow-ups the user may see (M5 Decision 4): their own, client-level ones (everyone reads
 * clients), and those on records they can read. The polymorphic `entityId` has no relation
 * to join on, so the caller resolves the readable record ids per type first
 * (follow-up-targets.ts) and passes them in.
 */
export function scopeFollowUps(
  user: Actor,
  visible: Partial<Record<Exclude<FollowUpEntityType, 'CLIENT'>, readonly string[]>>,
): Prisma.FollowUpWhereInput {
  if (user.role === 'ADMIN') return {};
  return {
    OR: [
      { userId: user.id },
      { entityType: 'CLIENT' },
      ...Object.entries(visible).map(([entityType, ids]) => ({
        entityType: entityType as FollowUpEntityType,
        entityId: { in: [...(ids ?? [])] },
      })),
    ],
  };
}

/** The can() instance for a follow-up row. */
export function followUpResource(row: { userId: string }, canReadLinked: boolean) {
  return { type: 'followUp' as const, userId: row.userId, canReadLinked };
}

/**
 * Documents the user may see (M7): those on records they can read. Like follow-ups, the
 * polymorphic `entityId` has no relation to join on, so the caller resolves the readable
 * record ids per kind (extraction/kinds.ts) and passes them in.
 */
export function scopeDocuments(
  user: Actor,
  visible: Partial<Record<'QUOTATION' | 'PURCHASE_ORDER' | 'INVOICE', readonly string[]>>,
): Prisma.DocumentWhereInput {
  if (user.role === 'ADMIN') return {};
  return {
    OR: Object.entries(visible).map(([kind, ids]) => ({
      kind: kind as 'QUOTATION' | 'PURCHASE_ORDER' | 'INVOICE',
      entityId: { in: [...(ids ?? [])] },
    })),
  };
}

/** The can() instance for a document, from what the actor may do on its record. */
export function documentResource(canReadParent: boolean, canUpdateParent: boolean) {
  return { type: 'document' as const, canReadParent, canUpdateParent };
}
