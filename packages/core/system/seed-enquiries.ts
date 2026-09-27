import type { EnquirySourceValue } from '../schemas/enquiry.ts';
import { todayInIST, toCalendarDateString } from '../schemas/common.ts';
import { getDb } from '../clients.ts';
import { systemCtx } from '../context.ts';
import { createClient } from '../services/client.service.ts';
import { convertEnquiry, createEnquiry, markEnquiryLost } from '../services/enquiry.service.ts';

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
  },
  {
    client: 'Bharat Steel Works',
    services: ['Certification'],
    owner: 'sales@example.com',
    receivedDaysAgo: 40,
    source: 'TENDER_PORTAL',
    sourceDetail: 'GeM GEM/2026/B/1001',
  },
  {
    client: 'Coastal Infra Projects',
    services: ['Inspection'],
    owner: 'sales@example.com',
    receivedDaysAgo: 20,
    proposalDaysAgo: 12,
    source: 'PHONE',
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
  },
];

const daysAgo = (days: number) =>
  toCalendarDateString(new Date(todayInIST().getTime() - days * 86_400_000));

/**
 * Dev-only sample pipeline, written through the services as the system user (audited as
 * `system`). Idempotent: does nothing once any enquiry exists.
 */
export async function ensureSampleEnquiries(log: (message: string) => void): Promise<void> {
  const db = getDb();
  if ((await db.enquiry.count({ where: { deletedAt: undefined } })) > 0) return;
  const ctx = await systemCtx();

  const byName = async (model: 'sector' | 'service', name: string) => {
    const row = await (model === 'sector'
      ? db.sector.findFirst({ where: { name } })
      : db.service.findFirst({ where: { name } }));
    if (!row) throw new Error(`Sample ${model} "${name}" is missing; seed masters first`);
    return row.id;
  };

  const clients = new Map<string, { id: string; sectorId: string }>();
  for (const { name, sector } of SAMPLE_CLIENTS) {
    const existing = await db.client.findFirst({ where: { name } });
    const client =
      existing ?? (await createClient(ctx, { name, sectorId: await byName('sector', sector) }));
    clients.set(name, { id: client.id, sectorId: client.sectorId });
  }

  for (const sample of SAMPLE_ENQUIRIES) {
    const client = clients.get(sample.client)!;
    const owner = await db.user.findUnique({
      where: { email: sample.owner },
      select: { id: true },
    });
    if (!owner) throw new Error(`Dev user ${sample.owner} is missing`);
    const enquiry = await createEnquiry(ctx, {
      clientId: client.id,
      sectorId: client.sectorId,
      serviceIds: await Promise.all(sample.services.map((name) => byName('service', name))),
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
  log(`created ${SAMPLE_ENQUIRIES.length} sample enquiries`);
}
