import { exactMatch } from './match.ts';

export interface OwnerOption {
  id: string;
  name: string;
  role: 'ADMIN' | 'SALES' | 'PROJECT_MANAGER';
}

/**
 * Exact, case-insensitive name match against active Sales/Admin users (M10b phase 1 has no
 * email column to match against — `listEnquiryOwnerOptions` only carries name and role).
 */
export function resolveOwner(name: string, options: readonly OwnerOption[]): OwnerOption | null {
  return exactMatch(name, options);
}
