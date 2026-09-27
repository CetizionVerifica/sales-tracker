import { DomainError, getProjectDraft, NotFoundError } from '@sales-tracker/core';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Panel } from '@/components/charts/Panel';
import { DateDisplay } from '@/components/display/DateDisplay';
import { FieldGrid } from '@/components/display/FieldGrid';
import { Money } from '@/components/display/Money';
import { PageHeader } from '@/components/layout/PageHeader';
import { PipelineStrip } from '@/components/pipeline/PipelineStrip';
import { requireUser } from '@/lib/auth';
import { loadQuotationOr404 } from '../../quotations/load';

export const metadata = { title: 'New project · Sales Tracker' };

/**
 * Placeholder until M8 builds the project form: shows the draft a PO_RECEIVED quotation
 * hands over (getProjectDraft), so the M6 hand-off can be tested end to end.
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
  const draft = await getProjectDraft(ctx, quotationId).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof DomainError) return error;
    throw error;
  });

  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <PageHeader
        breadcrumbs={[
          { label: 'Quotations', href: '/quotations' },
          { label: quotation.number, href: `/quotations/${quotation.id}` },
          { label: 'New project' },
        ]}
        title="New project"
        description="Projects arrive in a later release. This is what the project will start from."
      />
      <PipelineStrip
        current="project"
        reached="quotation"
        links={{
          enquiry: `/enquiries/${quotation.enquiry.id}`,
          quotation: `/quotations/${quotation.id}`,
        }}
      />
      <Panel>
        {draft instanceof DomainError ? (
          <p>{draft.message}.</p>
        ) : (
          <FieldGrid
            items={[
              { label: 'Quotation', value: draft.quotationNumber },
              { label: 'Client', value: quotation.client.name },
              { label: 'Services', value: quotation.services.map((s) => s.name).join(', ') },
              {
                label: 'Revenue',
                value: <Money amountMinor={draft.revenueMinor} currency={draft.currency} />,
              },
              { label: 'PO received on', value: <DateDisplay value={draft.poReceivedDate} /> },
              { label: 'Owner', value: quotation.owner.name },
            ]}
          />
        )}
      </Panel>
      <Link
        className="text-primary self-start hover:underline"
        href={`/quotations/${quotation.id}`}
      >
        Back to {quotation.number}
      </Link>
    </div>
  );
}
