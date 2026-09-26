import { MastersPage } from '@/components/admin/masters/MastersPage';
import { requireAdmin } from '@/lib/auth';
import type { SearchParams } from '@/lib/list-params';

export const metadata = { title: 'Sectors · Sales Tracker' };

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireAdmin();
  if (!ctx) return null; // non-admins: the layout shows Forbidden
  return <MastersPage ctx={ctx} kind="sector" searchParams={await searchParams} />;
}
