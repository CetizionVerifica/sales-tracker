import { toAmountString, toCalendarDateString } from '@sales-tracker/core/schemas';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireUser } from '@/lib/auth';
import { loadProjectFormOptions } from '../../form-options';
import { loadProjectOr404 } from '../../load';
import { ProjectForm } from '../../ProjectForm';

export const metadata = { title: 'Edit project · Sales Tracker' };

/**
 * A full page, as the UI guide gives projects (§4.3). Only the fields this user may change
 * are shown (M8 Decision 6); a user who can change none gets the 404 page.
 */
export default async function EditProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  const project = await loadProjectOr404(ctx, (await params).id);
  const { editableFields } = project.permissions;
  if (project.deletedAt || editableFields.length === 0) notFound();

  const options = await loadProjectFormOptions(
    ctx,
    { services: project.services, currency: project.currency, manager: project.manager },
    editableFields.includes('managerId'),
  );
  const day = (date: Date | null) => (date ? toCalendarDateString(date) : '');
  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/projects' },
          { label: project.number, href: `/projects/${project.id}` },
          { label: 'Edit' },
        ]}
        title={`Edit ${project.number}`}
        description={
          editableFields.length === 1
            ? 'A completed or cancelled project only takes notes.'
            : editableFields.includes('revenue')
              ? undefined
              : 'Revenue, services and the manager are changed by an admin.'
        }
      />
      <ProjectForm
        project={{ id: project.id, number: project.number }}
        editable={editableFields}
        client={project.client.name}
        quotationNumber={project.quotation.number}
        options={options}
        cancelHref={`/projects/${project.id}`}
        initial={{
          quotationId: project.quotationId,
          name: project.name,
          managerId: project.managerId ?? '',
          serviceIds: project.services.map((s) => s.id),
          revenue: toAmountString(project.revenueMinor, project.currency),
          currency: project.currency,
          startDate: day(project.startDate),
          endDate: day(project.endDate),
          completionPct: String(project.completionPct),
          description: project.description ?? '',
        }}
      />
    </div>
  );
}
