/**
 * M10b phase 1 resolves references by exact match only (no `pg_trgm` fuzzy matching, no
 * aliases yet — see the module's "Out of scope" note in the M10b Phase 1 summary). Matching
 * is case-insensitive and ignores surrounding whitespace, since that's the most common way
 * the same name differs between a spreadsheet and the database.
 */
export function exactMatch<T extends { name: string }>(
  value: string,
  options: readonly T[],
): T | null {
  const target = value.trim().toLowerCase();
  if (!target) return null;
  return options.find((option) => option.name.trim().toLowerCase() === target) ?? null;
}
