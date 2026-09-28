import { can, getEnv, getInvoiceDraft, NotFoundError } from '@sales-tracker/core';
import {
  formatMoney,
  toAmountString,
  toCalendarDateString,
  type InvoiceDraft,
} from '@sales-tracker/core/schemas';
import { notFound } from 'next/navigation';
import { Panel } from '@/components/charts/Panel';
import { NoAccess } from '@/components/feedback/NoAccess';
import { PageHeader } from '@/components/layout/PageHeader';
import { PipelineStrip } from '@/components/pipeline/PipelineStrip';
import { requireUser } from '@/lib/auth';
import { InvoiceForm } from '../InvoiceForm';
import { PurchaseOrderPicker } from './PurchaseOrderPicker';

export const metadata = { title: 'New invoice · Sales Tracker' };

/** Where the pre-filled amount came from, or why it is blank. */
function amountHint(draft: InvoiceDraft): string | null {
  if (draft.amountMinor === null) return `Invoices already cover PO ${draft.poNumber}`;
  return draft.invoicedMinor > 0n
    ? `Remaining on PO ${draft.poNumber} (${formatMoney(draft.invoicedMinor, draft.currency)} of ${formatMoney(draft.poAmountMinor, draft.currency)} invoiced)`
    : `Remaining on PO ${draft.poNumber}`;
}

/**
 * An invoice is recorded on a live PO (M10 Decision 1), pre-filled from getInvoiceDraft.
 * Opened without a PO (+ New → Invoice), the page starts with the PO picker.
 */
export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ purchaseOrderId?: string | string[] }>;
}) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'create', 'invoice')) return <NoAccess />;
  const { purchaseOrderId } = await searchParams;

  const header = (draft?: InvoiceDraft) => (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Invoices', href: '/invoices' }, { label: 'New invoice' }]}
        title="New invoice"
        description={
          draft
            ? `${draft.clientName} · PO ${draft.poNumber} · ${draft.projectNumber}`
            : 'Record an invoice raised on a client’s PO'
        }
      />
      {draft && (
        <PipelineStrip
          current="invoice"
          reached="po"
          links={{
            enquiry: `/enquiries/${draft.enquiryId}`,
            quotation: `/quotations/${draft.quotationId}`,
            project: `/projects/${draft.projectId}`,
            po: `/purchase-orders/${draft.purchaseOrderId}`,
          }}
        />
      )}
    </>
  );

  if (typeof purchaseOrderId !== 'string' || !purchaseOrderId) {
    return (
      <div className="flex max-w-[880px] flex-col gap-4">
        {header()}
        <Panel>
          <PurchaseOrderPicker />
        </Panel>
      </div>
    );
  }

  const draft = await getInvoiceDraft(ctx, purchaseOrderId).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      {header(draft)}
      <Panel>
        <PurchaseOrderPicker current={`PO ${draft.poNumber} · ${draft.projectNumber}`} />
      </Panel>
      <InvoiceForm
        key={draft.purchaseOrderId}
        po={{
          poNumber: draft.poNumber,
          client: draft.clientName,
          project: `${draft.projectNumber} · ${draft.projectName}`,
          services: draft.services,
          currency: draft.currency,
          amountMinor: draft.poAmountMinor.toString(),
          otherInvoicesMinor: draft.invoicedMinor.toString(),
          paymentTermsDays: draft.poPaymentTermsDays,
          companyDefaultDays: draft.companyDefaultDays,
        }}
        initialBasis={draft.dueDateBasis}
        hints={{ amount: amountHint(draft) }}
        maxMb={Math.floor(getEnv().DOCUMENT_MAX_BYTES / (1024 * 1024))}
        cancelHref={`/purchase-orders/${draft.purchaseOrderId}`}
        initial={{
          purchaseOrderId: draft.purchaseOrderId,
          invoiceNumber: '',
          invoiceDate: toCalendarDateString(draft.invoiceDate),
          serviceId: draft.serviceId ?? '',
          amount:
            draft.amountMinor === null ? '' : toAmountString(draft.amountMinor, draft.currency),
          dueDate: toCalendarDateString(draft.dueDate),
          alreadyPaid: false,
          paidAt: toCalendarDateString(draft.invoiceDate),
          paymentReference: '',
          description: '',
        }}
      />
    </div>
  );
}
