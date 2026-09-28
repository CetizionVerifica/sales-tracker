import {
  ENQUIRY_SOURCES,
  ENQUIRY_SOURCE_LABELS,
  enquiryRuleIssues,
  type EnquirySourceValue,
} from '../../schemas/enquiry.ts';
import { todayInIST } from '../../schemas/common.ts';
import type {
  ColumnMappingEntry,
  ImportFieldValue,
  ImportRowMessage,
  ImportRowStatusValue,
  ReferenceFieldValue,
  ValueMappingEntry,
} from '../../schemas/import.ts';
import { resolveClient, type ClientOption } from '../resolve/clients.ts';
import { resolveMaster, type MasterOption } from '../resolve/masters.ts';
import { resolveOwner, type OwnerOption } from '../resolve/people.ts';
import { parseImportDate } from '../transform/dates.ts';
import { splitMultiValue } from '../transform/split.ts';
import { normalizeText } from '../transform/text.ts';

export interface ReferenceData {
  clients: readonly ClientOption[];
  sectors: readonly MasterOption[];
  services: readonly MasterOption[];
  owners: readonly OwnerOption[];
}

/** Just enough of the acting user for the owner rule below (M10b mirrors enquiry.service). */
export interface ImportActor {
  id: string;
  role: 'ADMIN' | 'SALES' | 'PROJECT_MANAGER';
  name: string;
}

export interface ResolvedEnquiryRow {
  clientId?: string;
  /** Set instead of `clientId` when the Values step chose "create new" for this client. */
  newClientName?: string;
  sectorId?: string;
  serviceIds?: string[];
  ownerId?: string;
  source?: EnquirySourceValue;
  receivedDate?: string;
  proposalSentDate?: string | null;
  sourceDetail?: string | null;
  description?: string | null;
}

export interface RowValidationResult {
  transformed: Record<string, unknown>;
  resolved: ResolvedEnquiryRow;
  status: 'READY' | 'ERROR';
  messages: ImportRowMessage[];
}

const REFERENCE_FIELD_LIST: readonly ReferenceFieldValue[] = [
  'client',
  'sector',
  'services',
  'source',
  'owner',
];

function findColumn(columns: readonly ColumnMappingEntry[], field: ImportFieldValue) {
  return columns.find((c) => c.field === field);
}

function rawFor(original: Record<string, unknown>, column: ColumnMappingEntry | undefined): unknown {
  return column ? original[column.header] : undefined;
}

export function valueMapKey(field: string, sourceValue: string): string {
  return `${field}:${normalizeText(sourceValue).toLowerCase()}`;
}

export function buildValueMappingLookup(
  entries: readonly ValueMappingEntry[],
): Map<string, ValueMappingEntry> {
  const map = new Map<string, ValueMappingEntry>();
  for (const entry of entries) map.set(valueMapKey(entry.field, entry.sourceValue), entry);
  return map;
}

