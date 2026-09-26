import { AuditLogView } from '@/components/audit/AuditLogView';
import { requireAdmin } from '@/lib/auth';
import type { SearchParams } from '@/lib/list-params';

export const metadata = { title: 'Audit log · Sales Tracker' };

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireAdmin();
  if (!ctx) return null; // non-admins: the layout shows Forbidden
  return <AuditLogView ctx={ctx} searchParams={await searchParams} showActor />;
}
