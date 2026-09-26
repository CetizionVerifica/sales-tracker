import { listSectorOptions } from '@sales-tracker/core';
import { requireUser } from '@/lib/auth';
import { ClientForm } from '../ClientForm';

export const metadata = { title: 'New client · Sales Tracker' };

export default async function NewClientPage() {
  const sectors = await listSectorOptions(await requireUser());
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">New client</h2>
      <ClientForm sectors={sectors} />
    </section>
  );
}
