import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { setDocumentDeps } from '../extraction/deps.ts';
import { createMockExtractor } from '../extraction/mock.ts';
import { closeDocumentsQueue, getDocumentsQueue } from '../extraction/queue.ts';
import { ForbiddenError, NotFoundError } from '../errors.ts';
import type { CreateFollowUpInput } from '../schemas/follow-up.ts';
import {
  confirmExtraction,
  getDocument,
  listDocuments,
  softDeleteDocument,
  uploadDocument,
} from '../services/document.service.ts';
import {
  getEnquiry,
  listEnquiries,
  softDeleteEnquiry,
  updateEnquiry,
} from '../services/enquiry.service.ts';
import { listFollowUps, logFollowUp } from '../services/follow-up.service.ts';
import { softDeleteProject } from '../services/project.service.ts';
import { getQuotation, listQuotations, updateQuotation } from '../services/quotation.service.ts';
import { createMemoryFileStore } from '../storage/memory.ts';
import { samplePdf } from './documents/files.ts';
import { newProject, projectWorld, rejection, type ProjectWorld } from './project-fixtures.ts';

const followUpOn = (
  entityType: CreateFollowUpInput['entityType'],
  entityId: string,
): CreateFollowUpInput => ({
  entityType,
  entityId,
  date: '2026-04-15',
  channel: 'CALL',
  notes: `Note on ${entityType}`,
});

// AC5: a PM reaches the enquiry, quotation, follow-ups and document behind their project,
// read only; nothing behind someone else's project or a deleted one.
describe('project managers’ reach into the pipeline (integration)', () => {
  let w: ProjectWorld;
  let pm: Ctx;
  let pm2: Ctx;
  let sales: Ctx;
  let admin: Ctx;
  let files = 0;
  const pdf = () => ({
    bytes: samplePdf(`rbac ${++files}`),
    mimeType: 'application/pdf',
    filename: 'quote.pdf',
  });

  beforeAll(async () => {
    w = await projectWorld();
    ({ pm, pm2, sales, admin } = w);
    setDocumentDeps({ extractor: createMockExtractor(), fileStore: createMemoryFileStore() });
    await getDocumentsQueue().obliterate({ force: true });
  });
  afterAll(async () => {
    await closeDocumentsQueue();
    await disconnectAll();
  });

  it('reads the enquiry and quotation behind their project, and lists them', async () => {
    const { enquiry, quotation } = await newProject(w);
    expect((await getEnquiry(pm, enquiry.id)).id).toBe(enquiry.id);
    expect((await getQuotation(pm, quotation.id)).id).toBe(quotation.id);
    expect((await listEnquiries(pm, { pageSize: 100 })).items.map((e) => e.id)).toContain(
      enquiry.id,
    );
    expect((await listQuotations(pm, { pageSize: 100 })).items.map((q) => q.id)).toContain(
      quotation.id,
    );
  });

  it('cannot change the enquiry or quotation', async () => {
    const { enquiry, quotation } = await newProject(w);
    expect(await rejection(updateEnquiry(pm, enquiry.id, { description: 'x' }))).toBeInstanceOf(
      ForbiddenError,
    );
    expect(await rejection(softDeleteEnquiry(pm, enquiry.id))).toBeInstanceOf(ForbiddenError);
    expect(await rejection(updateQuotation(pm, quotation.id, { description: 'x' }))).toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('sees and logs follow-ups on the project, quotation and enquiry', async () => {
    const { enquiry, quotation, project } = await newProject(w);
    const bySales = await logFollowUp(sales, followUpOn('QUOTATION', quotation.id));
    const onProject = await logFollowUp(pm, followUpOn('PROJECT', project.id));
    const onEnquiry = await logFollowUp(pm, followUpOn('ENQUIRY', enquiry.id));

    const visible = (await listFollowUps(pm, { clientId: w.acme, pageSize: 100 })).items.map(
      (f) => f.id,
    );
    expect(visible).toEqual(expect.arrayContaining([bySales.id, onProject.id, onEnquiry.id]));

    const other = (await listFollowUps(pm2, { clientId: w.acme, pageSize: 100 })).items.map(
      (f) => f.id,
    );
    expect(other).not.toContain(bySales.id);
    expect(other).not.toContain(onProject.id);
    expect(await rejection(logFollowUp(pm2, followUpOn('PROJECT', project.id)))).toBeInstanceOf(
      NotFoundError,
    );
  });

  it('views the quotation document but cannot upload, confirm or delete it', async () => {
    const { quotation } = await newProject(w);
    const doc = await uploadDocument(sales, { kind: 'QUOTATION', entityId: quotation.id }, pdf());
    expect((await getDocument(pm, doc.id)).id).toBe(doc.id);
    expect((await listDocuments(pm, { pageSize: 100 })).items.map((d) => d.id)).toContain(doc.id);

    expect(
      await rejection(uploadDocument(pm, { kind: 'QUOTATION', entityId: quotation.id }, pdf())),
    ).toBeInstanceOf(ForbiddenError);
    expect(
      await rejection(confirmExtraction(pm, { documentId: doc.id, apply: {} })),
    ).toBeInstanceOf(ForbiddenError);
    expect(await rejection(softDeleteDocument(pm, doc.id))).toBeInstanceOf(ForbiddenError);
    expect(await rejection(getDocument(pm2, doc.id))).toBeInstanceOf(NotFoundError);
  });

  it('sees nothing behind another PM’s project, an unassigned one, or a deleted one', async () => {
    const other = await newProject(w, { managerId: pm2.user.id });
    const unassigned = await newProject(w, { managerId: '' });
    const deleted = await newProject(w);
    await softDeleteProject(admin, deleted.project.id);

    for (const { enquiry, quotation } of [other, unassigned, deleted]) {
      expect(await rejection(getEnquiry(pm, enquiry.id))).toBeInstanceOf(NotFoundError);
      expect(await rejection(getQuotation(pm, quotation.id))).toBeInstanceOf(NotFoundError);
      expect(
        await rejection(logFollowUp(pm, followUpOn('QUOTATION', quotation.id))),
      ).toBeInstanceOf(NotFoundError);
    }
    const listed = (await listQuotations(pm, { pageSize: 100 })).items.map((q) => q.id);
    for (const { quotation } of [other, unassigned, deleted]) {
      expect(listed).not.toContain(quotation.id);
    }
  });
});
