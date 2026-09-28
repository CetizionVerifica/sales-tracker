import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

export { PrismaClient };
export {
  AuditAction,
  AuditSource,
  DocumentKind,
  DocumentReviewStatus,
  EnquirySource,
  EnquiryStatus,
  ExtractionStatus,
  ProjectStatus,
  PurchaseOrderStatus,
  QuotationStatus,
  Role,
} from './generated/prisma/enums.ts';
export { Prisma } from './generated/prisma/client.ts';

/**
 * Creates a Prisma client for the given database. Only `packages/core` should call this;
 * apps go through core services (CLAUDE.md rule 1, enforced by lint).
 * The audit extension is layered on here in M2.
 */
export function createPrismaClient(databaseUrl: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export type DbClient = ReturnType<typeof createPrismaClient>;
