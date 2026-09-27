import type { EnquirySourceValue } from '../schemas/enquiry.ts';
import { todayInIST, toCalendarDateString } from '../schemas/common.ts';
import type { FollowUpChannelValue } from '../schemas/follow-up.ts';
import { getDb, type Db } from '../clients.ts';
import { systemCtx, withTx, type Ctx } from '../context.ts';
import { createClient } from '../services/client.service.ts';
import { convertEnquiry, createEnquiry, markEnquiryLost } from '../services/enquiry.service.ts';
import { logFollowUp } from '../services/follow-up.service.ts';
import { changeProjectStatus, createProject, updateProject } from '../services/project.service.ts';
import { changeQuotationStatus, createQuotation } from '../services/quotation.service.ts';
import { updateSettings } from '../services/settings.service.ts';
import { parseAmount } from '../schemas/money.ts';

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

/** Which sample enquiry a sample quotation belongs to: (client, owner, source) is unique. */
interface EnquiryKey {
  client: ClientName;
  owner: SampleEnquiry['owner'];
  source: EnquirySourceValue;
}

interface SampleQuotation {
  enquiry: EnquiryKey;
  quotedDaysAgo: number;
  amount: string;
  currency: 'INR' | 'USD';
  /** The next follow-up date it is created with (days from today; negative = past). */
  nextInDays: number;
  description?: string;
  outcome?: 'UNDER_NEGOTIATION' | { poDaysAgo: number } | { lostReason: string };
  followUps?: SampleFollowUp[];
}

const TRAINING: EnquiryKey = {
  client: 'Acme Pharma',
  owner: 'sales@example.com',
  source: 'REFERRAL',
};
const INSPECTION: EnquiryKey = {
  client: 'Acme Pharma',
  owner: 'sales2@example.com',
  source: 'OTHER',
};

/**
 * M6 samples on the two converted enquiries (several per enquiry, as AC15 allows): every
 * status, INR and USD, ₹45,000 up to ₹3.5 crore (beyond 32-bit Int, M6 Decision 3), and
 * next follow-up dates due today, missed and upcoming (M11).
 */
const SAMPLE_QUOTATIONS: SampleQuotation[] = [
  {
    enquiry: TRAINING,
    quotedDaysAgo: 50,
    amount: '45000.00',
    currency: 'INR',
    nextInDays: -45,
    description: 'Two-day GMP training for the QA team',
    followUps: [
      {
        daysAgo: 10,
        channel: 'CALL',
        notes: 'Awaiting budget approval from plant head',
        nextInDays: 0,
      },
    ],
  },
  {
    enquiry: TRAINING,
    quotedDaysAgo: 45,
    amount: '1,20,000',
    currency: 'INR',
    nextInDays: 7,
    description: 'Refresher training for new hires',
  },
  {
    enquiry: TRAINING,
    quotedDaysAgo: 48,
    amount: '2,40,000.00',
    currency: 'INR',
    nextInDays: -40,
    outcome: { poDaysAgo: 20 },
  },
  {
    enquiry: INSPECTION,
    quotedDaysAgo: 100,
    amount: '12500.00',
    currency: 'USD',
    nextInDays: -90,
    outcome: 'UNDER_NEGOTIATION',
    followUps: [
      {
        daysAgo: 30,
        channel: 'EMAIL',
        notes: 'Client asked for revised payment terms',
        nextInDays: -3,
      },
    ],
  },
  {
    enquiry: INSPECTION,
    quotedDaysAgo: 95,
    amount: '3,50,00,000.00',
    currency: 'INR',
    nextInDays: -80,
    outcome: { lostReason: 'Budget cut for FY27' },
    followUps: [{ daysAgo: 60, channel: 'MEETING', notes: 'Board deferred the capex decision' }],
  },
];

const daysAgo = (days: number) =>
  toCalendarDateString(new Date(todayInIST().getTime() - days * 86_400_000));

