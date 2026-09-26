import { AuditLogView } from '@/components/audit/AuditLogView';
import { requireUser } from '@/lib/auth';
import type { SearchParams } from '@/lib/list-params';

export const metadata = { title: 'Audit log · Sales Tracker' };

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  return <AuditLogView ctx={await requireUser()} searchParams={await searchParams} showActor />;
}
