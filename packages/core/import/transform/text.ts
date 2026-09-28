/** Trim, collapse internal whitespace, and normalise Unicode (M10b Transform: text). */
export function normalizeText(raw: unknown): string {
  if (raw == null) return '';
  const text = raw instanceof Date ? raw.toISOString() : String(raw);
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}
