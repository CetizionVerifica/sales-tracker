import type { ProjectStatus } from '@sales-tracker/db';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../errors.ts';
import {
  assertProjectTransition,
  canTransitionProject,
  isBehindSchedule,
} from '../../status/project.ts';

const STATUSES: ProjectStatus[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'ON_HOLD',
  'COMPLETED',
  'CANCELLED',
];
const ALLOWED = new Set([
  'NOT_STARTED→IN_PROGRESS',
  'NOT_STARTED→ON_HOLD',
  'IN_PROGRESS→ON_HOLD',
  'ON_HOLD→IN_PROGRESS',
  'IN_PROGRESS→COMPLETED',
  'ON_HOLD→COMPLETED',
  'NOT_STARTED→CANCELLED',
  'IN_PROGRESS→CANCELLED',
  'ON_HOLD→CANCELLED',
]);

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const today = day('2026-09-27');

const project = (status: ProjectStatus, startDate: Date | null = day('2026-05-01')) => ({
  status,
  startDate: status === 'NOT_STARTED' ? null : startDate,
});

/** Everything any move could need, so only the move itself decides. */
const full = {
  startDate: day('2026-05-01'),
  holdReason: 'Client site closed',
  completedDate: day('2026-09-01'),
  cancelReason: 'Client withdrew',
  today,
};

function fieldOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return (error as DomainError).field ?? 'none';
  }
  return undefined;
}

// AC6: every pair of the five statuses; only the nine moves are allowed.
describe('AC6: project status machine', () => {
  const pairs = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const));

  it.each(pairs)('%s → %s', (from, to) => {
    expect(canTransitionProject(from, to)).toBe(ALLOWED.has(`${from}→${to}`));
  });

  it.each(pairs.filter(([from, to]) => !ALLOWED.has(`${from}→${to}`)))(
    'assertProjectTransition rejects %s → %s',
    (from, to) => {
      expect(() => assertProjectTransition(project(from), to, full)).toThrow(DomainError);
    },
  );

  it.each(pairs.filter(([from, to]) => ALLOWED.has(`${from}→${to}`)))(
    'assertProjectTransition allows %s → %s with the values it needs',
    (from, to) => {
      expect(() => assertProjectTransition(project(from), to, full)).not.toThrow();
    },
  );

  it('starting needs a start date, stored or supplied, not in the future', () => {
    expect(
      fieldOf(() => assertProjectTransition(project('NOT_STARTED'), 'IN_PROGRESS', { today })),
    ).toBe('startDate');
    expect(
      fieldOf(() =>
        assertProjectTransition(project('NOT_STARTED'), 'IN_PROGRESS', {
          startDate: day('2026-09-28'),
          today,
        }),
      ),
    ).toBe('startDate');
    // Resuming uses the stored start date.
    expect(
      fieldOf(() => assertProjectTransition(project('ON_HOLD'), 'IN_PROGRESS', { today })),
    ).toBeUndefined();
  });

  it('holding needs a reason, and a start date when not yet started', () => {
    expect(
      fieldOf(() => assertProjectTransition(project('IN_PROGRESS'), 'ON_HOLD', { today })),
    ).toBe('holdReason');
    expect(
      fieldOf(() =>
        assertProjectTransition(project('IN_PROGRESS'), 'ON_HOLD', { holdReason: '  ', today }),
      ),
    ).toBe('holdReason');
    expect(
      fieldOf(() =>
        assertProjectTransition(project('NOT_STARTED'), 'ON_HOLD', { holdReason: 'Wait', today }),
      ),
    ).toBe('startDate');
  });

  it('completing needs a completed date, not in the future and not before the start', () => {
    const inProgress = project('IN_PROGRESS');
    expect(fieldOf(() => assertProjectTransition(inProgress, 'COMPLETED', { today }))).toBe(
      'completedDate',
    );
    expect(
      fieldOf(() =>
        assertProjectTransition(inProgress, 'COMPLETED', {
          completedDate: day('2026-09-28'),
          today,
        }),
      ),
    ).toBe('completedDate');
    expect(
      fieldOf(() =>
        assertProjectTransition(inProgress, 'COMPLETED', {
          completedDate: day('2026-04-30'),
          today,
        }),
      ),
    ).toBe('completedDate');
  });

  it('cancelling needs a reason', () => {
    expect(
      fieldOf(() => assertProjectTransition(project('IN_PROGRESS'), 'CANCELLED', { today })),
    ).toBe('cancelReason');
  });
});

describe('isBehindSchedule', () => {
  it('is true for an open project whose planned end has passed (IST today)', () => {
    expect(isBehindSchedule({ status: 'IN_PROGRESS', endDate: day('2026-09-26') }, today)).toBe(
      true,
    );
    expect(isBehindSchedule({ status: 'ON_HOLD', endDate: day('2026-09-26') }, today)).toBe(true);
    expect(isBehindSchedule({ status: 'IN_PROGRESS', endDate: today }, today)).toBe(false);
    expect(isBehindSchedule({ status: 'IN_PROGRESS', endDate: null }, today)).toBe(false);
    expect(isBehindSchedule({ status: 'COMPLETED', endDate: day('2026-01-01') }, today)).toBe(
      false,
    );
    expect(isBehindSchedule({ status: 'CANCELLED', endDate: day('2026-01-01') }, today)).toBe(
      false,
    );
  });
});
