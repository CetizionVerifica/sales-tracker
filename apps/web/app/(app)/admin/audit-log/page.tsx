import { AuditLogView } from '@/components/audit/AuditLogView';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireAdmin } from '@/lib/auth';
import type { SearchParams } from '@/lib/list-params';

export const metadata = { title: 'Audit log · Sales Tracker' };

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireAdmin();
  if (!ctx) return null; // non-admins: the layout shows No access
  return (
    <>
      <PageHeader title="Audit log" description="Every change anyone made, with before and after" />
      <AuditLogView ctx={ctx} searchParams={await searchParams} showActor />
    </>
  );
}
