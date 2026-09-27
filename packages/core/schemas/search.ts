import { z } from 'zod';

/** ⌘K search input: at least two characters, a few results per record type. */
export const searchRecordsSchema = z.object({
  q: z.string().trim().min(2, 'Type at least two characters').max(100),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export type SearchRecordsInput = z.input<typeof searchRecordsSchema>;

export const SEARCH_RESULT_TYPES = ['ENQUIRY', 'QUOTATION', 'CLIENT'] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];
