import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import { DomainError } from '../errors.ts';
import {
  changeProjectStatus,
  createProject,
  getProject,
  updateProject,
} from '../services/project.service.ts';
import {
  newProject,
  projectInput,
  projectWorld,
  wonQuotation,
  type ProjectWorld,
} from './project-fixtures.ts';

const ROUNDS = 10;

describe('project database rules and races (integration)', () => {
  let w: ProjectWorld;

  beforeAll(async () => {
    w = await projectWorld();
  });
  afterAll(disconnectAll);

  // AC6 (database part): the CHECKs hold even for raw SQL.
  it('the database rejects rows that break the project rules, even via raw SQL', async () => {
    const { project } = await newProject(w);
    const raw = (sql: string) => getDb().$executeRawUnsafe(sql, project.id);
    await expect(raw(`UPDATE "project" SET status = 'IN_PROGRESS' WHERE id = $1`)).rejects.toThrow(
      /project_started_needs_start_date/,
    );
    await expect(
      raw(`UPDATE "project" SET status = 'ON_HOLD', "startDate" = '2026-04-01' WHERE id = $1`),
    ).rejects.toThrow(/project_on_hold_needs_reason/);
    await expect(raw(`UPDATE "project" SET status = 'CANCELLED' WHERE id = $1`)).rejects.toThrow(
      /project_cancelled_needs_reason/,
    );
    await expect(
      raw(
        `UPDATE "project" SET status = 'COMPLETED', "startDate" = '2026-04-01', "completedDate" = '2026-05-01' WHERE id = $1`,
      ),
    ).rejects.toThrow(/project_completed_needs_date/);
    await expect(
      raw(
        `UPDATE "project" SET status = 'COMPLETED', "startDate" = '2026-04-01', "completionPct" = 100 WHERE id = $1`,
      ),
    ).rejects.toThrow(/project_completed_needs_date/);
    await expect(raw(`UPDATE "project" SET "completionPct" = 101 WHERE id = $1`)).rejects.toThrow(
      /project_completion_range/,
    );
    await expect(
      raw(
        `UPDATE "project" SET "startDate" = '2026-05-02', "endDate" = '2026-05-01' WHERE id = $1`,
      ),
    ).rejects.toThrow(/project_end_after_start/);
    await expect(raw(`UPDATE "project" SET "revenueMinor" = -1 WHERE id = $1`)).rejects.toThrow(
      /project_revenue_non_negative/,
    );
    await expect(raw(`UPDATE "project" SET currency = 'inr' WHERE id = $1`)).rejects.toThrow(
      /project_currency_iso/,
    );
  });

  it('keeps the partial unique index on live projects per quotation', async () => {
    const [index] = await getDb().$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'project_live_quotation_key'`;
    expect(index?.indexdef).toMatch(/UNIQUE INDEX .* WHERE \("deletedAt" IS NULL\)/);
  });

  // AC13: races fail cleanly.
  it('lets exactly one of two racing creates on a quotation succeed', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { quotation } = await wonQuotation(w);
      const results = await Promise.allSettled([
        createProject(w.sales, projectInput(w, quotation.id)),
        createProject(w.admin, projectInput(w, quotation.id)),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      const reason = (failed[0] as PromiseRejectedResult).reason as unknown;
      expect(reason).toBeInstanceOf(DomainError);
      expect((reason as DomainError).message).toMatch(/already has a project/);
    }
  });

  it('never ends COMPLETED with a later hold or cancel written over it', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      for (const [loser, other] of [
        ['ON_HOLD', { holdReason: 'Wait' }],
        ['CANCELLED', { cancelReason: 'Gone' }],
      ] as const) {
        const { project } = await newProject(w);
        await changeProjectStatus(w.pm, {
          id: project.id,
          to: 'IN_PROGRESS',
          startDate: '2026-04-10',
        });
        const results = await Promise.allSettled([
          changeProjectStatus(w.admin, {
            id: project.id,
            to: 'COMPLETED',
            completedDate: '2026-05-01',
          }),
          changeProjectStatus(w.admin, { id: project.id, to: loser, ...other } as never),
        ]);
        // Both writes are guarded on the status they read: exactly one wins, and nothing
        // lands after COMPLETED.
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const final = await getProject(w.admin, project.id);
        if (results[0].status === 'fulfilled') {
          expect(final).toMatchObject({ status: 'COMPLETED', completionPct: 100 });
        } else {
          expect(final.status).toBe(loser);
        }
      }
    }
  });

  it('fails the old PM’s change when a reassignment commits first', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { project } = await newProject(w);
      const results = await Promise.allSettled([
        updateProject(w.admin, project.id, { managerId: w.pm2.user.id }),
        updateProject(w.pm, project.id, { completionPct: 50 }),
      ]);
      expect(results[0].status).toBe('fulfilled');
      const final = await getProject(w.admin, project.id);
      expect(final.managerId).toBe(w.pm2.user.id);
      if (results[1].status === 'fulfilled') {
        // The PM's update ran before the reassignment committed.
        expect(final.completionPct).toBe(50);
      } else {
        expect(final.completionPct).toBe(0);
      }
    }
  });
});
