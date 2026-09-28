import { getInvoiceDraft } from '@sales-tracker/core';
import { toAmountString, toCalendarDateString } from '@sales-tracker/core/schemas';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireUser } from '@/lib/auth';
import { InvoiceForm } from '../../InvoiceForm';
import { loadInvoiceOr404 } from '../../load';

export const metadata = { title: 'Edit invoice · Sales Tracker' };

/**
 * The create page's form, on the same full page (UI guide §4.3). The PO is fixed (an
 * invoice does not move), and there is no Document or "Already paid" section: the detail
 * page's Document card and Mark paid handle those.
 */
export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  const invoice = await loadInvoiceOr404(ctx, (await params).id);
  if (!invoice.permissions.canUpdate) notFound();
  const po = invoice.purchaseOrder;
  // The PO's current terms and the company default: a recomputed due date uses them.
  const draft = await getInvoiceDraft(ctx, po.id);
  // This invoice's own service stays listed even if the PO's changed since.
  const services = draft.services.some((s) => s.id === invoice.service.id)
    ? draft.services
    : [...draft.services, invoice.service];

  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <PageHeader
        breadcrumbs={[
          { label: 'Invoices', href: '/invoices' },
          { label: invoice.invoiceNumber, href: `/invoices/${invoice.id}` },
          { label: 'Edit' },
        ]}
        title={`Edit invoice ${invoice.invoiceNumber}`}
        description={`${invoice.client.name} — PO ${po.poNumber}`}
      />
      <InvoiceForm
        invoice={{ id: invoice.id, invoiceNumber: invoice.invoiceNumber }}
        po={{
          poNumber: po.poNumber,
          client: invoice.client.name,
          project: `${po.project.number} · ${po.project.name}`,
          services,
          currency: invoice.currency,
          amountMinor: po.amountMinor.toString(),
          otherInvoicesMinor: (invoice.billing.invoicedMinor - invoice.amountMinor).toString(),
          paymentTermsDays: draft.poPaymentTermsDays,
          companyDefaultDays: draft.companyDefaultDays,
        }}
        initialBasis={invoice.dueDateBasis}
        cancelHref={`/invoices/${invoice.id}`}
        initial={{
          purchaseOrderId: po.id,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: toCalendarDateString(invoice.invoiceDate),
          serviceId: invoice.serviceId,
          amount: toAmountString(invoice.amountMinor, invoice.currency),
          dueDate: toCalendarDateString(invoice.dueDate),
          alreadyPaid: false,
          paidAt: '',
          paymentReference: invoice.paymentReference ?? '',
          description: invoice.description ?? '',
        }}
      />
    </div>
  );
}
