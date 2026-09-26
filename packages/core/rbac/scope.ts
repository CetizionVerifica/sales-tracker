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
