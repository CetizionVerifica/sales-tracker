import { buildEnquiryImportTemplate, can } from '@sales-tracker/core';
import { ACTION_ERRORS } from '@/lib/action-core';
import { getCtx } from '@/lib/auth';

/**
 * The M10b bulk-import starting template: one sheet with the field catalog's own column
 * names (so a filled-in copy is auto-mapped, no manual work on the Columns step) and one
 * instructions sheet. Static content, gated the same as starting an import.
 */
export async function GET() {
  const ctx = await getCtx().catch(() => null);
  if (!ctx)
    return Response.json({ ok: false, error: ACTION_ERRORS.unauthenticated }, { status: 401 });
  if (!can(ctx.user, 'create', 'importBatch')) {
    return Response.json({ ok: false, error: ACTION_ERRORS.forbidden }, { status: 403 });
  }

  const bytes = buildEnquiryImportTemplate();
  return new Response(Buffer.from(bytes), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="enquiry-import-template.xlsx"',
      'cache-control': 'no-store',
    },
  });
}