/** The distinct raw values found for each reference field, for the wizard's Values step. */
export function collectDistinctValues(
  rows: readonly Record<string, unknown>[],
  columns: readonly ColumnMappingEntry[],
): { field: ReferenceFieldValue; values: { value: string; count: number }[] }[] {
  return REFERENCE_FIELD_LIST.map((field) => {
    const column = findColumn(columns, field);
    const counts = new Map<string, number>();
    if (column) {
      for (const row of rows) {
        const raw = rawFor(row, column);
        const values =
          field === 'services' ? splitMultiValue(raw, column.separator ?? ',') : [normalizeText(raw)];
        for (const value of values) {
          if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
        }
      }
    }
    return {
      field,
      values: Array.from(counts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    };
  }).filter((entry) => entry.values.length > 0);
}

type Resolution =
  | { kind: 'id'; id: string }
  | { kind: 'enum'; value: EnquirySourceValue }
  | { kind: 'create'; name: string }
  | { kind: 'blank' }
  | { kind: 'unmatched' };

/**
 * Resolves one raw value for a reference field: an explicit Values-step mapping wins;
 * otherwise falls back to a live exact match (M10b phase 1 has no aliases yet, so small
 * batches and tests can validate without forcing the Values step first).
 */
function resolveReference(
  field: ReferenceFieldValue,
  rawValue: string,
  lookup: Map<string, ValueMappingEntry>,
  refs: ReferenceData,
): Resolution {
  const mapped = lookup.get(valueMapKey(field, rawValue));
  if (mapped) {
    if (mapped.action === 'blank') return { kind: 'blank' };
    if (mapped.action === 'create') return { kind: 'create', name: rawValue };
    if (field === 'source') return { kind: 'enum', value: mapped.targetEnumValue! };
    return { kind: 'id', id: mapped.targetId! };
  }

  if (field === 'client') {
    const match = resolveClient(rawValue, refs.clients);
    return match ? { kind: 'id', id: match.id } : { kind: 'unmatched' };
  }
  if (field === 'sector') {
    const match = resolveMaster(rawValue, refs.sectors);
    return match ? { kind: 'id', id: match.id } : { kind: 'unmatched' };
  }
  if (field === 'services') {
    const match = resolveMaster(rawValue, refs.services);
    return match ? { kind: 'id', id: match.id } : { kind: 'unmatched' };
  }
  if (field === 'owner') {
    const match = resolveOwner(rawValue, refs.owners);
    return match ? { kind: 'id', id: match.id } : { kind: 'unmatched' };
  }
  // source: a fixed enum, not a live list — match the stored value or its display label.
  const bySourceValue = ENQUIRY_SOURCES.find((s) => s === rawValue.trim().toUpperCase());
  if (bySourceValue) return { kind: 'enum', value: bySourceValue };
  const byLabel = (Object.entries(ENQUIRY_SOURCE_LABELS) as [EnquirySourceValue, string][]).find(
    ([, label]) => label.toLowerCase() === rawValue.trim().toLowerCase(),
  );
  return byLabel ? { kind: 'enum', value: byLabel[0] } : { kind: 'unmatched' };
}

/**
 * Transforms and resolves one staged row (M10b "Resolve and validate"). Pure and
 * ctx-independent — the caller supplies the reference data and the acting user's identity
 * once per batch, not per row. Duplicate detection runs separately, across the whole batch
 * (`validateBatch` below), since it needs to compare rows against each other and the DB.
 */
export function validateRow(
  original: Record<string, unknown>,
  columns: readonly ColumnMappingEntry[],
  lookup: Map<string, ValueMappingEntry>,
  refs: ReferenceData,
  actor: ImportActor,
): RowValidationResult {
  const messages: ImportRowMessage[] = [];
  const push = (field: string, code: string, message: string) => messages.push({ field, code, message });
  const transformed: Record<string, unknown> = {};
  const resolved: ResolvedEnquiryRow = {};

  // ─── client ───
  const clientRaw = normalizeText(rawFor(original, findColumn(columns, 'client')));
  transformed.client = clientRaw;
  if (!clientRaw) {
    push('client', 'required', 'Client is required');
  } else {
    const match = resolveReference('client', clientRaw, lookup, refs);
    if (match.kind === 'id') resolved.clientId = match.id;
    else if (match.kind === 'create') resolved.newClientName = match.name;
    else if (match.kind === 'blank') push('client', 'required', 'Client is required');
    else push('client', 'unmatched', `No client matches "${clientRaw}"`);
  }

  // ─── sector ───
  const sectorRaw = normalizeText(rawFor(original, findColumn(columns, 'sector')));
  transformed.sector = sectorRaw;
  if (!sectorRaw) {
    push('sector', 'required', 'Sector is required');
  } else {
    const match = resolveReference('sector', sectorRaw, lookup, refs);
    if (match.kind === 'id') resolved.sectorId = match.id;
    else if (match.kind === 'blank') push('sector', 'required', 'Sector is required');
    else push('sector', 'unmatched', `No sector matches "${sectorRaw}"`);
  }

  // ─── services ───
  const servicesColumn = findColumn(columns, 'services');
  const servicesRaw = splitMultiValue(rawFor(original, servicesColumn), servicesColumn?.separator ?? ',');
  transformed.services = servicesRaw;
  if (servicesRaw.length === 0) {
    push('services', 'required', 'Choose at least one service');
  } else {
    const ids: string[] = [];
    let anyUnmatched = false;
    for (const raw of servicesRaw) {
      const match = resolveReference('services', raw, lookup, refs);
      if (match.kind === 'id') ids.push(match.id);
      else if (match.kind === 'blank') continue;
      else {
        anyUnmatched = true;
        push('services', 'unmatched', `No service matches "${raw}"`);
      }
    }
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length > 0) resolved.serviceIds = uniqueIds;
    else if (!anyUnmatched) push('services', 'required', 'Choose at least one service');
  }

  // ─── receivedDate ───
  const receivedColumn = findColumn(columns, 'receivedDate');
  const receivedRaw = rawFor(original, receivedColumn);
  transformed.receivedDate = receivedRaw == null ? '' : String(receivedRaw);
  let receivedDate: Date | undefined;
  if (receivedRaw == null || receivedRaw === '') {
    push('receivedDate', 'required', 'Received date is required');
  } else {
    const parsed = parseImportDate(receivedRaw, receivedColumn?.dateFormat ?? 'DD/MM/YYYY');
    if (!parsed.ok) {
      push('receivedDate', 'invalid', parsed.error);
    } else {
      receivedDate = isoToUtcDate(parsed.iso);
      if (receivedDate > todayInIST()) {
        push('receivedDate', 'future', 'The date cannot be in the future');
      } else {
        transformed.receivedDate = parsed.iso;
        resolved.receivedDate = parsed.iso;
      }
    }
  }

  // ─── proposalSentDate ───
  const proposalColumn = findColumn(columns, 'proposalSentDate');
  const proposalRaw = rawFor(original, proposalColumn);
  let proposalSentDate: Date | null | undefined;
  if (proposalRaw != null && proposalRaw !== '') {
    const parsed = parseImportDate(proposalRaw, proposalColumn?.dateFormat ?? 'DD/MM/YYYY');
    if (!parsed.ok) {
      push('proposalSentDate', 'invalid', parsed.error);
    } else {
      proposalSentDate = isoToUtcDate(parsed.iso);
      if (proposalSentDate > todayInIST()) {
        push('proposalSentDate', 'future', 'The date cannot be in the future');
        proposalSentDate = undefined;
      } else {
        transformed.proposalSentDate = parsed.iso;
        resolved.proposalSentDate = parsed.iso;
      }
    }
  }

  // ─── source ───
  const sourceRaw = normalizeText(rawFor(original, findColumn(columns, 'source')));
  transformed.source = sourceRaw;
  let source: EnquirySourceValue | undefined;
  if (!sourceRaw) {
    push('source', 'required', 'Choose where the enquiry came from');
  } else {
    const match = resolveReference('source', sourceRaw, lookup, refs);
    if (match.kind === 'enum') {
      source = match.value;
      resolved.source = match.value;
    } else {
      push('source', 'unmatched', `"${sourceRaw}" doesn't match a known source`);
    }
  }

  // ─── sourceDetail / description (free text, length-checked like the form) ───
  const sourceDetail = normalizeText(rawFor(original, findColumn(columns, 'sourceDetail')));
  transformed.sourceDetail = sourceDetail;
  if (sourceDetail.length > 200) push('sourceDetail', 'tooLong', 'Keep source detail under 200 characters');
  else resolved.sourceDetail = sourceDetail || null;

  const description = normalizeText(rawFor(original, findColumn(columns, 'description')));
  transformed.description = description;
  if (description.length > 2000) push('description', 'tooLong', 'Keep the description under 2000 characters');
  else resolved.description = description || null;

  // ─── cross-field rules (the same ones createEnquirySchema enforces) ───
  if (receivedDate && source) {
    for (const issue of enquiryRuleIssues({
      receivedDate,
      proposalSentDate,
      source,
      sourceDetail: resolved.sourceDetail,
    })) {
      push(issue.field, 'rule', issue.message);
    }
  }

  // ─── owner ───
  const ownerColumn = findColumn(columns, 'owner');
  const ownerRaw = normalizeText(rawFor(original, ownerColumn));
  transformed.owner = ownerRaw;
  if (ownerRaw) {
    if (actor.role !== 'ADMIN') {
      if (ownerRaw.toLowerCase() === actor.name.trim().toLowerCase()) {
        resolved.ownerId = actor.id;
      } else {
        push('owner', 'forbidden', 'Only admins can import records owned by someone else');
      }
    } else {
      const match = resolveReference('owner', ownerRaw, lookup, refs);
      if (match.kind === 'id') resolved.ownerId = match.id;
      else if (match.kind !== 'blank') push('owner', 'unmatched', `No active user matches "${ownerRaw}"`);
    }
  }

  return { transformed, resolved, status: messages.length > 0 ? 'ERROR' : 'READY', messages };
}

function isoToUtcDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

/** Client + received date: Enquiry has no `externalRef` in phase 1, so this is the natural key. */
function naturalKey(resolved: ResolvedEnquiryRow): string | null {
  const clientKey = resolved.clientId ?? (resolved.newClientName ? `new:${resolved.newClientName.toLowerCase()}` : null);
  if (!clientKey || !resolved.receivedDate) return null;
  return `${clientKey}|${resolved.receivedDate}`;
}

export interface BatchRow {
  id: string;
  result: RowValidationResult;
}

export interface ValidatedBatchRow extends Omit<RowValidationResult, 'status'> {
  id: string;
  status: ImportRowStatusValue;
}

/**
 * Promotes READY rows to WARNING (matches a live DB enquiry) or DUPLICATE (repeats an
 * earlier row in the same file) on client + received date. ERROR rows are left alone —
 * duplicate-ness doesn't matter until the row is otherwise importable.
 */
export function applyDuplicateChecks(
  rows: readonly BatchRow[],
  existingDbKeys: ReadonlySet<string>,
): ValidatedBatchRow[] {
  const seenInFile = new Set<string>();
  return rows.map(({ id, result }) => {
    if (result.status !== 'READY') return { ...result, id, status: result.status };
    const key = naturalKey(result.resolved);
    if (!key) return { ...result, id, status: result.status };

    if (seenInFile.has(key)) {
      return {
        ...result,
        id,
        status: 'DUPLICATE',
        messages: [
          ...result.messages,
          { field: 'client', code: 'duplicate', message: 'Same client and received date as another row in this file' },
        ],
      };
    }
    seenInFile.add(key);

    if (existingDbKeys.has(key)) {
      return {
        ...result,
        id,
        status: 'WARNING',
        messages: [
          ...result.messages,
          { field: 'client', code: 'duplicate', message: 'An enquiry for this client on this date already exists' },
        ],
      };
    }
    return { ...result, id, status: result.status };
  });
}
