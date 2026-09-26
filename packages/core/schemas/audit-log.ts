import { z } from 'zod';
import { paginationSchema } from './common.ts';

export const listAuditLogSchema = paginationSchema.extend({
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type ListAuditLogInput = z.input<typeof listAuditLogSchema>;

export const auditEntryIdSchema = z.uuid();
