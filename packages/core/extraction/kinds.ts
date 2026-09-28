import type { Prisma, QuotationStatus } from '@sales-tracker/db';
import type { Db } from '../clients.ts';
import type { Ctx } from '../context.ts';
import {
  purchaseOrderAccessSelect,
  purchaseOrderResource,
  quotationManagersSelect,
  quotationResource,
} from '../rbac/scope.ts';
import type { Actor, Resource } from '../rbac/types.ts';
import { toCalendarDateString } from '../schemas/common.ts';
import type { DocumentKindValue } from '../schemas/document.ts';
import {
  PURCHASE_ORDER_EXTRACTION_FIELDS,
  QUOTATION_EXTRACTION_FIELDS,
  type ExtractionFields,
} from '../schemas/extraction.ts';
import { toAmountString } from '../schemas/money.ts';
import { purchaseOrderLabel, targetFor } from '../services/follow-up-targets.ts';
import { updatePurchaseOrder } from '../services/purchase-order.service.ts';
import { updateQuotation } from '../services/quotation.service.ts';
import { isActiveQuotation } from '../status/quotation.ts';

/**
 * The document-kind registry (M7), the same pattern as M5's follow-up targets: everything
 * the document service and review screen need to know about a record type lives here.
 * M9 added PURCHASE_ORDER; M10 (INVOICE) adds one entry; nothing else changes.
 */

/** The record a document is attached to, as the document service sees it. */
export interface ParentRecord {
  id: string;
  label: string;
  clientId: string;
  clientName: string;
  /** The record's current document. */
  documentId: string | null;
  /** The can() resource of the record; a document's permissions are its record's. */
  resource: Resource;
  /** Record values keyed by review-field name, as strings for display and editing. */
  values: Record<string, string | null>;
  /** Why a review field cannot be applied to this record right now, keyed by field name. */
  locked: Record<string, string>;
}

/**
 * One row on the review screen. `applies` are the record's own field names written on
 * confirm, filled from the extracted fields in `from` (amount and currency travel together).
 */
export interface ReviewField {
  name: string;
  label: string;
  input: 'text' | 'date' | 'money' | 'textarea' | 'integer';
  from: readonly string[];
  applies: readonly string[];
}

export interface DocumentKindSpec {
  label: string;
  /** Prisma model name of the record (its audit rows carry the documentId change). */
  parentModel: string;
  fields: ExtractionFields;
  reviewFields: readonly ReviewField[];
  /** Extracted fields shown for information only (e.g. the printed number, client name). */
  infoFields: readonly { name: string; label: string }[];
  /** Live record, or null when it does not exist or is soft deleted. */
  load(db: Db, id: string): Promise<ParentRecord | null>;
  /** Ids of this kind's records the user may read (for scoping documents and the timeline). */
  visibleIds(db: Db, user: Actor, clientId?: string): Promise<string[]>;
  labels(db: Db, ids: string[]): Promise<Map<string, { label: string; deleted: boolean }>>;
  /**
   * Points the record at its current document (or none), only if it still points at
   * `expected` (two uploads racing must not leave an orphan). Returns false if it did not.
   * Runs inside the caller's transaction.
   */
  setDocument(
    db: Db,
    id: string,
    documentId: string | null,
    expected: string | null,
  ): Promise<boolean>;
  /** Documents that are some record's current one, for "to review" lists. */
  currentWhere: Prisma.DocumentWhereInput;
  /**
   * Writes the confirmed values through the record's own service, so its RBAC, status
   * rules, validation and audit apply exactly as if the user typed them (M7 Decision 1).
   * Keys are the record's field names. This is the only path from an extraction to a
   * record, and only confirmExtraction calls it.
   */
  applyConfirmed(ctx: Ctx, id: string, values: Record<string, string | null>): Promise<void>;
}

const QUOTATION_LOCK = 'A quotation with a PO received or marked lost keeps its amount and date';