/** The sample's follow-up as its author: the enquiry owner, audited as `system`. */
async function logSample(
  author: { id: string; role: Ctx['user']['role'] },
  link: { entityType: 'CLIENT' | 'ENQUIRY' | 'QUOTATION' | 'PROJECT'; entityId: string },
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

async function devUser(tx: Db, email: string) {
  const row = await tx.user.findUnique({ where: { email }, select: { id: true, role: true } });
  if (!row) throw new Error(`Dev user ${email} is missing`);
  return row;
}

async function findSampleEnquiry(tx: Db, key: EnquiryKey) {
  const owner = await devUser(tx, key.owner);
  const enquiry = await tx.enquiry.findFirst({
    where: { ownerId: owner.id, source: key.source, client: { name: key.client } },
    select: { id: true, status: true },
  });
  return enquiry && { ...enquiry, owner };
}

/** A sample quotation, found by its enquiry, amount and currency (unique among them). */
async function findSampleQuotation(tx: Db, sample: SampleQuotation) {
  const enquiry = await findSampleEnquiry(tx, sample.enquiry);
  const amount = parseAmount(sample.amount, sample.currency);
  if (!enquiry || !amount.ok) return null;
  const quotation = await tx.quotation.findFirst({
    where: { enquiryId: enquiry.id, amountMinor: amount.value, currency: sample.currency },
    select: { id: true },
  });
  return quotation && { id: quotation.id, owner: enquiry.owner };
}

/** M6 sample follow-ups on the sample quotations, as their owners. */
async function addSampleQuotationFollowUps(tx: Db): Promise<number> {
  let count = 0;
  for (const sample of SAMPLE_QUOTATIONS) {
    if (!sample.followUps) continue;
    const quotation = await findSampleQuotation(tx, sample);
    if (!quotation) continue;
    for (const followUp of sample.followUps) {
      await logSample(
        quotation.owner,
        { entityType: 'QUOTATION', entityId: quotation.id },
        followUp,
      );
      count += 1;
    }
  }
  return count;
}

/**
 * M5 sample follow-ups, attached to the sample enquiries found by (client, owner, source),
 * which is unique among them, plus M6's on the sample quotations. Samples a developer has
 * since deleted are skipped. Runs inside the caller's transaction.
 */
async function addSampleFollowUps(tx: Db): Promise<number> {
  const user = (email: string) => devUser(tx, email);
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
  return count + (await addSampleQuotationFollowUps(tx)) + (await addSampleProjectFollowUps(tx));
}

/**
 * M6 sample quotations on the converted sample enquiries, created by the system user for the
 * enquiry owners, then moved to their sample status. Enables USD in settings if needed.
 */
async function createSampleQuotations(ctx: Ctx, tx: Db): Promise<number> {
  const settings = await tx.companySettings.findUnique({ where: { id: 1 } });
  if (!settings) throw new Error('Company settings are missing; seed them first');
  if (!settings.enabledCurrencies.includes('USD')) {
    await updateSettings(ctx, {
      companyName: settings.companyName,
      defaultInvoiceDueDays: settings.defaultInvoiceDueDays,
      enabledCurrencies: [...settings.enabledCurrencies, 'USD'],
    });
  }

  let count = 0;
  for (const sample of SAMPLE_QUOTATIONS) {
    if (await createSampleQuotation(ctx, tx, sample)) count += 1;
  }
  return count;
}

/** One sample quotation, moved to its sample status; null when its enquiry is missing. */
async function createSampleQuotation(
  ctx: Ctx,
  tx: Db,
  sample: SampleQuotation,
): Promise<{ id: string } | null> {
  const enquiry = await findSampleEnquiry(tx, sample.enquiry);
  if (!enquiry || enquiry.status !== 'CONVERTED') return null;
  const links = await tx.enquiryService.findMany({
    where: { enquiryId: enquiry.id },
    select: { serviceId: true, enquiry: { select: { sectorId: true } } },
  });
  const quotation = await createQuotation(ctx, {
    enquiryId: enquiry.id,
    quotationDate: daysAgo(sample.quotedDaysAgo),
    amount: sample.amount,
    currency: sample.currency,
    sectorId: links[0]!.enquiry.sectorId,
    serviceIds: links.map((link) => link.serviceId),
    nextFollowUpDate: daysAgo(-sample.nextInDays),
    description: sample.description,
  });
  const { outcome } = sample;
  if (outcome === 'UNDER_NEGOTIATION') {
    await changeQuotationStatus(ctx, { id: quotation.id, to: 'UNDER_NEGOTIATION' });
  } else if (outcome && 'poDaysAgo' in outcome) {
    await changeQuotationStatus(ctx, {
      id: quotation.id,
      to: 'PO_RECEIVED',
      poReceivedDate: daysAgo(outcome.poDaysAgo),
    });
  } else if (outcome) {
    await changeQuotationStatus(ctx, {
      id: quotation.id,
      to: 'LOST',
      lostReason: outcome.lostReason,
    });
  }
  return quotation;
}

// ─── M8 sample projects ─────────────────────────────────────────────────────────────

interface SampleProject {
  /** A PO_RECEIVED quotation made for this project (one live project per quotation). */
  quotation: SampleQuotation & { outcome: { poDaysAgo: number } };
  name: string;
  /** Unassigned when false (M8 Decision 5). */
  managed: boolean;
  startDaysAgo?: number;
  /** Planned end, days from today (negative = past, behind schedule while open). */
  endInDays?: number;
  completionPct?: number;
  status?:
    | 'IN_PROGRESS'
    | { holdReason: string }
    | { completedDaysAgo: number }
    | { cancelReason: string };
  followUp?: SampleFollowUp;
}

const PM_EMAIL = 'pm@example.com';

/**
 * Every project status, one unassigned and one behind schedule, on quotations made for them.
 * M6's own PO_RECEIVED sample stays without a project, so the create flow can be tried.
 */
const SAMPLE_PROJECTS: SampleProject[] = [
  {
    quotation: {
      enquiry: TRAINING,
      quotedDaysAgo: 55,
      amount: '3,60,000.00',
      currency: 'INR',
      nextInDays: -50,
      outcome: { poDaysAgo: 40 },
    },
    name: 'Onboarding training programme',
    managed: false,
    endInDays: 90,
  },
  {
    quotation: {
      enquiry: TRAINING,
      quotedDaysAgo: 52,
      amount: '4,50,000.00',
      currency: 'INR',
      nextInDays: -45,
      outcome: { poDaysAgo: 35 },
    },
    name: 'Plant QA training, phase 1',
    managed: true,
    startDaysAgo: 30,
    endInDays: 30,
    completionPct: 40,
    status: 'IN_PROGRESS',
    followUp: {
      daysAgo: 7,
      channel: 'MEETING',
      notes: 'Reviewed attendance and the next batch dates',
      nextInDays: 7,
    },
  },
  {
    quotation: {
      enquiry: TRAINING,
      quotedDaysAgo: 58,
      amount: '1,80,000.00',
      currency: 'INR',
      nextInDays: -55,
      outcome: { poDaysAgo: 50 },
    },
    name: 'SOP writing workshop',
    managed: true,
    startDaysAgo: 45,
    endInDays: -12,
    status: { completedDaysAgo: 10 },
  },
  {
    quotation: {
      enquiry: INSPECTION,
      quotedDaysAgo: 110,
      amount: '8,000.00',
      currency: 'USD',
      nextInDays: -100,
      outcome: { poDaysAgo: 90 },
    },
    name: 'Export line inspection',
    managed: true,
    startDaysAgo: 80,
    endInDays: -5,
    completionPct: 70,
    status: 'IN_PROGRESS',
    followUp: { daysAgo: 3, channel: 'CALL', notes: 'Final report delayed by lab results' },
  },
  {
    quotation: {
      enquiry: INSPECTION,
      quotedDaysAgo: 105,
      amount: '9,75,000.00',
      currency: 'INR',
      nextInDays: -95,
      outcome: { poDaysAgo: 85 },
    },
    name: 'Warehouse audit',
    managed: true,
    startDaysAgo: 70,
    endInDays: 20,
    completionPct: 25,
    status: { holdReason: 'Client plant shut for annual maintenance' },
  },
  {
    quotation: {
      enquiry: INSPECTION,
      quotedDaysAgo: 100,
      amount: '5,40,000.00',
      currency: 'INR',
      nextInDays: -90,
      outcome: { poDaysAgo: 88 },
    },
    name: 'Second-site inspection',
    managed: true,
    endInDays: 60,
    status: { cancelReason: 'Client sold the second site' },
  },
];

/** M8 sample follow-ups on existing sample projects (found by name), as the dev PM. */
async function addSampleProjectFollowUps(tx: Db): Promise<number> {
  const pm = await devUser(tx, PM_EMAIL);
  let count = 0;
  for (const sample of SAMPLE_PROJECTS) {
    if (!sample.followUp) continue;
    const project = await tx.project.findFirst({
      where: { name: sample.name },
      select: { id: true },
    });
    if (!project) continue;
    await logSample(pm, { entityType: 'PROJECT', entityId: project.id }, sample.followUp);
    count += 1;
  }
  return count;
}

/**
 * M8 sample projects, each on a PO_RECEIVED quotation made for it: created by the quotation's
 * owner, moved along by the dev PM, cancelled by the system user (admin-only), all audited as
 * `system`.
 */
async function createSampleProjects(ctx: Ctx, tx: Db): Promise<number> {
  const as = (user: { id: string; role: Ctx['user']['role'] }): Ctx => ({
    user: { ...user, active: true },
    source: 'system',
  });
  const pm = as(await devUser(tx, PM_EMAIL));

  let count = 0;
  for (const sample of SAMPLE_PROJECTS) {
    const quotation = await createSampleQuotation(ctx, tx, sample.quotation);
    if (!quotation) continue;
    const owner = as((await findSampleEnquiry(tx, sample.quotation.enquiry))!.owner);
    const links = await tx.quotationService.findMany({
      where: { quotationId: quotation.id },
      select: { serviceId: true },
    });
    const project = await createProject(owner, {
      quotationId: quotation.id,
      name: sample.name,
      managerId: sample.managed ? pm.user.id : '',
      serviceIds: links.map((link) => link.serviceId),
      revenue: sample.quotation.amount,
      currency: sample.quotation.currency,
      ...(sample.endInDays !== undefined && { endDate: daysAgo(-sample.endInDays) }),
    });

    const { status } = sample;
    const startDate = sample.startDaysAgo !== undefined ? daysAgo(sample.startDaysAgo) : undefined;
    if (status && typeof status === 'object' && 'cancelReason' in status) {
      await changeProjectStatus(ctx, { id: project.id, ...status, to: 'CANCELLED' });
    } else if (status) {
      await changeProjectStatus(pm, { id: project.id, to: 'IN_PROGRESS', startDate });
      if (sample.completionPct) {
        await updateProject(pm, project.id, { completionPct: sample.completionPct });
      }
      if (typeof status === 'object' && 'holdReason' in status) {
        await changeProjectStatus(pm, { id: project.id, to: 'ON_HOLD', ...status });
      } else if (typeof status === 'object' && 'completedDaysAgo' in status) {
        await changeProjectStatus(pm, {
          id: project.id,
          to: 'COMPLETED',
          completedDate: daysAgo(status.completedDaysAgo),
        });
      }
    }
    if (sample.followUp) {
      await logSample(pm.user, { entityType: 'PROJECT', entityId: project.id }, sample.followUp);
    }
    count += 1;
  }
  return count;
}

/**
 * Dev-only sample pipeline, written through the services (audited as `system`).
 * Idempotent: enquiries are created only when there are none, and likewise quotations and
 * follow-ups, and projects with the quotations made for them (so a database seeded before
 * M5, M6 or M8 gets them too). Each part runs in one
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
      log(`created ${await createSampleQuotations(ctx, tx)} sample quotations`);
      log(`created ${await addSampleFollowUps(tx)} sample follow-ups`);
      log(`created ${await createSampleProjects(ctx, tx)} sample projects`);
    });
    return;
  }
  const hasFollowUps = (await db.followUp.count({ where: { deletedAt: undefined } })) > 0;
  if ((await db.quotation.count({ where: { deletedAt: undefined } })) === 0) {
    await withTx(ctx, async (tx) => {
      log(`created ${await createSampleQuotations(ctx, tx)} sample quotations`);
      // Pre-M6 databases already have their other follow-ups; add the quotations' ones.
      if (hasFollowUps) log(`created ${await addSampleQuotationFollowUps(tx)} sample follow-ups`);
    });
  }
  if (!hasFollowUps) {
    await withTx(ctx, async (tx) =>
      log(`created ${await addSampleFollowUps(tx)} sample follow-ups`),
    );
  }
  if ((await db.project.count({ where: { deletedAt: undefined } })) === 0) {
    await withTx(ctx, async (tx) =>
      log(`created ${await createSampleProjects(ctx, tx)} sample projects`),
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
