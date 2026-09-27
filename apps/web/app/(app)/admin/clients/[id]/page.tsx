import { getClient, listSectorOptions, NotFoundError } from '@sales-tracker/core';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Panel } from '@/components/charts/Panel';
import { FieldGrid } from '@/components/display/FieldGrid';
import { PageHeader } from '@/components/layout/PageHeader';
import { RecordMenu } from '@/components/layout/RecordMenu';
import { MarkBadge } from '@/components/pipeline/StatusBadge';
import { Button } from '@/components/ui/button';
import { requireAdmin } from '@/lib/auth';
import { deleteClientAction } from '../actions';
import { EditClientButton } from '../ClientForm';
import { ContactsSection } from './ContactsSection';

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin();
  if (!ctx) return null; // non-admins: the layout shows No access
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

  const deleted = client.deletedAt !== null;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Client records', href: '/admin/clients' }, { label: client.name }]}
        title={client.name}
        description={client.sector.name}
        badge={deleted && <MarkBadge tone="destructive">Deleted</MarkBadge>}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={`/clients/${client.id}`}>View client</Link>
            </Button>
            {!deleted && (
              <EditClientButton
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
            )}
            <RecordMenu
              label={client.name}
              items={
                deleted
                  ? []
                  : [
                      {
                        label: 'Delete client',
                        destructive: true,
                        title: `Delete “${client.name}”?`,
                        description:
                          'It disappears from lists and pickers. You can restore it from the Deleted filter.',
                        success: 'Client deleted',
                        run: async () => {
                          'use server';
                          return deleteClientAction({ id: client.id });
                        },
                      },
                    ]
              }
            />
          </>
        }
      />
      <div className="flex max-w-[880px] flex-col gap-4">
        <Panel title="Details">
          <FieldGrid
            items={[
              { label: 'Sector', value: client.sector.name },
              { label: 'GSTIN', value: client.gstin ?? '—' },
              { label: 'Address', value: client.address ?? '—', wide: true },
              { label: 'Notes', value: client.notes ?? '—', wide: true },
            ]}
          />
        </Panel>
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
      </div>
    </>
  );
}
