import { AuditLogView } from '@/components/audit/AuditLogView';
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
    <div className="flex flex-col gap-4 py-8">
      <h1 className="text-2xl font-semibold">My activity</h1>
      <AuditLogView ctx={await requireUser()} searchParams={await searchParams} showActor={false} />
    </div>
  );
}
