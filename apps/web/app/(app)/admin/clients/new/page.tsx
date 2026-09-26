import { listSectorOptions } from '@sales-tracker/core';
import { requireAdmin } from '@/lib/auth';
import { ClientForm } from '../ClientForm';

export const metadata = { title: 'New client · Sales Tracker' };

export default async function NewClientPage() {
  const ctx = await requireAdmin();
  if (!ctx) return null; // non-admins: the layout shows Forbidden
  const sectors = await listSectorOptions(ctx);
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">New client</h2>
      <ClientForm sectors={sectors} />
    </section>
  );
}
