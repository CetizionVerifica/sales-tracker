import {
  getSalesReport,
  reportCsv,
  REPORT_EXPORT_KEYS,
  type ReportExportKey,
} from '@sales-tracker/core';
import { ACTION_ERRORS, toResult } from '@/lib/action-core';
import { getCtx } from '@/lib/auth';

/**
 * One sales report as CSV (M12b: "Export CSV"): `GET ?report=revenue&preset=…&from=…&to=…`
 * with the same period, owner, sector and service parameters as /reports. Scoped exactly like
 * the page; not audited (M12 Decision 8, carried over). A route handler, so the browser
 * downloads a file.
 */
export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const { report: reportKey, ...input } = params;
  if (!REPORT_EXPORT_KEYS.includes(reportKey as ReportExportKey)) {
    return Response.json({ ok: false, error: 'Choose a report to export' }, { status: 400 });
  }
  try {
    const ctx = await getCtx();
    const report = await getSalesReport(ctx, input);
    const { filename, body } = reportCsv(report, reportKey as ReportExportKey);
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
