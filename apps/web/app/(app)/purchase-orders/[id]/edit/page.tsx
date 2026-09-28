import { getProject, getSettings } from '@sales-tracker/core';
import { toAmountString, toCalendarDateString } from '@sales-tracker/core/schemas';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireUser } from '@/lib/auth';
import { loadPurchaseOrderOr404 } from '../../load';
import { PurchaseOrderForm } from '../../PurchaseOrderForm';

export const metadata = { title: 'Edit purchase order · Sales Tracker' };

/**
 * The create page's form, on the same full page (UI guide §4.3). The project is fixed (a PO
 * does not move) and there is no Document section: the detail page's card replaces it.
 */
export default async function EditPurchaseOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requireUser();
  const po = await loadPurchaseOrderOr404(ctx, (await params).id);
  if (po.deletedAt || !po.permissions.canUpdate) notFound();

  const [project, settings] = await Promise.all([getProject(ctx, po.project.id), getSettings(ctx)]);
  const currencies = [...settings.enabledCurrencies];
  for (const code of [project.currency, po.currency]) {
    if (!currencies.includes(code)) currencies.push(code);
  }
  // This PO's own services stay listed even if the project's changed since.
  const services = [...project.services];
  for (const service of po.services) {
    if (!services.some((s) => s.id === service.id)) services.push(service);
  }
  const others =
    po.projectTotals.coveredMinor - (po.currency === project.currency ? po.amountMinor : 0n);

  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <PageHeader
        breadcrumbs={[
          { label: 'Purchase orders', href: '/purchase-orders' },
          { label: po.poNumber, href: `/purchase-orders/${po.id}` },
          { label: 'Edit' },
        ]}
        title={`Edit PO ${po.poNumber}`}
        description={`${po.client.name} — ${po.project.name}`}
      />
      <PurchaseOrderForm
        purchaseOrder={{ id: po.id, poNumber: po.poNumber }}
        project={{
          number: po.project.number,
          client: po.client.name,
          quotationNumber: po.project.quotation.number,
          services,
          currency: project.currency,
          revenueMinor: project.revenueMinor.toString(),
          otherPosMinor: others.toString(),
        }}
        currencies={currencies}
        cancelHref={`/purchase-orders/${po.id}`}
        initial={{
          projectId: po.projectId,
          poNumber: po.poNumber,
          receivedDate: toCalendarDateString(po.receivedDate),
          amount: toAmountString(po.amountMinor, po.currency),
          currency: po.currency,
          serviceIds: po.services.map((s) => s.id),
          lines: po.lines.map((l) => ({
            serviceId: l.serviceId,
            amount: toAmountString(l.amountMinor, po.currency),
          })),
          paymentTerms: po.paymentTerms ?? '',
          paymentTermsDays: po.paymentTermsDays === null ? '' : String(po.paymentTermsDays),
          description: po.description ?? '',
        }}
      />
    </div>
  );
}
