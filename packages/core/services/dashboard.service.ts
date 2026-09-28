import { getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { todayInIST } from '../schemas/common.ts';
import {
  dashboardExportSchema,
  dashboardInputSchema,
  type Dashboard,
  type DashboardInput,
  type DashboardPanel,
  type PanelExport,
} from '../schemas/dashboard.ts';
import { previousPeriod, resolvePeriod } from '../schemas/report.ts';
import {
  ageing,
  billing,
  delivered,
  missingFx,
  projectKpis,
  projectsByStatus,
} from './dashboard/delivery.ts';
import { panelExport, toCsv } from './dashboard/export.ts';
import { conversion, funnel, quotedVsWon, salesKpis, topClients } from './dashboard/pipeline.ts';
import { resolveScope } from './dashboard/scope.ts';

/*
 * The dashboard (M12). Read-only: no writes, no audit rows (Decision 8 covers exports).
 * `resolveScope` checks the `dashboard` permission for the scope the viewer gets, and every
 * panel query ANDs the viewer's own scope, so nothing is counted they cannot read.
 */

const TOP_CLIENTS = 10;

async function build(
  ctx: Ctx,
  input: DashboardInput,
  options: { today?: Date; allClients?: boolean },
): Promise<Dashboard> {
  const parsed = dashboardInputSchema.parse(input);
  const db = getDb();
  const today = options.today ?? todayInIST();
  const scope = await resolveScope(db, ctx, parsed);
  const period = resolvePeriod(parsed, today);
  const previous = previousPeriod(period);
  const { viewer: _viewer, ownerId: _ownerId, managerId: _managerId, ...publicScope } = scope;

  if (scope.kind === 'project') {
    const [kpis, byStatus, aged, done, bills, missing] = await Promise.all([
      projectKpis(db, scope, period, previous, today),
      projectsByStatus(db, scope),
      ageing(db, scope, today),
      delivered(db, scope, period),
      billing(db, scope, period),
      missingFx(db, scope, 'project'),
    ]);
    return {
      layout: 'project',
      scope: publicScope,
      period,
      previous,
      missingFx: missing,
      kpis,
      projectsByStatus: byStatus,
      ageing: aged,
      delivered: done,
      billing: bills,
    };
  }

  const [kpis, stages, aged, conv, months, clients, missing] = await Promise.all([
    salesKpis(db, scope, period, previous),
    funnel(db, scope, period),
    ageing(db, scope, today),
    conversion(db, scope, period, parsed.dimension),
    quotedVsWon(db, scope, period),
    topClients(db, scope, period, options.allClients ? null : TOP_CLIENTS),
    missingFx(db, scope, 'sales'),
  ]);
  return {
    layout: 'sales',
    scope: publicScope,
    period,
    previous,
    missingFx: missing,
    kpis,
    funnel: stages,
    ageing: aged,
    conversion: conv,
    quotedVsWon: months,
    topClients: clients,
  };
}

/**
 * The dashboard for the viewer's scope: company (admins), personal (Sales, or an admin's
 * `ownerId`) or project (PMs, or an admin's `managerId`). See docs/modules/M12-dashboard.md
 * for every definition.
 */
export function getDashboard(
  ctx: Ctx,
  input: DashboardInput = {},
  options: { today?: Date } = {},
): Promise<Dashboard> {
  return build(ctx, input, options);
}

/** One panel's rows for CSV, at the same scope; top clients lists every client with a value. */
export async function exportDashboardPanel(
  ctx: Ctx,
  input: DashboardInput,
  panel: DashboardPanel,
  options: { today?: Date } = {},
): Promise<PanelExport> {
  const which = dashboardExportSchema.parse(panel);
  const dashboard = await build(ctx, input, { ...options, allClients: which === 'topClients' });
  return panelExport(dashboard, which);
}

/** The CSV file for a panel: `{ filename, body }` with a BOM and CRLF lines. */
export async function dashboardPanelCsv(
  ctx: Ctx,
  input: DashboardInput,
  panel: DashboardPanel,
  options: { today?: Date } = {},
): Promise<{ filename: string; body: string }> {
  const data = await exportDashboardPanel(ctx, input, panel, options);
  return { filename: data.filename, body: toCsv(data) };
}
