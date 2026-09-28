import { z } from 'zod';

/**
 * What Claude returns for a document (M7), in two layers:
 *
 * - The **wire** schema is what the API's structured output is constrained to. It carries
 *   plain types only (no lengths or formats), so one over-long quote or odd date never
 *   fails the whole extraction.
 * - `normaliseExtraction` turns a wire result into the **stored** shape: strings trimmed
 *   and capped, dates and amounts kept only when they are in the format the record's own
 *   schema expects, anything else set to null with low confidence.
 *
 * Either way the result is a suggestion: it reaches a record only through confirmExtraction
 * (CLAUDE.md rule 9).
 */

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** One extracted value with where it came from. `value` is null when not in the document. */
export interface ExtractedField {
  value: string | null;
  confidence: Confidence;
  page: number | null;
  sourceText: string | null;
}

const wireField = z.object({
  value: z.string().nullable(),
  confidence: z.enum(CONFIDENCES),
  page: z.number().int().nullable(),
  sourceText: z.string().nullable(),
});

/** How each extracted field is cleaned before it is stored. */
type FieldFormat = 'text' | 'date' | 'amount' | 'currency' | 'integer';

export interface ExtractionFieldSpec {
  format: FieldFormat;
  /** Longest stored value (text fields); the largest value (integer fields). */
  max?: number;
  /** The smallest value (integer fields). */
  min?: number;
  /** Told to Claude in the schema, so it knows what to look for. */
  description: string;
}

/** The fields Claude reads from a quotation document (M7 spec, QUOTATION kind). */
export const QUOTATION_EXTRACTION_FIELDS = {
  documentNumber: {
    format: 'text',
    max: 64,
    description: 'The quotation or proposal reference number exactly as printed.',
  },
  documentDate: {
    format: 'date',
    description: 'The date the quotation was issued, as YYYY-MM-DD.',
  },
  clientName: {
    format: 'text',
    max: 200,
    description: 'The name of the client company the quotation is addressed to.',
  },
  amount: {
    format: 'amount',
    description:
      'The grand total quoted, as digits with an optional decimal point (e.g. 125000.50). ' +
      'Include taxes if the document shows a total including them. No currency symbol.',
  },
  currency: {
    format: 'currency',
    description: 'The ISO 4217 code of the grand total (e.g. INR, USD).',
  },
  scopeSummary: {
    format: 'text',
    max: 1000,
    description: 'A short plain-text summary of the scope of work quoted.',
  },
} as const satisfies Record<string, ExtractionFieldSpec>;

/** The fields Claude reads from a client's purchase order (M9, PURCHASE_ORDER kind). */
export const PURCHASE_ORDER_EXTRACTION_FIELDS = {
  poNumber: {
    format: 'text',
    max: 64,
    description:
      'The purchase order number exactly as printed. Not our quotation or proposal reference.',
  },
  documentDate: {
    format: 'date',
    description: 'The date printed on the purchase order, as YYYY-MM-DD.',
  },
  clientName: {
    format: 'text',
    max: 200,
    description: 'The name of the company issuing the purchase order.',
  },
  amount: {
    format: 'amount',
    description:
      'The purchase order total, as digits with an optional decimal point (e.g. 1250000.00). ' +
      'Include taxes if the document shows a total including them. No currency symbol.',
  },
  currency: {
    format: 'currency',
    description: 'The ISO 4217 code of the purchase order total (e.g. INR, USD).',
  },
  paymentTerms: {
    format: 'text',
    max: 500,
    description: 'The payment terms as printed, summarised in plain text if they are long.',
  },
  paymentTermsDays: {
    format: 'integer',
    min: 0,
    max: 365,
    description:
      'The net payment days as digits only (e.g. 45 for "Net 45"), only when the terms state ' +
      'a single number of days. Otherwise null.',
  },
} as const satisfies Record<string, ExtractionFieldSpec>;

export type ExtractionFields = Record<string, ExtractionFieldSpec>;

/** The wire schema for a set of fields: every field present, value possibly null. */
export function wireSchemaFor(fields: ExtractionFields) {
  return z.object(
    Object.fromEntries(
      Object.entries(fields).map(([name, spec]) => [name, wireField.describe(spec.description)]),
    ),
  );
}

export type WireExtraction = Record<string, z.infer<typeof wireField>>;

/** The stored shape: `{ [field]: ExtractedField }`. Validated again when read back. */
export const storedExtractionSchema = z.record(
  z.string(),
  z.object({
    value: z.string().nullable(),
    confidence: z.enum(CONFIDENCES),
    page: z.number().int().nullable(),
    sourceText: z.string().nullable(),
  }),
);

export type StoredExtraction = Record<string, ExtractedField>;

const SOURCE_TEXT_MAX = 200;
/** 64 KB cap on the stored JSON (the audit snapshot carries it; M7 spec). */
export const EXTRACTION_MAX_BYTES = 64 * 1024;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function cleanValue(value: string | null, spec: ExtractionFieldSpec): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  switch (spec.format) {
    case 'text':
      return trimmed.slice(0, spec.max ?? 1000);
    case 'date': {
      if (!DAY.test(trimmed)) return null;
      const date = new Date(`${trimmed}T00:00:00Z`);
      return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== trimmed
        ? null
        : trimmed;
    }
    case 'amount': {
      // Keep digits, grouping commas and one decimal point; drop symbols and spaces.
      const plain = trimmed.replace(/[^\d.,]/g, '');
      return /^\d[\d,]*(\.\d+)?$/.test(plain) ? plain.replaceAll(',', '') : null;
    }
    case 'currency': {
      const code = trimmed.toUpperCase();
      return /^[A-Z]{3}$/.test(code) ? code : null;
    }
    case 'integer': {
      // Digits only: "45 days" or "-5" is left for the reviewer rather than guessed at.
      if (!/^\d{1,9}$/.test(trimmed)) return null;
      const number = Number(trimmed);
      if (number < (spec.min ?? 0) || number > (spec.max ?? Number.MAX_SAFE_INTEGER)) return null;
      return String(number);
    }
  }
}

/**
 * Wire result → stored shape. A value that is present but unusable becomes null with low
 * confidence (the reviewer sees the source text and types it themselves).
 */
export function normaliseExtraction(
  fields: ExtractionFields,
  wire: WireExtraction,
): StoredExtraction {
  const out: StoredExtraction = {};
  for (const [name, spec] of Object.entries(fields)) {
    const raw = wire[name];
    if (!raw) {
      out[name] = { value: null, confidence: 'low', page: null, sourceText: null };
      continue;
    }
    const value = cleanValue(raw.value, spec);
    const rejected = raw.value !== null && raw.value.trim() !== '' && value === null;
    out[name] = {
      value,
      confidence: rejected ? 'low' : raw.confidence,
      page: raw.page !== null && raw.page >= 1 ? raw.page : null,
      sourceText: raw.sourceText?.trim().slice(0, SOURCE_TEXT_MAX) || null,
    };
  }
  if (Buffer.byteLength(JSON.stringify(out)) > EXTRACTION_MAX_BYTES) {
    throw new Error('The extraction is larger than 64 KB');
  }
  return out;
}
