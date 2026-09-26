import { getDb, type Db } from '../clients.ts';
import { assertCan, withTx, type Ctx } from '../context.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import {
  contactSchema,
  createClientSchema,
  listClientsSchema,
  updateClientSchema,
  updateContactSchema,
  type ContactInput,
  type CreateClientInput,
  type ListClientsInput,
  type UpdateClientInput,
  type UpdateContactInput,
} from '../schemas/client.ts';
import type { Page } from '../schemas/common.ts';
import { guardUnique, nameEquals } from './unique.ts';

// `include` is not filtered by the soft-delete extension, so live contacts are selected
// explicitly. The sector is included even when retired or deleted (AC12).
const clientInclude = {
  sector: { select: { id: true, name: true, active: true, deletedAt: true } },
  contacts: {
    where: { deletedAt: null },
    orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }],
  },
};

const duplicate = (name: string) => `A client named “${name}” already exists`;

async function assertNameFree(db: Db, name: string, excludeId?: string) {
  const clash = await db.client.findFirst({
    where: { name: nameEquals(name), ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new DomainError(duplicate(name), { field: 'name' });
}

/** New and changed clients must use a live, active sector. */
async function assertSectorUsable(db: Db, sectorId: string) {
  const sector = await db.sector.findFirst({ where: { id: sectorId, active: true } });
  if (!sector) throw new DomainError('Choose an active sector', { field: 'sectorId' });
}

async function findLiveClient(db: Db, id: string) {
  const client = await db.client.findFirst({ where: { id }, select: { id: true, sectorId: true } });
  if (!client) throw new NotFoundError('client');
  return client;
}

async function findLiveContact(db: Db, id: string) {
  const contact = await db.clientContact.findFirst({ where: { id } });
  if (!contact) throw new NotFoundError('contact');
  return contact;
}

async function loadClient(db: Db, id: string) {
  const client = await db.client.findFirst({
    where: { id, deletedAt: undefined },
    include: clientInclude,
  });
  if (!client) throw new NotFoundError('client');
  return client;
}

export type ClientDetail = Awaited<ReturnType<typeof loadClient>>;

export async function listClients(ctx: Ctx, input: ListClientsInput) {
  const { page, pageSize, q, sort, dir, sectorId, status } = listClientsSchema.parse(input);
  assertCan(ctx, 'list', 'client');
  const where = {
    ...(status === 'deleted' && { deletedAt: { not: null } }),
    ...(sectorId && { sectorId }),
    ...(q && { name: { contains: q, mode: 'insensitive' as const } }),
  };
  const [items, total] = await Promise.all([
    getDb().client.findMany({
      where,
      include: { sector: clientInclude.sector },
      orderBy: [{ [sort ?? 'name']: dir ?? 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    getDb().client.count({ where }),
  ]);
  return { items, total, page, pageSize } satisfies Page<unknown>;
}

/** Includes a soft-deleted client (restore view); contacts are live only. */
export async function getClient(ctx: Ctx, id: string): Promise<ClientDetail> {
  assertCan(ctx, 'read', 'client');
  return loadClient(getDb(), id);
}

/** Admins and Sales (M3 Decision 11). Initial contacts are created in the same transaction. */
export async function createClient(ctx: Ctx, input: CreateClientInput): Promise<ClientDetail> {
  const { contacts, ...data } = createClientSchema.parse(input);
  assertCan(ctx, 'create', 'client');
  if (contacts.filter((c) => c.isPrimary).length > 1) {
    throw new DomainError('Only one contact can be primary', { field: 'contacts' });
  }
  return withTx(ctx, async (tx) => {
    await assertSectorUsable(tx, data.sectorId);
    await assertNameFree(tx, data.name);
    const client = await guardUnique('name', duplicate(data.name), () =>
      tx.client.create({ data }),
    );
    for (const contact of contacts) {
      await tx.clientContact.create({ data: { ...contact, clientId: client.id } });
    }
    return loadClient(tx, client.id);
  });
}

export async function updateClient(
  ctx: Ctx,
  id: string,
  input: UpdateClientInput,
): Promise<ClientDetail> {
  const data = updateClientSchema.parse(input);
  assertCan(ctx, 'update', 'client');
  return withTx(ctx, async (tx) => {
    const current = await findLiveClient(tx, id);
    // Only a *new* sector must be active: a retired sector keeps working on existing
    // clients (AC12), so saving other fields must not trip over it (M3 review fix A).
    if (data.sectorId && data.sectorId !== current.sectorId) {
      await assertSectorUsable(tx, data.sectorId);
    }
    if (data.name) await assertNameFree(tx, data.name, id);
    await guardUnique('name', duplicate(data.name ?? ''), () =>
      tx.client.update({ where: { id }, data }),
    );
    return loadClient(tx, id);
  });
}

export async function softDeleteClient(ctx: Ctx, id: string): Promise<ClientDetail> {
  assertCan(ctx, 'delete', 'client');
  return withTx(ctx, async (tx) => {
    await findLiveClient(tx, id);
    await tx.client.update({ where: { id }, data: { deletedAt: new Date() } });
    return loadClient(tx, id);
  });
}

export async function restoreClient(ctx: Ctx, id: string): Promise<ClientDetail> {
  assertCan(ctx, 'update', 'client');
  return withTx(ctx, async (tx) => {
    const client = await tx.client.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!client) throw new NotFoundError('client');
    await assertNameFree(tx, client.name, id);
    await guardUnique('name', duplicate(client.name), () =>
      tx.client.update({ where: { id }, data: { deletedAt: null } }),
    );
    return loadClient(tx, id);
  });
}

/** Live clients for pickers (M4 enquiry form). */
export async function listClientOptions(ctx: Ctx): Promise<{ id: string; name: string }[]> {
  assertCan(ctx, 'list', 'client');
  return getDb().client.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } });
}

// ─── Contacts: changing a contact is changing the client (admin only) ────────────────

async function unsetPrimary(db: Db, clientId: string, exceptId?: string) {
  await db.clientContact.updateMany({
    where: { clientId, isPrimary: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
    data: { isPrimary: false },
  });
}

export async function addContact(ctx: Ctx, clientId: string, input: ContactInput) {
  const data = contactSchema.parse(input);
  assertCan(ctx, 'update', 'client');
  return withTx(ctx, async (tx) => {
    await findLiveClient(tx, clientId);
    if (data.isPrimary) await unsetPrimary(tx, clientId);
    return tx.clientContact.create({ data: { ...data, clientId } });
  });
}

export async function updateContact(ctx: Ctx, contactId: string, input: UpdateContactInput) {
  const data = updateContactSchema.parse(input);
  assertCan(ctx, 'update', 'client');
  return withTx(ctx, async (tx) => {
    await findLiveContact(tx, contactId);
    return tx.clientContact.update({ where: { id: contactId }, data });
  });
}

export async function removeContact(ctx: Ctx, contactId: string) {
  assertCan(ctx, 'update', 'client');
  return withTx(ctx, async (tx) => {
    await findLiveContact(tx, contactId);
    return tx.clientContact.update({
      where: { id: contactId },
      data: { deletedAt: new Date(), isPrimary: false },
    });
  });
}

/** Makes one contact primary and unsets the previous one, in one transaction. */
export async function setPrimaryContact(ctx: Ctx, contactId: string) {
  assertCan(ctx, 'update', 'client');
  return withTx(ctx, async (tx) => {
    const contact = await findLiveContact(tx, contactId);
    await unsetPrimary(tx, contact.clientId, contactId);
    return tx.clientContact.update({ where: { id: contactId }, data: { isPrimary: true } });
  });
}
