import { expect } from 'vitest';
import type { Ctx } from '../context.ts';
import type { CreatePurchaseOrderInput } from '../schemas/purchase-order.ts';
import { createClient } from '../services/client.service.ts';
import { createPurchaseOrder } from '../services/purchase-order.service.ts';
import type { CreateProjectInput } from '../schemas/project.ts';
import { newProject, projectWorld, type ProjectWorld } from './project-fixtures.ts';

export interface PoWorld extends ProjectWorld {
  /** A second client, for "same PO number, different client". */
  globex: string;
}

/** The project world plus a second client. */
export async function poWorld(): Promise<PoWorld> {
  const w = await projectWorld();
  const globex = (await createClient(w.admin, { name: 'Globex Ltd', sectorId: w.pharma })).id;
  return { ...w, globex };
}

let counter = 0;

/** A PO number no other test has used. */
export const uniquePoNumber = () => `PO-${Date.now().toString(36)}-${++counter}`;

export const poInput = (
  w: ProjectWorld,
  projectId: string,
  overrides: Partial<CreatePurchaseOrderInput> = {},
): CreatePurchaseOrderInput => ({
  projectId,
  poNumber: uniquePoNumber(),
  receivedDate: '2026-04-02',
  amount: '1,00,000',
  currency: 'INR',
  serviceIds: [w.inspection, w.audit],
  ...overrides,
});

/**
 * A project (NOT_STARTED, managed by `pm`, revenue ₹1,25,000.50) with one PO created by its
 * Sales owner. `projectOverrides.managerId: ''` leaves the project unassigned.
 */
export async function newPurchaseOrder(
  w: PoWorld,
  overrides: Partial<CreatePurchaseOrderInput> = {},
  options: {
    projectOverrides?: Partial<CreateProjectInput>;
    owner?: Ctx;
    creator?: Ctx;
    clientId?: string;
  } = {},
) {
  const owner = options.owner ?? w.sales;
  const { enquiry, quotation, project } = await newProject(
    w,
    options.projectOverrides,
    owner,
    options.clientId ?? w.acme,
  );
  const { purchaseOrder, coverage } = await createPurchaseOrder(
    options.creator ?? owner,
    poInput(w, project.id, overrides),
  );
  expect(purchaseOrder.status).toBe('PENDING');
  return { enquiry, quotation, project, purchaseOrder, coverage };
}
