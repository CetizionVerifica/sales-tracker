import { can } from '@sales-tracker/core';
import { NoAccess } from '@/components/feedback/NoAccess';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireUser } from '@/lib/auth';
import { UploadForm } from './UploadForm';

export const metadata = { title: 'New import · Sales Tracker' };

export default async function NewImportPage() {
  const ctx = await requireUser();
  if (!can(ctx.user, 'create', 'importBatch')) return <NoAccess />;

  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <PageHeader
        breadcrumbs={[{ label: 'Imports', href: '/imports' }, { label: 'New import' }]}
        title="New import"
        description="Upload a spreadsheet, then map its columns and review each row before anything is saved."
      />
      <UploadForm />
    </div>
  );
}
