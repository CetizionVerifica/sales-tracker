import type { ProjectStatus } from '@sales-tracker/db';
import { DomainError } from '../errors.ts';

/**
 * Project: NOT_STARTED → IN_PROGRESS ⇄ ON_HOLD → COMPLETED | CANCELLED (M8 spec).
 * COMPLETED and CANCELLED are terminal in v1 (M8 Decisions 12 and 13). Who may make a move
 * (CANCELLED is admin-only) is checked in the service, not here.
 */
const TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  NOT_STARTED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED', 'CANCELLED'],
  ON_HOLD: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** Statuses where work is still open: the "Behind schedule" filter and M11 use these. */
export const ACTIVE_PROJECT_STATUSES: readonly ProjectStatus[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'ON_HOLD',
];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  ON_HOLD: 'On hold',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** The only field a completed or cancelled project still takes. */
export const CLOSED_PROJECT_EDITABLE: readonly string[] = ['description'];

export function isActiveProject(status: ProjectStatus): boolean {
  return ACTIVE_PROJECT_STATUSES.includes(status);
}

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Open, with a planned end before `today` (the calendar day in Asia/Kolkata). */
export function isBehindSchedule(
  project: { status: ProjectStatus; endDate: Date | null },
  today: Date,
): boolean {
  return isActiveProject(project.status) && !!project.endDate && project.endDate < today;
}

/**
 * Throws a DomainError (with the field to highlight) unless the move is allowed.
 * `input` carries values supplied with the action, which win over the stored ones; `today`
 * is the calendar day in Asia/Kolkata (passed in, so this stays pure).
 */
export function assertProjectTransition(
  project: { status: ProjectStatus; startDate: Date | null },
  to: ProjectStatus,
  input: {
    startDate?: Date | null | undefined;
    holdReason?: string | null | undefined;
    completedDate?: Date | null | undefined;
    cancelReason?: string | null | undefined;
    today: Date;
  },
): void {
  if (!canTransitionProject(project.status, to)) {
    throw new DomainError(
      `A project that is ${PROJECT_STATUS_LABELS[project.status].toLowerCase()} cannot be marked ${PROJECT_STATUS_LABELS[to].toLowerCase()}`,
    );
  }
  const startDate = input.startDate ?? project.startDate;
  if (to === 'IN_PROGRESS' || to === 'ON_HOLD') {
    if (!startDate) {
      throw new DomainError('Enter the start date', { field: 'startDate' });
    }
    if (startDate > input.today) {
      throw new DomainError('A started project cannot start in the future', {
        field: 'startDate',
      });
    }
  }
  if (to === 'ON_HOLD' && !input.holdReason?.trim()) {
    throw new DomainError('Say why the project is on hold', { field: 'holdReason' });
  }
  if (to === 'COMPLETED') {
    const completed = input.completedDate;
    if (!completed) {
      throw new DomainError('Enter the date the project was completed', {
        field: 'completedDate',
      });
    }
    if (completed > input.today) {
      throw new DomainError('The completed date cannot be in the future', {
        field: 'completedDate',
      });
    }
    if (startDate && completed < startDate) {
      throw new DomainError('A project cannot be completed before it started', {
        field: 'completedDate',
      });
    }
  }
  if (to === 'CANCELLED' && !input.cancelReason?.trim()) {
    throw new DomainError('Say why the project was cancelled', { field: 'cancelReason' });
  }
}
