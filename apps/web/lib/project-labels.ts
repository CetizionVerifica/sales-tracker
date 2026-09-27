import type { ProjectStatusValue } from '@sales-tracker/core/schemas';

export const PROJECT_STATUS_LABELS: Record<ProjectStatusValue, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  ON_HOLD: 'On hold',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** Open projects still take status moves and progress updates (M8 status machine). */
export const isOpenProject = (status: ProjectStatusValue) =>
  status === 'NOT_STARTED' || status === 'IN_PROGRESS' || status === 'ON_HOLD';