const quotationKind: DocumentKindSpec = {
  label: 'Quotation',
  parentModel: 'Quotation',
  fields: QUOTATION_EXTRACTION_FIELDS,
  reviewFields: [
    {
      name: 'quotationDate',
      label: 'Quotation date',
      input: 'date',
      from: ['documentDate'],
      applies: ['quotationDate'],
    },
    {
      name: 'amount',
      label: 'Amount',
      input: 'money',
      from: ['amount', 'currency'],
      applies: ['amount', 'currency'],
    },
    {
      name: 'description',
      label: 'Description',
      input: 'textarea',
      from: ['scopeSummary'],
      applies: ['description'],
    },
  ],
  infoFields: [
    { name: 'documentNumber', label: 'Reference on the document' },
    { name: 'clientName', label: 'Client on the document' },
  ],

  async load(db, id) {
    const row = await db.quotation.findFirst({
      where: { id },
      select: {
        id: true,
        number: true,
        ownerId: true,
        clientId: true,
        status: true,
        quotationDate: true,
        amountMinor: true,
        currency: true,
        description: true,
        documentId: true,
        client: { select: { name: true } },
        ...quotationManagersSelect,
      },
    });
    if (!row) return null;
    // A closed quotation still takes a description (CLOSED_QUOTATION_EDITABLE), not these.
    const locked: Record<string, string> = isActiveQuotation(row.status as QuotationStatus)
      ? {}
      : { quotationDate: QUOTATION_LOCK, amount: QUOTATION_LOCK };
    return {
      id: row.id,
      label: row.number,
      clientId: row.clientId,
      clientName: row.client.name,
      documentId: row.documentId,
      resource: quotationResource(row),
      values: {
        quotationDate: toCalendarDateString(row.quotationDate),
        amount: toAmountString(row.amountMinor, row.currency),
        currency: row.currency,
        description: row.description,
      },
      locked,
    };
  },

  visibleIds: (db, user, clientId) => targetFor('QUOTATION').visibleIds(db, user, clientId),
  labels: (db, ids) => targetFor('QUOTATION').labels(db, ids),

  async setDocument(db, id, documentId, expected) {
    const { count } = await db.quotation.updateMany({
      where: { id, documentId: expected },
      data: { documentId },
    });
    return count === 1;
  },

  currentWhere: { quotation: { isNot: null } },

  async applyConfirmed(ctx, id, values) {
    await updateQuotation(ctx, id, values as Parameters<typeof updateQuotation>[2]);
  },
};

/**
 * A client's purchase order (M9). Nothing is locked in M9; M10 may lock the amount once
 * invoices exist. The date printed on the PO is shown for information only: it is not the
 * received date (Decision 12).
 */
const purchaseOrderKind: DocumentKindSpec = {
  label: 'Purchase order',
  parentModel: 'PurchaseOrder',
  fields: PURCHASE_ORDER_EXTRACTION_FIELDS,
  reviewFields: [
    {
      name: 'poNumber',
      label: 'PO number',
      input: 'text',
      from: ['poNumber'],
      applies: ['poNumber'],
    },
    {
      name: 'amount',
      label: 'Amount',
      input: 'money',
      from: ['amount', 'currency'],
      applies: ['amount', 'currency'],
    },
    {
      name: 'paymentTerms',
      label: 'Payment terms',
      input: 'textarea',
      from: ['paymentTerms'],
      applies: ['paymentTerms'],
    },
    {
      name: 'paymentTermsDays',
      label: 'Net days',
      input: 'integer',
      from: ['paymentTermsDays'],
      applies: ['paymentTermsDays'],
    },
  ],
  infoFields: [
    { name: 'documentDate', label: 'Date on the PO' },
    { name: 'clientName', label: 'Client on the PO' },
  ],

  async load(db, id) {
    const row = await db.purchaseOrder.findFirst({
      where: { id },
      select: {
        id: true,
        poNumber: true,
        clientId: true,
        amountMinor: true,
        currency: true,
        paymentTerms: true,
        paymentTermsDays: true,
        documentId: true,
        client: { select: { name: true } },
        ...purchaseOrderAccessSelect,
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      label: purchaseOrderLabel(row),
      clientId: row.clientId,
      clientName: row.client.name,
      documentId: row.documentId,
      resource: purchaseOrderResource(row),
      values: {
        poNumber: row.poNumber,
        amount: toAmountString(row.amountMinor, row.currency),
        currency: row.currency,
        paymentTerms: row.paymentTerms,
        paymentTermsDays: row.paymentTermsDays === null ? null : String(row.paymentTermsDays),
      },
      locked: {},
    };
  },

  visibleIds: (db, user, clientId) => targetFor('PURCHASE_ORDER').visibleIds(db, user, clientId),
  labels: (db, ids) => targetFor('PURCHASE_ORDER').labels(db, ids),

  async setDocument(db, id, documentId, expected) {
    const { count } = await db.purchaseOrder.updateMany({
      where: { id, documentId: expected },
      data: { documentId },
    });
    return count === 1;
  },

  currentWhere: { purchaseOrder: { isNot: null } },

  async applyConfirmed(ctx, id, values) {
    await updatePurchaseOrder(ctx, id, values as Parameters<typeof updatePurchaseOrder>[2]);
  },
};

export const DOCUMENT_KINDS_REGISTRY: Partial<Record<DocumentKindValue, DocumentKindSpec>> = {
  QUOTATION: quotationKind,
  PURCHASE_ORDER: purchaseOrderKind,
};

/** Kinds whose module has shipped. */
export function supportedKinds(): [DocumentKindValue, DocumentKindSpec][] {
  return Object.entries(DOCUMENT_KINDS_REGISTRY) as [DocumentKindValue, DocumentKindSpec][];
}

export function kindSpec(kind: DocumentKindValue): DocumentKindSpec | undefined {
  return DOCUMENT_KINDS_REGISTRY[kind];
}
