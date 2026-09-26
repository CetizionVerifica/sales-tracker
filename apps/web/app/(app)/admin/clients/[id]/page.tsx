import { getClient, listSectorOptions, NotFoundError } from '@sales-tracker/core';
import { notFound } from 'next/navigation';
import { ConfirmButton } from '@/components/ConfirmButton';
import { requireAdmin } from '@/lib/auth';
import { deleteClientAction } from '../actions';
import { ClientForm } from '../ClientForm';
import { ContactsSection } from './ContactsSection';

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin();
  if (!ctx) return null; // non-admins: the layout shows Forbidden
  const { id } = await params;
  const client = await getClient(ctx, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const options = await listSectorOptions(ctx);

  // A retired or deleted sector stays selectable for the client that already uses it (AC12).
  const sectors = options.some((s) => s.id === client.sector.id)
    ? options
    : [
        ...options,
        {
          id: client.sector.id,
          name: client.sector.name,
          note: client.sector.deletedAt ? 'deleted' : 'inactive',
        },
      ];

  return (
    <section className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{client.name}</h2>
        {client.deletedAt === null && (
          <ConfirmButton
            label="Delete client"
            variant="destructive"
            title={`Delete “${client.name}”?`}
            description="It disappears from lists and pickers. You can restore it from the Deleted filter."
            success="Client deleted"
            run={async () => {
              'use server';
              return deleteClientAction({ id: client.id });
            }}
          />
        )}
      </div>
      <ClientForm
        sectors={sectors}
        client={{
          id: client.id,
          name: client.name,
          sectorId: client.sector.id,
          gstin: client.gstin ?? '',
          address: client.address ?? '',
          notes: client.notes ?? '',
        }}
      />
      <ContactsSection
        clientId={client.id}
        contacts={client.contacts.map((c) => ({
          id: c.id,
          name: c.name,
          designation: c.designation ?? '',
          email: c.email ?? '',
          phone: c.phone ?? '',
          isPrimary: c.isPrimary,
        }))}
      />
    </section>
  );
}
