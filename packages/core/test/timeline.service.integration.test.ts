import { randomUUID } from 'node:crypto';
import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { NotFoundError } from '../errors.ts';
import { todayInIST, toCalendarDateString } from '../schemas/common.ts';
import type { TimelineEvent } from '../services/timeline.service.ts';
import { createClient, softDeleteClient } from '../services/client.service.ts';
import {
  convertEnquiry,
  createEnquiry,
  markEnquiryLost,
  softDeleteEnquiry,
} from '../services/enquiry.service.ts';
import { logFollowUp } from '../services/follow-up.service.ts';
import { createSector } from '../services/sector.service.ts';
import { createService } from '../services/service.service.ts';
import { getClientTimeline } from '../services/timeline.service.ts';
import { actor, createTestUser, ctxFor } from './helpers.ts';

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

const daysAgo = (days: number) =>
  toCalendarDateString(new Date(todayInIST().getTime() - days * 86_400_000));

/** All events, following the cursor. */
async function allEvents(ctx: Ctx, clientId: string, extra: object = {}, limit = 50) {
  const events: TimelineEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await getClientTimeline(ctx, { clientId, limit, cursor, ...extra });
    events.push(...result.items);
    if (!result.nextCursor) return events;
    cursor = result.nextCursor;
  }
  throw new Error('cursor did not terminate');
}

