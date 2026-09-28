import { exactMatch } from './match.ts';

export interface ClientOption {
  id: string;
  name: string;
  sectorId: string;
}

/** Exact, case-insensitive name match against the company's live clients (M10b phase 1). */
export function resolveClient(name: string, options: readonly ClientOption[]): ClientOption | null {
  return exactMatch(name, options);
}
