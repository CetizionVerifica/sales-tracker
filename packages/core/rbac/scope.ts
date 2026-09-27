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