describe('client timeline (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let sales2: Ctx;
  let sectorId: string;
  let serviceId: string;
  let n = 0;

  const newClient = async () => {
    n += 1;
    return (await createClient(admin, { name: `Timeline client ${n}`, sectorId })).id;
  };

  const newEnquiry = async (owner: Ctx, clientId: string) =>
    createEnquiry(owner, {
      clientId,
      sectorId,
      serviceIds: [serviceId],
      receivedDate: daysAgo(5),
      source: 'EMAIL',
    });

  beforeAll(async () => {
    await resetDb(getDb());
    const user = async (email: string, role: 'ADMIN' | 'SALES') =>
      ctxFor(actor(role, { id: (await createTestUser(email, role)).id }));
    admin = await user('admin@example.test', 'ADMIN');
    sales = await user('sales@example.test', 'SALES');
    sales2 = await user('sales2@example.test', 'SALES');
    sectorId = (await createSector(admin, { name: 'Pharma' })).id;
    serviceId = (await createService(admin, { name: 'Inspection' })).id;
  });
  afterAll(disconnectAll);

  it('AC6: shows follow-ups, creation and status changes in date order', async () => {
    const clientId = await newClient();
    const backdated = await logFollowUp(sales, {
      entityType: 'CLIENT',
      entityId: clientId,
      date: daysAgo(2),
      channel: 'CALL',
      notes: 'Intro call',
    });
    const note = await logFollowUp(sales, {
      entityType: 'CLIENT',
      entityId: clientId,
      date: daysAgo(1),
      channel: 'WHATSAPP',
      notes: 'Shared brochure',
    });
    const enquiry = await newEnquiry(sales, clientId);
    const email = await logFollowUp(sales, {
      entityType: 'ENQUIRY',
      entityId: enquiry.id,
      date: daysAgo(0),
      channel: 'EMAIL',
      notes: 'Sent proposal',
      nextFollowUpDate: daysAgo(-7),
    });
    await convertEnquiry(sales, { id: enquiry.id, proposalSentDate: daysAgo(0) });

    const { items, nextCursor } = await getClientTimeline(sales, { clientId });
    expect(nextCursor).toBeNull();
    expect(items.map((e) => [e.kind, e.day])).toEqual([
      ['STATUS_CHANGE', daysAgo(0)],
      ['FOLLOW_UP', daysAgo(0)],
      ['CREATED', daysAgo(0)],
      ['FOLLOW_UP', daysAgo(1)],
      ['FOLLOW_UP', daysAgo(2)],
    ]);

    const [conversion, emailEvent, created, noteEvent, callEvent] = items;
    expect(conversion).toMatchObject({
      actor: { id: sales.user.id },
      entity: { type: 'ENQUIRY', id: enquiry.id, label: enquiry.number, deleted: false },
      change: { from: 'IN_PROGRESS', to: 'CONVERTED' },
    });
    expect(emailEvent).toMatchObject({
      id: email.id,
      followUp: { channel: 'EMAIL', notes: 'Sent proposal' },
      entity: { type: 'ENQUIRY', label: enquiry.number },
    });
    expect(created).toMatchObject({ entity: { id: enquiry.id } });
    expect(noteEvent).toMatchObject({
      id: note.id,
      entity: { type: 'CLIENT', id: clientId, label: `Timeline client ${n}` },
    });
    expect(callEvent!.id).toBe(backdated.id);
    // Only whitelisted fields leave the service, never raw audit JSON.
    expect(JSON.stringify(items)).not.toContain('"before"');
  });

  it('shows the lost reason on a lost status change', async () => {
    const clientId = await newClient();
    const enquiry = await newEnquiry(sales, clientId);
    await markEnquiryLost(sales, { id: enquiry.id, lostReason: 'Price too high' });
    const { items } = await getClientTimeline(sales, { clientId, kinds: ['STATUS_CHANGE'] });
    expect(items).toHaveLength(1);
    expect(items[0]!.change).toEqual({
      from: 'IN_PROGRESS',
      to: 'LOST',
      lostReason: 'Price too high',
    });
  });

  it('AC7: each user sees only the records they can read', async () => {
    const clientId = await newClient();
    const mine = await newEnquiry(sales, clientId);
    const theirs = await newEnquiry(sales2, clientId);
    const myNote = await logFollowUp(sales, {
      entityType: 'ENQUIRY',
      entityId: mine.id,
      date: daysAgo(0),
      channel: 'CALL',
      notes: 'mine',
    });
    const theirNote = await logFollowUp(sales2, {
      entityType: 'ENQUIRY',
      entityId: theirs.id,
      date: daysAgo(0),
      channel: 'CALL',
      notes: 'theirs',
    });
    const shared = await logFollowUp(sales2, {
      entityType: 'CLIENT',
      entityId: clientId,
      date: daysAgo(0),
      channel: 'MEETING',
      notes: 'client-level',
    });
    // An admin converts sales's enquiry: sales must see it, although it is not their change.
    await convertEnquiry(admin, { id: mine.id, proposalSentDate: daysAgo(0) });

    const salesEvents = await allEvents(sales, clientId);
    const salesIds = salesEvents.map((e) => e.id);
    expect(salesIds).toEqual(expect.arrayContaining([myNote.id, shared.id]));
    expect(salesIds).not.toContain(theirNote.id);
    expect(salesEvents.some((e) => e.entity.id === theirs.id)).toBe(false);
    expect(
      salesEvents.find((e) => e.kind === 'STATUS_CHANGE' && e.entity.id === mine.id)?.actor.id,
    ).toBe(admin.user.id);

    const adminEvents = await allEvents(admin, clientId);
    expect(adminEvents.map((e) => e.id)).toEqual(
      expect.arrayContaining([myNote.id, theirNote.id, shared.id]),
    );
    expect(adminEvents.filter((e) => e.kind === 'CREATED')).toHaveLength(2);
  });

  it('AC8: pages through 120 events exactly once, in order, with ties', async () => {
    const clientId = await newClient();
    const enquiry = await newEnquiry(sales, clientId);
    const db = getDb();

    // 60 follow-ups over 6 days; within each day 5 share one createdAt (ties on day and at).
    for (let i = 0; i < 60; i += 1) {
      const day = daysAgo(10 + (i % 6));
      const at = new Date(`${day}T06:00:00.000Z`);
      if (i % 2 === 1) at.setUTCMinutes(i);
      await db.$executeRawUnsafe(
        `INSERT INTO "follow_up" ("id","clientId","userId","entityType","entityId","date","channel","notes","createdAt","updatedAt")
         VALUES ($1,$2,$3,'ENQUIRY',$4,$5::date,'CALL',$6,$7,$7)`,
        randomUUID(),
        clientId,
        sales.user.id,
        enquiry.id,
        day,
        `note ${i}`,
        at,
      );
    }
    // 59 status-change audit rows (plus the real CREATE = 60 audit events), with shared
    // timestamps that also coincide with follow-up timestamps.
    for (let i = 0; i < 59; i += 1) {
      const day = daysAgo(10 + (i % 7));
      const at = new Date(`${day}T06:00:00.000Z`);
      if (i % 3 === 0) at.setUTCMinutes(i % 10);
      await db.$executeRawUnsafe(
        `INSERT INTO "audit_log" ("id","actorId","action","source","entityType","entityId","before","after","changedFields","requestId","createdAt")
         VALUES ($1,$2,'UPDATE','web','Enquiry',$3,$4::jsonb,$5::jsonb,ARRAY['status'],$6,$7)`,
        randomUUID(),
        sales.user.id,
        enquiry.id,
        JSON.stringify({ status: 'IN_PROGRESS' }),
        JSON.stringify({ status: 'IN_PROGRESS' }),
        randomUUID(),
        at,
      );
    }

    const pages: number[] = [];
    const events: TimelineEvent[] = [];
    let cursor: string | undefined;
    do {
      const result = await getClientTimeline(sales, { clientId, limit: 50, cursor });
      pages.push(result.items.length);
      events.push(...result.items);
      cursor = result.nextCursor ?? undefined;
    } while (cursor);

    expect(pages).toEqual([50, 50, 20]);
    expect(new Set(events.map((e) => e.id)).size).toBe(120);
    for (let i = 1; i < events.length; i += 1) {
      const [prev, next] = [events[i - 1]!, events[i]!];
      const inOrder =
        prev.day > next.day || (prev.day === next.day && prev.at.getTime() >= next.at.getTime());
      expect(inOrder, `event ${i} out of order`).toBe(true);
    }

    // The same sequence with a different page size.
    const bySeven = await allEvents(sales, clientId, {}, 7);
    expect(bySeven.map((e) => e.id)).toEqual(events.map((e) => e.id));

    const followUpsOnly = await allEvents(sales, clientId, { kinds: ['FOLLOW_UP'] });
    expect(followUpsOnly).toHaveLength(60);
    const onEnquiry = await allEvents(sales, clientId, {
      entityType: 'ENQUIRY',
      entityId: enquiry.id,
      kinds: ['CREATED'],
    });
    expect(onEnquiry).toHaveLength(1);
  });

  it('places an audit event by its IST day, not its UTC day', async () => {
    const clientId = await newClient();
    const enquiry = await newEnquiry(sales, clientId);
    // 00:15 IST on 2026-03-10 is 18:45 UTC on 2026-03-09.
    await getDb().$executeRawUnsafe(
      `INSERT INTO "audit_log" ("id","actorId","action","source","entityType","entityId","before","after","changedFields","requestId","createdAt")
       VALUES ($1,$2,'UPDATE','web','Enquiry',$3,'{"status":"IN_PROGRESS"}','{"status":"LOST","lostReason":"x"}',ARRAY['status','lostReason'],$4,'2026-03-09T18:45:00Z')`,
      randomUUID(),
      sales.user.id,
      enquiry.id,
      randomUUID(),
    );
    // Back-dated to 9 March but saved later (now): sorts below the 10 March change.
    await logFollowUp(sales, {
      entityType: 'ENQUIRY',
      entityId: enquiry.id,
      date: '2026-03-09',
      channel: 'CALL',
      notes: 'Late entry',
    });

    const events = await allEvents(sales, clientId, {}, 1);
    const tail = events.slice(-2).map((e) => [e.kind, e.day]);
    expect(tail).toEqual([
      ['STATUS_CHANGE', '2026-03-10'],
      ['FOLLOW_UP', '2026-03-09'],
    ]);
  });

  it('AC11: keeps events of a soft-deleted enquiry, marked deleted', async () => {
    const clientId = await newClient();
    const enquiry = await newEnquiry(sales, clientId);
    const followUp = await logFollowUp(sales, {
      entityType: 'ENQUIRY',
      entityId: enquiry.id,
      date: daysAgo(0),
      channel: 'CALL',
      notes: 'before deletion',
    });
    await softDeleteEnquiry(sales, enquiry.id);

    const events = await allEvents(sales, clientId);
    expect(events.map((e) => e.kind)).toEqual(['DELETED', 'FOLLOW_UP', 'CREATED']);
    expect(events.find((e) => e.id === followUp.id)?.entity).toMatchObject({
      label: enquiry.number,
      deleted: true,
    });
    expect(await allEvents(sales2, clientId)).toEqual([]);
  });

  it('a deleted client’s timeline is for admins only', async () => {
    const clientId = await newClient();
    await softDeleteClient(admin, clientId);
    expect(await rejection(getClientTimeline(sales, { clientId }))).toBeInstanceOf(NotFoundError);
    expect((await getClientTimeline(admin, { clientId })).items).toEqual([]);
  });
});
