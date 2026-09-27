'use server';

import {
  changeProjectStatus,
  createProject,
  restoreProject,
  softDeleteProject,
  updateProject,
} from '@sales-tracker/core';
import {
  changeProjectStatusSchema,
  createProjectFormSchema,
  projectIdActionSchema,
  updateProjectActionSchema,
} from '@sales-tracker/core/schemas';
import { revalidatePath } from 'next/cache';
import { action } from '@/lib/action';

/** Results carry ids only, so no BigInt crosses the action boundary. */
function done<T>(value: T, project: { id: string; quotationId: string; clientId: string }): T {
  revalidatePath('/projects');
  revalidatePath(`/projects/${project.id}`);
  revalidatePath(`/quotations/${project.quotationId}`);
  revalidatePath(`/clients/${project.clientId}`);
  return value;
}

// The form schemas validate without converting the revenue, so the service parses the same
// input again and does the conversion to minor units itself.
export const createProjectAction = action(createProjectFormSchema, async (ctx, input) => {
  const project = await createProject(ctx, input);
  return done({ id: project.id }, project);
});

export const updateProjectAction = action(updateProjectActionSchema, async (ctx, { id, data }) => {
  const project = await updateProject(ctx, id, data);
  return done({ id }, project);
});

export const changeProjectStatusAction = action(changeProjectStatusSchema, async (ctx, input) => {
  const project = await changeProjectStatus(ctx, input);
  return done({ id: project.id }, project);
});

export const deleteProjectAction = action(projectIdActionSchema, async (ctx, { id }) => {
  const project = await softDeleteProject(ctx, id);
  return done({ id }, project);
});

export const restoreProjectAction = action(projectIdActionSchema, async (ctx, { id }) => {
  const project = await restoreProject(ctx, id);
  return done({ id }, project);
});
