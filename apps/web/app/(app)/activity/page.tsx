import { AuditLogView } from '@/components/audit/AuditLogView';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireUser } from '@/lib/auth';
import type { SearchParams } from '@/lib/list-params';

export const metadata = { title: 'My activity · Sales Tracker' };

/** Everyone's own changes (PLAN.md: "read own changes"); scoped by listAuditLog. */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  return (
    <>
      <PageHeader title="My activity" description="Every change you made, with before and after" />
      <AuditLogView ctx={await requireUser()} searchParams={await searchParams} showActor={false} />
    </>
  );
}
