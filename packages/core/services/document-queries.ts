import type { Prisma } from '@sales-tracker/db';
import type { Db } from '../clients.ts';
import { supportedKinds } from '../extraction/kinds.ts';
import { scopeDocuments } from '../rbac/scope.ts';
import type { Actor } from '../rbac/types.ts';
import type { DocumentKindValue } from '../schemas/document.ts';

/*
 * Document queries shared by the document and My Today services. Not exported from the
 * package: they take a Db and a user, not a ctx, so callers check permissions first.
 */

/** Documents on records the user can read (M7). */
export async function documentScopeFor(db: Db, user: Actor): Promise<Prisma.DocumentWhereInput> {
  if (user.role === 'ADMIN') return {};
  const visible: Partial<Record<DocumentKindValue, string[]>> = {};
  for (const [kind, spec] of supportedKinds()) {
    visible[kind] = await spec.visibleIds(db, user);
  }
  return scopeDocuments(user, visible);
}

/**
 * The query behind listDocumentsPendingReview, for any user: My Today (M11) runs it for the
 * user whose list is shown, which an admin may pick (Decision 6). Internal: the caller
 * checks permissions. Includes the client name and extraction time My Today needs.
 */
export async function findDocumentsPendingReview(db: Db, user: Actor) {
  const mine: Prisma.DocumentWhereInput[] = [{ uploadedById: user.id }];
  const current: Prisma.DocumentWhereInput[] = [];
  for (const [kind, spec] of supportedKinds()) {
    current.push({ kind, ...spec.currentWhere });
    if (kind === 'QUOTATION') mine.push({ kind, quotation: { is: { ownerId: user.id } } });
    // M9: a PO document is its pipeline owner's and its project manager's to review.
    if (kind === 'PURCHASE_ORDER') {
      mine.push({
        kind,
        purchaseOrder: {
          is: {
            project: {
              OR: [{ managerId: user.id }, { quotation: { ownerId: user.id } }],
            },
          },
        },
      });
    }
    // M10: likewise an invoice document, through its PO's project.
    if (kind === 'INVOICE') {
      mine.push({
        kind,
        invoice: {
          is: {
            purchaseOrder: {
              project: {
                OR: [{ managerId: user.id }, { quotation: { ownerId: user.id } }],
              },
            },
          },
        },
      });
    }
  }
  return db.document.findMany({
    where: {
      deletedAt: null,
      extractionStatus: 'SUCCEEDED',
      reviewStatus: 'PENDING',
      AND: [{ OR: mine }, { OR: current }, await documentScopeFor(db, user)],
    },
    include: {
      uploadedBy: { select: { id: true, name: true } },
      reviewedBy: { select: { id: true, name: true } },
      client: { select: { name: true } },
    },
    orderBy: [{ extractedAt: 'asc' }, { id: 'asc' }],
  });
}

