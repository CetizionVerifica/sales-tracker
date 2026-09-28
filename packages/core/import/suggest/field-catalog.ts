import type { ImportFieldValue } from '../../schemas/import.ts';

export interface ImportFieldDef {
  field: ImportFieldValue;
  label: string;
  type: 'text' | 'date' | 'multiText' | 'enum';
  required: boolean;
  /** Lower-cased, used by `suggest/heuristic.ts` to match file headers. */
  synonyms: string[];
  example: string;
}

/**
 * The whole M10b phase-1 field catalog: Enquiry is the only importable entity so far
 * (`IMPORT_ENTITIES` in schemas/import.ts). Adding an entity later means adding its fields
 * here with an `entity` tag, not changing this shape.
 */
export const ENQUIRY_FIELD_CATALOG: readonly ImportFieldDef[] = [
  {
    field: 'client',
    label: 'Client',
    type: 'text',
    required: true,
    synonyms: ['client', 'customer', 'customer name', 'party', 'company', 'account'],
    example: 'Sun Pharmaceutical Industries Ltd',
  },
  {
    field: 'sector',
    label: 'Sector',
    type: 'text',
    required: true,
    synonyms: ['sector', 'industry', 'segment'],
    example: 'Pharmaceutical',
  },
  {
    field: 'services',
    label: 'Service(s)',
    type: 'multiText',
    required: true,
    synonyms: ['service', 'services', 'service required', 'scope'],
    example: 'ESG, HSE',
  },
  {
    field: 'receivedDate',
    label: 'Received date',
    type: 'date',
    required: true,
    synonyms: ['received date', 'enquiry date', 'date received', 'date'],
    example: '12/03/2025',
  },
  {
    field: 'proposalSentDate',
    label: 'Proposal sent date',
    type: 'date',
    required: false,
    synonyms: ['proposal sent date', 'proposal date', 'quote sent', 'quotation sent date'],
    example: '18/03/2025',
  },
  {
    field: 'source',
    label: 'Source',
    type: 'enum',
    required: true,
    synonyms: ['source', 'enquiry source', 'channel', 'lead source'],
    example: 'Email',
  },
  {
    field: 'sourceDetail',
    label: 'Source detail',
    type: 'text',
    required: false,
    synonyms: ['source detail', 'details', 'tender ref', 'referred by'],
    example: 'GEM/2025/B/123',
  },
  {
    field: 'description',
    label: 'Description',
    type: 'text',
    required: false,
    synonyms: ['description', 'notes', 'remarks', 'scope of work'],
    example: 'Annual ESG assessment for FY25',
  },
  {
    field: 'owner',
    label: 'Owner',
    type: 'text',
    required: false,
    synonyms: ['owner', 'sales owner', 'handled by', 'assigned to', 'sales person', 'salesperson'],
    example: 'Rahul Sharma',
  },
] as const;
