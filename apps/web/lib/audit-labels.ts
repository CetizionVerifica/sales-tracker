/** Audit log wording (UI guide: sentence case, no enum strings). */

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  CREATE: 'Created',
  UPDATE: 'Updated',
  DELETE: 'Removed',
  SOFT_DELETE: 'Deleted',
  RESTORE: 'Restored',
};

export const AUDIT_SOURCE_LABELS: Record<string, string> = {
  web: 'Web',
  mcp: 'Claude (MCP)',
  import: 'Import',
  system: 'System',
};

/** `QuotationService` → "Quotation service", `amountMinor` → "Amount minor". */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
