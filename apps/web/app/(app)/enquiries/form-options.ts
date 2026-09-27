import {
  can,
  listClientOptions,
  listEnquiryOwnerOptions,
  listSectorOptions,
  listServiceOptions,
  type Ctx,
  type EnquiryDetail,
} from '@sales-tracker/core';

export interface Option {
  id: string;
  name: string;
  /** Shown after the name, e.g. "retired" for a value only this enquiry still uses. */
  note?: string;
}

export interface EnquiryFormOptions {
  clients: (Option & { sectorId: string })[];
  sectors: Option[];
  services: Option[];
  /** Admins only: the owner picker. */
  owners: Option[] | null;
  canCreateClient: boolean;
}

/** Keeps a retired or deleted value selectable on the enquiry that already uses it. */
function withCurrent<T extends Option>(options: T[], current: T | undefined): T[] {
  if (!current || options.some((o) => o.id === current.id)) return options;
  return [...options, current];
}

export async function loadEnquiryFormOptions(
  ctx: Ctx,
  enquiry?: EnquiryDetail,
): Promise<EnquiryFormOptions> {
  const isAdmin = can(ctx.user, 'list', 'user');
  const [clients, sectors, services, owners] = await Promise.all([
    listClientOptions(ctx),
    listSectorOptions(ctx),
    listServiceOptions(ctx),
    isAdmin ? listEnquiryOwnerOptions(ctx) : null,
  ]);
  const retired = (o: { id: string; name: string }) => ({ ...o, note: 'retired' });

  let serviceOptions: Option[] = services;
  for (const service of enquiry?.services ?? []) {
    serviceOptions = withCurrent(serviceOptions, retired(service));
  }
  return {
    clients: withCurrent<Option & { sectorId: string }>(
      clients,
      enquiry && { ...enquiry.client, sectorId: enquiry.sectorId, note: 'deleted' },
    ),
    sectors: withCurrent(sectors, enquiry && retired(enquiry.sector)),
    services: serviceOptions,
    owners:
      owners &&
      withCurrent<Option>(
        owners.map(({ id, name }) => ({ id, name })),
        enquiry && { ...enquiry.owner, note: 'inactive' },
      ),
    canCreateClient: can(ctx.user, 'create', 'client'),
  };
}
