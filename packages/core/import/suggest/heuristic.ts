import type { ImportFieldValue } from '../../schemas/import.ts';
import type { ImportFieldDef } from './field-catalog.ts';

export interface ColumnSuggestion {
  column: number;
  header: string;
  field: ImportFieldValue | null;
  confidence: number;
  reason: string;
}

/** Lower-cased, punctuation and extra whitespace stripped, so "Customer Name:" ~ "customer name". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One field's best match against a normalized header: 1 exact, 0.6 partial, 0 no match. */
function scoreAgainst(headerNorm: string, field: ImportFieldDef): number {
  if (!headerNorm) return 0;
  const labelNorm = normalize(field.label);
  if (headerNorm === labelNorm) return 1;
  for (const synonym of field.synonyms) {
    const synonymNorm = normalize(synonym);
    if (headerNorm === synonymNorm) return 1;
  }
  for (const synonym of field.synonyms) {
    const synonymNorm = normalize(synonym);
    if (!synonymNorm) continue;
    if (headerNorm.includes(synonymNorm) || synonymNorm.includes(headerNorm)) return 0.6;
  }
  return 0;
}

/**
 * Synonym-based heuristic mapping (M10b phase 1 has no AI call): each file column gets the
 * catalog field it scores highest against, kept only if the score clears 0.6. Each field is
 * awarded to at most one column — its best-scoring, left-most match — so two similarly named
 * columns don't both claim "Client".
 */
export function suggestColumns(
  headers: readonly string[],
  catalog: readonly ImportFieldDef[],
): ColumnSuggestion[] {
  const suggestions: ColumnSuggestion[] = headers.map((header, column) => ({
    column,
    header,
    field: null,
    confidence: 0,
    reason: 'No matching field name found',
  }));

  const claimed = new Set<ImportFieldValue>();
  // Highest-confidence column/field pairs first, so strong matches claim their field before
  // a weaker one on an earlier column can take it.
  const candidates: { column: number; field: ImportFieldDef; score: number }[] = [];
  headers.forEach((header, column) => {
    const headerNorm = normalize(header);
    for (const field of catalog) {
      const score = scoreAgainst(headerNorm, field);
      if (score > 0) candidates.push({ column, field, score });
    }
  });
  candidates.sort((a, b) => b.score - a.score || a.column - b.column);

  for (const { column, field, score } of candidates) {
    if (claimed.has(field.field)) continue;
    if (suggestions[column]!.field) continue;
    claimed.add(field.field);
    suggestions[column] = {
      column,
      header: headers[column]!,
      field: field.field,
      confidence: score,
      reason: score === 1 ? `Matches "${field.label}"` : `Looks like "${field.label}"`,
    };
  }

  return suggestions;
}
