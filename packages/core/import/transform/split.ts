import { normalizeText } from './text.ts';

/** Splits a multi-value cell ("ESG, HSE") by the confirmed separator; trims and de-duplicates. */
export function splitMultiValue(raw: unknown, separator: string): string[] {
  const text = normalizeText(raw);
  if (!text) return [];
  const parts = text
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
  return Array.from(new Set(parts));
}
