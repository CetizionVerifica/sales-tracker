import type { DocumentState, PurchaseOrderStatusValue } from '@sales-tracker/core/schemas';
import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { Panel } from '@/components/charts/Panel';
import { DateDisplay } from '@/components/display/DateDisplay';
import { Money } from '@/components/display/Money';
import { DocumentStateLabel } from '@/components/documents/DocumentStateLabel';
import { EmptyState } from '@/components/feedback/EmptyState';
import { StatusBadge } from '@/components/pipeline/StatusBadge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ProjectPoRow {
  id: string;
  poNumber: string;
  receivedDate: string;
  /** Minor units as strings: no BigInt reaches the page's client parts. */
  amountMinor: string;
  currency: string;
  paymentTerms: string | null;
  status: PurchaseOrderStatusValue;
  documentState: DocumentState;
}

export interface ProjectPoTotals {
  byCurrency: { currency: string; amountMinor: string }[];
  currency: string;
  coveredMinor: string;
  revenueMinor: string;
  overCovered: boolean;
}

/**
 * The project's live POs (M9): a compact table (cards on phones), totals per currency, and
 * how much of the revenue they cover. Over-coverage is a warning, not an error (Decision 6).
 */
export function ProjectPurchaseOrders({
  projectId,
  purchaseOrders,
  totals,
  canAdd,
}: {
  projectId: string;
  purchaseOrders: ProjectPoRow[];
  totals: ProjectPoTotals;
  canAdd: boolean;
}) {
  const others = totals.byCurrency.filter((t) => t.currency !== totals.currency);
  return (
    <div id="purchase-orders" className="scroll-mt-20">
      <Panel
        id="project-purchase-orders"
        title="Purchase orders"
        bodyClassName="p-0"
        actions={
          canAdd && (
            <Button asChild size="sm">
              <Link href={`/purchase-orders/new?projectId=${projectId}`}>Add PO</Link>
            </Button>
          )
        }
      >
        {purchaseOrders.length === 0 ? (
          <EmptyState
            message={
              canAdd
                ? 'No purchase orders yet. Add the client’s PO when it arrives.'
                : 'No purchase orders yet.'
            }
          />
        ) : (
          <>
            <ul className="divide-y md:hidden">
              {purchaseOrders.map((po) => (
                <li key={po.id} className="flex flex-col gap-1 px-4 py-2.5">
                  <span className="flex items-center justify-between gap-2">
                    <Link
                      className="font-medium hover:underline"
                      href={`/purchase-orders/${po.id}`}
                    >
                      PO {po.poNumber}
                    </Link>
                    <StatusBadge entity="po" status={po.status} />
                  </span>
                  <span className="text-muted-foreground flex items-center justify-between gap-2 text-[13px]">
                    <Money amountMinor={po.amountMinor} currency={po.currency} />
                    <DateDisplay value={po.receivedDate} />
                  </span>
                  <DocumentStateLabel state={po.documentState} />
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="text-muted-foreground text-left text-[13px]">
                  <tr className="border-b">
                    <th scope="col" className="px-4 py-2 font-medium">
                      PO number
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Received
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Amount
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Terms
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Document
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {purchaseOrders.map((po) => (
                    <tr key={po.id}>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <Link
                          className="font-medium hover:underline"
                          href={`/purchase-orders/${po.id}`}
                        >
                          {po.poNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <DateDisplay value={po.receivedDate} />
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <Money amountMinor={po.amountMinor} currency={po.currency} />
                      </td>
                      <td className="px-4 py-2.5">
                        {po.paymentTerms ? (
                          <span className="block max-w-48 truncate" title={po.paymentTerms}>
                            {po.paymentTerms}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge entity="po" status={po.status} />
                      </td>
                      <td className="px-4 py-2.5">
                        <DocumentStateLabel state={po.documentState} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-col gap-1 border-t px-4 py-3 text-sm">
              <p className={cn('flex items-start gap-1.5', totals.overCovered && 'font-medium')}>
                {totals.overCovered && (
                  <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
                )}
                <span>
                  POs cover <Money amountMinor={totals.coveredMinor} currency={totals.currency} />{' '}
                  of <Money amountMinor={totals.revenueMinor} currency={totals.currency} /> revenue
                  {totals.overCovered && ', more than the project revenue'}
                </span>
              </p>
              {others.length > 0 && (
                <p className="text-muted-foreground text-[13px]">
                  Also{' '}
                  {others.map((t, index) => (
                    <span key={t.currency}>
                      {index > 0 && ', '}
                      <Money amountMinor={t.amountMinor} currency={t.currency} />
                    </span>
                  ))}{' '}
                  in other currencies, not counted against the revenue.
                </p>
              )}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
