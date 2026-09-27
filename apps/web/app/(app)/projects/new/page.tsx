import {
  can,
  DomainError,
  getProjectDraft,
  NotFoundError,
  ProjectExistsError,
  projectResource,
} from '@sales-tracker/core';
import { toAmountString } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Panel } from '@/components/charts/Panel';
import { NoAccess } from '@/components/feedback/NoAccess';
import { PageHeader } from '@/components/layout/PageHeader';
import { PipelineStrip } from '@/components/pipeline/PipelineStrip';
import { requireUser } from '@/lib/auth';
import { loadQuotationOr404 } from '../../quotations/load';
import { loadProjectFormOptions } from '../form-options';
import { ProjectForm } from '../ProjectForm';

export const metadata = { title: 'New project · Sales Tracker' };

/**
 * A project starts from a PO_RECEIVED quotation (M8 Decision 1), pre-filled from M6's
 * getProjectDraft. A quotation that already has a project sends the user to it.
 */
export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ quotationId?: string | string[] }>;
}) {
  const ctx = await requireUser();
  const { quotationId } = await searchParams;
  if (typeof quotationId !== 'string') notFound();

  const quotation = await loadQuotationOr404(ctx, quotationId);
  const resource = projectResource({ managerId: null, quotation: { ownerId: quotation.ownerId } });
  if (!can(ctx.user, 'create', resource)) return <NoAccess />;
  const draft = await getProjectDraft(ctx, quotationId).catch((error: unknown) => {
    if (error instanceof ProjectExistsError) redirect(`/projects/${error.projectId}`);
    if (error instanceof NotFoundError) notFound();
    if (error instanceof DomainError) return error;
    throw error;
  });

  const header = (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Quotations', href: '/quotations' },
          { label: quotation.number, href: `/quotations/${quotation.id}` },
          { label: 'New project' },
        ]}
        title="New project"
        description={`${quotation.client.name} · from ${quotation.number}`}
      />
      <PipelineStrip
        current="project"
        reached="quotation"
        links={{
          enquiry: `/enquiries/${quotation.enquiry.id}`,
          quotation: `/quotations/${quotation.id}`,
        }}
      />
    </>
  );

  if (draft instanceof DomainError) {
    return (
      <div className="flex max-w-[880px] flex-col gap-4">
        {header}
        <Panel>
          <p>{draft.message}.</p>
          <Link className="text-primary hover:underline" href={`/quotations/${quotation.id}`}>
            Back to {quotation.number}
          </Link>
        </Panel>
      </div>
    );
  }

  const options = await loadProjectFormOptions(
    ctx,
    { services: quotation.services, currency: draft.currency },
    true,
  );
  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      {header}
      <ProjectForm
        client={quotation.client.name}
        quotationNumber={quotation.number}
        options={options}
        cancelHref={`/quotations/${quotation.id}`}
        initial={{
          quotationId: draft.quotationId,
          name: `${quotation.client.name} — ${quotation.services.map((s) => s.name).join(', ')}`.slice(
            0,
            200,
          ),
          managerId: '',
          serviceIds: draft.serviceIds,
          revenue: toAmountString(draft.revenueMinor, draft.currency),
          currency: draft.currency,
          startDate: '',
          endDate: '',
          completionPct: '0',
          description: '',
        }}
      />
    </div>
  );
}
