import {
  can,
  getSettings,
  listEnquiryOwnerOptions,
  listSectorOptions,
  listServiceOptions,
  type Ctx,
  type QuotationDetail,
} from '@sales-tracker/core';
import type { Option } from '../enquiries/form-options';

export interface QuotationFormOptions {
  sectors: Option[];
  services: Option[];
  /** Enabled currencies, plus a since-disabled one this quotation already uses. */
  currencies: string[];
  /** Admins only: the owner picker. */
  owners: Option[] | null;
}

/** Keeps a retired or inactive value selectable on the quotation that already uses it. */
function withCurrent(options: Option[], current: Option | undefined): Option[] {
  if (!current || options.some((o) => o.id === current.id)) return options;
  return [...options, current];
}

export async function loadQuotationFormOptions(
  ctx: Ctx,
  quotation?: QuotationDetail,
): Promise<QuotationFormOptions> {
  const isAdmin = can(ctx.user, 'list', 'user');
  const [sectors, services, settings, owners] = await Promise.all([
    listSectorOptions(ctx),
    listServiceOptions(ctx),
    getSettings(ctx),
    isAdmin ? listEnquiryOwnerOptions(ctx) : null,
  ]);
  const retired = (o: { id: string; name: string }) => ({ ...o, note: 'retired' });
  let serviceOptions: Option[] = services;
  for (const service of quotation?.services ?? []) {
    serviceOptions = withCurrent(serviceOptions, retired(service));
  }
  const currencies = [...settings.enabledCurrencies];
  if (quotation && !currencies.includes(quotation.currency)) currencies.push(quotation.currency);

  return {
    sectors: withCurrent(sectors, quotation && retired(quotation.sector)),
    services: serviceOptions,
    currencies,
    owners:
      owners &&
      withCurrent(
        owners.map(({ id, name }) => ({ id, name })),
        quotation && { ...quotation.owner, note: 'inactive' },
      ),
  };
}
