import { exactMatch } from './match.ts';

export interface MasterOption {
  id: string;
  name: string;
}

/** Exact, case-insensitive name match against active sectors or services (M10b phase 1). */
export function resolveMaster(name: string, options: readonly MasterOption[]): MasterOption | null {
  return exactMatch(name, options);
}
