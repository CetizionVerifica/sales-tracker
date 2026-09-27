import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { logFollowUp } from '../services/follow-up.service.ts';
import { changeProjectStatus } from '../services/project.service.ts';
import { getClientTimeline } from '../services/timeline.service.ts';
import { newProject, projectWorld, type ProjectWorld } from './project-fixtures.ts';

// AC9: follow-ups on projects, and project events on the client timeline.
describe('project follow-ups and timeline (integration)', () => {
  let w: ProjectWorld;

  beforeAll(async () => {
    w = await projectWorld();
  });
  afterAll(disconnectAll);

  const timeline = async (ctx: Ctx) =>
    (await getClientTimeline(ctx, { clientId: w.acme, limit: 100 })).items;

  it('shows the PM’s follow-up and the project’s history to those who can read it', async () => {
    const { project } = await newProject(w);
    const followUp = await logFollowUp(w.pm, {
      entityType: 'PROJECT',
      entityId: project.id,
      date: '2026-04-15',
      channel: 'MEETING',
      notes: 'Kick-off on site',
    });
    await changeProjectStatus(w.pm, { id: project.id, to: 'IN_PROGRESS', startDate: '2026-04-10' });
    await changeProjectStatus(w.pm, { id: project.id, to: 'ON_HOLD', holdReason: 'Site closed' });
    await changeProjectStatus(w.pm, {
      id: project.id,
      to: 'COMPLETED',
      completedDate: '2026-05-01',
    });
    const { project: cancelled } = await newProject(w);
    await changeProjectStatus(w.admin, {
      id: cancelled.id,
      to: 'CANCELLED',
      cancelReason: 'Client withdrew',
    });

    for (const ctx of [w.pm, w.sales, w.admin]) {
      const items = await timeline(ctx);
      expect(items.find((e) => e.id === followUp.id)?.entity).toMatchObject({
        type: 'PROJECT',
        id: project.id,
        label: `${project.number} · ${project.name}`,
      });
      const changes = items
        .filter((e) => e.entity.id === project.id && e.kind === 'STATUS_CHANGE')
        .map((e) => e.change)
        .reverse(); // oldest first
      expect(changes).toEqual([
        { from: 'NOT_STARTED', to: 'IN_PROGRESS' },
        { from: 'IN_PROGRESS', to: 'ON_HOLD', holdReason: 'Site closed' },
        { from: 'ON_HOLD', to: 'COMPLETED', completedDate: '2026-05-01' },
      ]);
      expect(items.some((e) => e.entity.id === project.id && e.kind === 'CREATED')).toBe(true);
      // Revenue never reaches the timeline.
      expect(JSON.stringify(items)).not.toContain('12500050');
    }
    // The PM only manages the first project; the cancelled one is visible to Sales and admins.
    const cancelEvent = (await timeline(w.admin)).find(
      (e) => e.entity.id === cancelled.id && e.kind === 'STATUS_CHANGE',
    );
    expect(cancelEvent?.change).toEqual({
      from: 'NOT_STARTED',
      to: 'CANCELLED',
      cancelReason: 'Client withdrew',
    });

    const other = await timeline(w.pm2);
    expect(other.some((e) => e.id === followUp.id)).toBe(false);
    expect(other.some((e) => e.entity.id === project.id)).toBe(false);
  });

  it('orders project events among quotation events', async () => {
    const { quotation, project } = await newProject(w);
    const items = (await timeline(w.sales)).filter(
      (e) => e.entity.id === quotation.id || e.entity.id === project.id,
    );
    const kinds = items.map((e) => `${e.entity.type}:${e.kind}`).reverse();
    expect(kinds.indexOf('QUOTATION:CREATED')).toBeLessThan(kinds.indexOf('PROJECT:CREATED'));
    expect(kinds.indexOf('QUOTATION:STATUS_CHANGE')).toBeLessThan(kinds.indexOf('PROJECT:CREATED'));
  });
});
