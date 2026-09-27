import type { Prisma } from '@sales-tracker/db';
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

/**
 * Admins see every enquiry; Sales see their own. Project managers see enquiries linked to
 * projects they manage — none exist until M8, so for now they see nothing.
 * TODO(M8): match enquiries whose quotations' projects have managerId = user.id.
 */
export function scopeEnquiries(user: Actor): Prisma.EnquiryWhereInput {
  if (user.role === 'ADMIN') return {};
  if (user.role === 'SALES') return { ownerId: user.id };
  return { id: { in: [] } };
}

/**
 * The can() instance for an enquiry row. projectManagerIds is empty until M8 adds
 * projects (M1 spec); this is the one place that changes then.
 */
export function enquiryResource(row: { ownerId: string }) {
  return { type: 'enquiry' as const, ownerId: row.ownerId, projectManagerIds: [] as string[] };
}

/**
 * Admins see every quotation; Sales see their own. Project managers see quotations on
 * projects they manage — none exist until M8, so for now they see nothing.
 * TODO(M8): match quotations whose project has managerId = user.id.
 */
export function scopeQuotations(user: Actor): Prisma.QuotationWhereInput {
  if (user.role === 'ADMIN') return {};
  if (user.role === 'SALES') return { ownerId: user.id };
  return { id: { in: [] } };
}

/**
 * The can() instance for a quotation row. projectManagerIds is empty until M8 adds
 * projects; this is the one place that changes then.
 */
export function quotationResource(row: { ownerId: string }) {
  return { type: 'quotation' as const, ownerId: row.ownerId, projectManagerIds: [] as string[] };
}

/**
 * Follow-ups the user may see (M5 Decision 4): their own, client-level ones (everyone reads
 * clients), and those on records they can read. The polymorphic `entityId` has no relation
 * to join on, so the caller resolves the readable record ids per type first
 * (follow-up-targets.ts) and passes them in.
 */
export function scopeFollowUps(
  user: Actor,
  visible: { ENQUIRY: readonly string[]; QUOTATION: readonly string[] },
): Prisma.FollowUpWhereInput {
  if (user.role === 'ADMIN') return {};
  return {
    OR: [
      { userId: user.id },
      { entityType: 'CLIENT' },
      { entityType: 'ENQUIRY', entityId: { in: [...visible.ENQUIRY] } },
      { entityType: 'QUOTATION', entityId: { in: [...visible.QUOTATION] } },
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
