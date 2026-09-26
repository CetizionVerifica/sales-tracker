import type { Ctx } from '@sales-tracker/core';

export const ROLE_LABELS: Record<Ctx['user']['role'], string> = {
  ADMIN: 'Admin',
  SALES: 'Sales',
  PROJECT_MANAGER: 'Project manager',
};
