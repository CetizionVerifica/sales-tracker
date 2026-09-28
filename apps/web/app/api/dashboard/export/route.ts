import { dashboardPanelCsv } from '@sales-tracker/core';
import { dashboardExportSchema } from '@sales-tracker/core/schemas';
import { ACTION_ERRORS, toResult } from '@/lib/action-core';
import { getCtx } from '@/lib/auth';

/**
 * One dashboard panel as CSV (M12 AC11): `GET ?panel=topClients&preset=…&from=…&to=…`
 * with the same period, owner and manager parameters as /dashboard. Scoped exactly like the
 * page; not audited (M12 Decision 8). A route handler, so the browser downloads a file.
 */
export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const { panel, ...input } = params;
  const which = dashboardExportSchema.safeParse(panel);
  if (!which.success) {
    return Response.json({ ok: false, error: 'Choose a panel to export' }, { status: 400 });
  }
  try {
    const ctx = await getCtx();
    const { filename, body } = await dashboardPanelCsv(ctx, input, which.data);
    return new Response(body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    const result = toResult(error);
    const status =
      result.ok || result.error === ACTION_ERRORS.unexpected
        ? 500
        : result.error === ACTION_ERRORS.unauthenticated
          ? 401
          : result.error === ACTION_ERRORS.forbidden
            ? 403
            : result.error === ACTION_ERRORS.notFound
              ? 404
              : 400;
    return Response.json(result, { status });
  }
}
