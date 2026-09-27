import type { EnquirySourceValue } from '../schemas/enquiry.ts';
import { todayInIST, toCalendarDateString } from '../schemas/common.ts';
import type { FollowUpChannelValue } from '../schemas/follow-up.ts';
import { getDb, type Db } from '../clients.ts';
import { systemCtx, withTx, type Ctx } from '../context.ts';
import { createClient } from '../services/client.service.ts';
import { convertEnquiry, createEnquiry, markEnquiryLost } from '../services/enquiry.service.ts';
import { logFollowUp } from '../services/follow-up.service.ts';

/** Dev-only sample clients, created when there are none. */
const SAMPLE_CLIENTS = [
  { name: 'Acme Pharma', sector: 'Pharma' },
  { name: 'Bharat Steel Works', sector: 'Manufacturing' },
  { name: 'Coastal Infra Projects', sector: 'Infrastructure' },
] as const;

type ClientName = (typeof SAMPLE_CLIENTS)[number]['name'];

interface SampleEnquiry {
  client: ClientName;
  services: string[];
  owner: 'sales@example.com' | 'sales2@example.com';
  receivedDaysAgo: number;
  proposalDaysAgo?: number;
  source: EnquirySourceValue;
  sourceDetail?: string;
  description?: string;
  outcome?: 'CONVERTED' | { lostReason: string };
  followUps?: SampleFollowUp[];
}

/** Days are relative to today; a negative `nextInDays` is a missed follow-up (M11). */
interface SampleFollowUp {
  daysAgo: number;
  channel: FollowUpChannelValue;
  notes: string;
  nextInDays?: number;
}

/**
 * Every status and every source, with received dates relative to today so some are
 * older than 30 days (M11's "stale enquiries").
 */
const SAMPLE_ENQUIRIES: SampleEnquiry[] = [
  {
    client: 'Acme Pharma',
    services: ['Inspection', 'Audit'],
    owner: 'sales@example.com',
    receivedDaysAgo: 3,
    source: 'EMAIL',
    description: 'Annual GMP audit and plant inspection',
    followUps: [
      { daysAgo: 2, channel: 'CALL', notes: 'Clarified audit scope with QA head', nextInDays: 0 },
    ],
  },
  {
    client: 'Bharat Steel Works',
    services: ['Certification'],
    owner: 'sales@example.com',
    receivedDaysAgo: 40,
    source: 'TENDER_PORTAL',
    sourceDetail: 'GeM GEM/2026/B/1001',
    followUps: [
      { daysAgo: 38, channel: 'SITE_VISIT', notes: 'Pre-bid site visit', nextInDays: -30 },
      { daysAgo: 20, channel: 'EMAIL', notes: 'Asked portal for bid extension', nextInDays: -5 },
    ],
  },
  {
    client: 'Coastal Infra Projects',
    services: ['Inspection'],
    owner: 'sales@example.com',
    receivedDaysAgo: 20,
    proposalDaysAgo: 12,
    source: 'PHONE',
    followUps: [
      { daysAgo: 12, channel: 'EMAIL', notes: 'Sent proposal', nextInDays: -2 },
      { daysAgo: 6, channel: 'CALL', notes: 'Client reviewing internally', nextInDays: 4 },
    ],
  },
  {
    client: 'Acme Pharma',
    services: ['Training'],
    owner: 'sales@example.com',
    receivedDaysAgo: 60,
    proposalDaysAgo: 50,
    source: 'REFERRAL',
    sourceDetail: 'Referred by Anil Kumar',
    outcome: 'CONVERTED',
    followUps: [{ daysAgo: 55, channel: 'MEETING', notes: 'Kick-off meeting with training team' }],
  },
  {
    client: 'Bharat Steel Works',
    services: ['Audit'],
    owner: 'sales@example.com',
    receivedDaysAgo: 90,
    source: 'WEBSITE',
    outcome: { lostReason: 'Chose a local vendor' },
  },
  {
    client: 'Coastal Infra Projects',
    services: ['Certification', 'Audit'],
    owner: 'sales2@example.com',
    receivedDaysAgo: 10,
    source: 'WALK_IN',
    followUps: [
      { daysAgo: 9, channel: 'WHATSAPP', notes: 'Shared certification checklist', nextInDays: 3 },
    ],
  },
  {
    client: 'Acme Pharma',
    services: ['Inspection'],
    owner: 'sales2@example.com',
    receivedDaysAgo: 120,
    proposalDaysAgo: 100,
    source: 'OTHER',
    sourceDetail: 'Trade fair, Mumbai',
    outcome: 'CONVERTED',
  },
  {
    client: 'Bharat Steel Works',
    services: ['Inspection', 'Certification'],
    owner: 'sales2@example.com',
    receivedDaysAgo: 35,
    source: 'EMAIL',
    followUps: [
      { daysAgo: 30, channel: 'OTHER', notes: 'Met at industry association event', nextInDays: -1 },
    ],
  },
];

/** Client-level notes (not tied to an enquiry), by the first sales user. */
const SAMPLE_CLIENT_NOTES: { client: ClientName; followUp: SampleFollowUp }[] = [
  {
    client: 'Acme Pharma',
    followUp: { daysAgo: 15, channel: 'MEETING', notes: 'Annual relationship review' },
  },
  {
    client: 'Bharat Steel Works',
    followUp: { daysAgo: 4, channel: 'CALL', notes: 'New plant head joined', nextInDays: 10 },
  },
  {
    client: 'Coastal Infra Projects',
    followUp: { daysAgo: 1, channel: 'EMAIL', notes: 'Sent company profile', nextInDays: 14 },
  },
];

