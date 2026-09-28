import {
  can,
  DomainError,
  getEnv,
  getPurchaseOrderDraft,
  getSettings,
  NotFoundError,
} from '@sales-tracker/core';
import {
  formatMoney,
  toAmountString,
  toCalendarDateString,
  type PurchaseOrderDraft,
} from '@sales-tracker/core/schemas';
import { notFound } from 'next/navigation';
import { Panel } from '@/components/charts/Panel';
import { NoAccess } from '@/components/feedback/NoAccess';
import { PageHeader } from '@/components/layout/PageHeader';
import { PipelineStrip } from '@/components/pipeline/PipelineStrip';
import { requireUser } from '@/lib/auth';
import { PurchaseOrderForm } from '../PurchaseOrderForm';
import { ProjectPicker } from './ProjectPicker';

export const metadata = { title: 'New purchase order · Sales Tracker' };

/** Where the pre-filled amount came from, or why it is blank. */
function amountHint(draft: PurchaseOrderDraft): string | null {
  if (draft.otherCurrencies) return `${draft.projectNumber} has POs in other currencies`;
  if (draft.amountMinor === null) return `POs already cover ${draft.projectNumber}’s revenue`;
  return draft.coveredMinor > 0n
    ? `Remaining on ${draft.projectNumber} (${formatMoney(draft.coveredMinor, draft.currency)} of ${formatMoney(draft.revenueMinor, draft.currency)} covered)`
    : `Remaining on ${draft.projectNumber}`;
}

/**
 * A PO is recorded on a live, non-cancelled project (M9 Decision 1), pre-filled from
 * getPurchaseOrderDraft. Opened without a project (+ New → PO), the page starts with the
 * project picker.
 */
export default async function NewPurchaseOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string | string[] }>;
}) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'create', 'purchaseOrder')) return <NoAccess />;
  const { projectId } = await searchParams;

  const header = (draft?: PurchaseOrderDraft) => (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Purchase orders', href: '/purchase-orders' },
          { label: 'New purchase order' },
        ]}
        title="New purchase order"
        description={
          draft
            ? `${draft.clientName} · ${draft.projectNumber} · ${draft.projectName}`
            : 'Record the client’s PO on its project'
        }
      />
      {draft && (
        <PipelineStrip
          current="po"
          reached="project"
          links={{
            enquiry: `/enquiries/${draft.enquiryId}`,
            quotation: `/quotations/${draft.quotationId}`,
            project: `/projects/${draft.projectId}`,
          }}
        />
      )}
    </>
  );

  if (typeof projectId !== 'string' || !projectId) {
    return (
      <div className="flex max-w-[880px] flex-col gap-4">
        {header()}
        <Panel>
          <ProjectPicker />
        </Panel>
      </div>
    );
  }

  const draft = await getPurchaseOrderDraft(ctx, projectId).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof DomainError) return error;
    throw error;
  });
  if (draft instanceof DomainError) {
    return (
      <div className="flex max-w-[880px] flex-col gap-4">
        {header()}
        <Panel>
          <div className="flex flex-col gap-4">
            <p role="alert">{draft.message}.</p>
            <ProjectPicker />
          </div>
        </Panel>
      </div>
    );
  }

  const settings = await getSettings(ctx);
  const currencies = [...settings.enabledCurrencies];
  if (!currencies.includes(draft.currency)) currencies.push(draft.currency);
  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      {header(draft)}
      <Panel>
        <ProjectPicker current={`${draft.projectNumber} · ${draft.projectName}`} />
      </Panel>
      <PurchaseOrderForm
        key={draft.projectId}
        project={{
          number: draft.projectNumber,
          client: draft.clientName,
          quotationNumber: draft.quotationNumber,
          services: draft.services,
          currency: draft.currency,
          revenueMinor: draft.revenueMinor.toString(),
          otherPosMinor: draft.coveredMinor.toString(),
        }}
        currencies={currencies}
        hints={{
          amount: amountHint(draft),
          receivedDate:
            draft.receivedDateFrom === 'quotation'
              ? `From ${draft.quotationNumber}’s PO received date`
              : null,
        }}
        maxMb={Math.floor(getEnv().DOCUMENT_MAX_BYTES / (1024 * 1024))}
        cancelHref={`/projects/${draft.projectId}`}
        initial={{
          projectId: draft.projectId,
          poNumber: '',
          receivedDate: toCalendarDateString(draft.receivedDate),
          amount:
            draft.amountMinor === null ? '' : toAmountString(draft.amountMinor, draft.currency),
          currency: draft.currency,
          serviceIds: draft.serviceIds,
          paymentTerms: '',
          paymentTermsDays: '',
          description: '',
        }}
      />
    </div>
  );
}
