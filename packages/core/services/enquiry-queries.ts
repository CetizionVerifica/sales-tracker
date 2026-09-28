import { Prisma } from '@sales-tracker/db';
import type { Db } from '../clients.ts';
import { toCalendarDateString } from '../schemas/common.ts';

/*
 * Stale enquiries (M11 Decision 5), shared by My Today and the enquiry list's `stale`
 * filter so both agree. Not exported from the package: it takes a Db, not a ctx, so callers
 * check permissions and apply scope themselves.
 *
 * Stale = live, IN_PROGRESS, no open next step (the latest live follow-up on the enquiry has
 * no next follow-up date, or there is none), and last touched on or before today − days.
 * Last touch = the later of the received date and the latest follow-up's date. "Latest"
 * uses getLatestFollowUp's order (date, createdAt, id; all descending).
 */

export interface StaleEnquiry {
  id: string;
  /** The IST calendar day of the last touch (UTC midnight). */
  lastTouch: Date;
}

const parseDay = (day: string) => new Date(`${day}T00:00:00.000Z`);

export async function findStaleEnquiries(
  db: Db,
  options: { today: Date; days: number; ownerId?: string },
): Promise<StaleEnquiry[]> {
  const cutoff = toCalendarDateString(
    new Date(options.today.getTime() - options.days * 86_400_000),
  );
  const owner = options.ownerId ? Prisma.sql`AND e."ownerId" = ${options.ownerId}` : Prisma.empty;
  const rows = await db.$queryRaw<{ id: string; lastTouch: string }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (f."entityId") f."entityId", f."date", f."nextFollowUpDate"
      FROM follow_up f
      JOIN enquiry fe ON fe.id = f."entityId"
      WHERE f."entityType" = 'ENQUIRY' AND f."deletedAt" IS NULL
        AND fe.status = 'IN_PROGRESS' AND fe."deletedAt" IS NULL
      ORDER BY f."entityId", f."date" DESC, f."createdAt" DESC, f.id DESC
    )
    SELECT e.id, to_char(GREATEST(e."receivedDate", l."date"), 'YYYY-MM-DD') AS "lastTouch"
    FROM enquiry e
    LEFT JOIN latest l ON l."entityId" = e.id
    WHERE e.status = 'IN_PROGRESS' AND e."deletedAt" IS NULL
      AND l."nextFollowUpDate" IS NULL
      AND GREATEST(e."receivedDate", l."date") <= ${cutoff}::date
      ${owner}`;
  return rows.map((r) => ({ id: r.id, lastTouch: parseDay(r.lastTouch) }));
}
