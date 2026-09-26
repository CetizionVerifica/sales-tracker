import { MastersPage } from '@/components/admin/masters/MastersPage';
import { requireUser } from '@/lib/auth';
import type { SearchParams } from '@/lib/list-params';

export const metadata = { title: 'Sectors · Sales Tracker' };

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return <MastersPage ctx={await requireUser()} kind="sector" searchParams={await searchParams} />;
}