const daysAgo = (days: number) =>
  toCalendarDateString(new Date(todayInIST().getTime() - days * 86_400_000));

/** The sample's follow-up as its author: the enquiry owner, audited as `system`. */
async function logSample(
  author: { id: string; role: Ctx['user']['role'] },
  link: { entityType: 'CLIENT' | 'ENQUIRY'; entityId: string },
  { daysAgo: ago, nextInDays, ...fields }: SampleFollowUp,
) {
  const ctx: Ctx = { user: { ...author, active: true }, source: 'system' };
  await logFollowUp(ctx, {
    ...link,
    ...fields,
    date: daysAgo(ago),
    ...(nextInDays !== undefined && { nextFollowUpDate: daysAgo(-nextInDays) }),
  });
}

/**
 * M5 sample follow-ups, attached to the sample enquiries found by (client, owner, source),
 * which is unique among them. Samples a developer has since deleted are skipped. Runs
 * inside the caller's transaction.
 */
async function addSampleFollowUps(tx: Db): Promise<number> {
  const user = async (email: string) => {
    const row = await tx.user.findUnique({ where: { email }, select: { id: true, role: true } });
    if (!row) throw new Error(`Dev user ${email} is missing`);
    return row;
  };
  let count = 0;
  for (const sample of SAMPLE_ENQUIRIES) {
    if (!sample.followUps) continue;
    const owner = await user(sample.owner);
    const enquiry = await tx.enquiry.findFirst({
      where: { ownerId: owner.id, source: sample.source, client: { name: sample.client } },
      select: { id: true },
    });
    if (!enquiry) continue;
    for (const followUp of sample.followUps) {
      await logSample(owner, { entityType: 'ENQUIRY', entityId: enquiry.id }, followUp);
      count += 1;
    }
  }
  const author = await user('sales@example.com');
  for (const note of SAMPLE_CLIENT_NOTES) {
    const client = await tx.client.findFirst({
      where: { name: note.client },
      select: { id: true },
    });
    if (!client) continue;
    await logSample(author, { entityType: 'CLIENT', entityId: client.id }, note.followUp);
    count += 1;
  }
  return count;
}

/**
 * Dev-only sample pipeline, written through the services (audited as `system`).
 * Idempotent: enquiries are created only when there are none, follow-ups only when there
 * are none (so a database seeded before M5 gets them too). Each part runs in one
 * transaction (the services join it), so a failure part-way leaves nothing behind and the
 * next seed starts over instead of skipping a half-made pipeline.
 */
export async function ensureSampleEnquiries(log: (message: string) => void): Promise<void> {
  const db = getDb();
  const ctx = await systemCtx();

  if ((await db.enquiry.count({ where: { deletedAt: undefined } })) === 0) {
    await withTx(ctx, async (tx) => {
      await createSampleEnquiries(ctx, tx);
      log(`created ${SAMPLE_ENQUIRIES.length} sample enquiries`);
      log(`created ${await addSampleFollowUps(tx)} sample follow-ups`);
    });
    return;
  }
  if ((await db.followUp.count({ where: { deletedAt: undefined } })) === 0) {
    await withTx(ctx, async (tx) =>
      log(`created ${await addSampleFollowUps(tx)} sample follow-ups`),
    );
  }
}

async function createSampleEnquiries(ctx: Ctx, tx: Db): Promise<void> {
  // Reads use the transaction too, so they see the clients created in it.
  const byName = async (model: 'sector' | 'service', name: string) => {
    const row = await (model === 'sector'
      ? tx.sector.findFirst({ where: { name } })
      : tx.service.findFirst({ where: { name } }));
    if (!row) throw new Error(`Sample ${model} "${name}" is missing; seed masters first`);
    return row.id;
  };

  const clients = new Map<string, { id: string; sectorId: string }>();
  for (const { name, sector } of SAMPLE_CLIENTS) {
    const existing = await tx.client.findFirst({ where: { name } });
    const client =
      existing ?? (await createClient(ctx, { name, sectorId: await byName('sector', sector) }));
    clients.set(name, { id: client.id, sectorId: client.sectorId });
  }

  for (const sample of SAMPLE_ENQUIRIES) {
    const client = clients.get(sample.client)!;
    const owner = await tx.user.findUnique({
      where: { email: sample.owner },
      select: { id: true },
    });
    if (!owner) throw new Error(`Dev user ${sample.owner} is missing`);
    // One query at a time: an interactive transaction runs on a single connection.
    const serviceIds: string[] = [];
    for (const name of sample.services) serviceIds.push(await byName('service', name));
    const enquiry = await createEnquiry(ctx, {
      clientId: client.id,
      sectorId: client.sectorId,
      serviceIds,
      receivedDate: daysAgo(sample.receivedDaysAgo),
      ...(sample.proposalDaysAgo !== undefined && {
        proposalSentDate: daysAgo(sample.proposalDaysAgo),
      }),
      source: sample.source,
      sourceDetail: sample.sourceDetail,
      description: sample.description,
      ownerId: owner.id,
    });
    if (sample.outcome === 'CONVERTED') await convertEnquiry(ctx, { id: enquiry.id });
    else if (sample.outcome) {
      await markEnquiryLost(ctx, { id: enquiry.id, lostReason: sample.outcome.lostReason });
    }
  }
}
