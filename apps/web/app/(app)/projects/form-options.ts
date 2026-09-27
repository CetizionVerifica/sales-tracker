import {
  getSettings,
  listProjectManagerOptions,
  listServiceOptions,
  type Ctx,
  type ProjectDetail,
} from '@sales-tracker/core';
import type { Option } from '../enquiries/form-options';

export interface ProjectFormOptions {
  services: Option[];
  /** Enabled currencies, plus the one this project (or its quotation) already uses. */
  currencies: string[];
  /** Active project managers, plus an inactive current one; null when the user can't pick. */
  managers: Option[] | null;
}

/** Keeps a retired or inactive value selectable on the record that already uses it. */
function withCurrent(options: Option[], current: Option | undefined): Option[] {
  if (!current || options.some((o) => o.id === current.id)) return options;
  return [...options, current];
}

/**
 * Options for the create and edit pages. `current` carries the services, currency and
 * manager already on the project (edit) or the quotation (create), so a retired service or
 * a since-disabled currency stays selectable there.
 */
export async function loadProjectFormOptions(
  ctx: Ctx,
  current: {
    services: { id: string; name: string }[];
    currency: string;
    manager?: ProjectDetail['manager'];
  },
  canPickManager: boolean,
): Promise<ProjectFormOptions> {
  const [services, settings, managers] = await Promise.all([
    listServiceOptions(ctx),
    getSettings(ctx),
    canPickManager ? listProjectManagerOptions(ctx) : null,
  ]);
  let serviceOptions: Option[] = services;
  for (const service of current.services) {
    serviceOptions = withCurrent(serviceOptions, { ...service, note: 'retired' });
  }
  const currencies = [...settings.enabledCurrencies];
  if (!currencies.includes(current.currency)) currencies.push(current.currency);
  return {
    services: serviceOptions,
    currencies,
    managers:
      managers &&
      withCurrent(
        managers,
        current.manager
          ? { id: current.manager.id, name: current.manager.name, note: 'inactive' }
          : undefined,
      ),
  };
}
