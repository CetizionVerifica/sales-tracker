import type { DocumentState, InvoiceStatusValue } from '@sales-tracker/core/schemas';
import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { Panel } from '@/components/charts/Panel';
import { DateDisplay } from '@/components/display/DateDisplay';
import { Money } from '@/components/display/Money';
import { RelativeDue } from '@/components/display/RelativeDue';
import { DocumentStateLabel } from '@/components/documents/DocumentStateLabel';
import { EmptyState } from '@/components/feedback/EmptyState';
import { StatusBadge } from '@/components/pipeline/StatusBadge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface PoInvoiceRow {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  /** Minor units as strings: no BigInt reaches the page's client parts. */
  amountMinor: string;
  currency: string;
  status: InvoiceStatusValue;
  documentState: DocumentState;
}

export interface PoBillingLine {
  currency: string;
  poAmountMinor: string;
  invoicedMinor: string;
  paidMinor: string;
  overInvoiced: boolean;
}

/**
 * The PO's live invoices (M10): a compact table (cards on phones) and what is invoiced and
 * paid against the PO amount. Over-invoicing is a warning, not an error (Decision 9).
 */
export function PurchaseOrderInvoices({
  purchaseOrderId,
  invoices,
  billing,
  today,
  canAdd,
}: {
  purchaseOrderId: string;
  invoices: PoInvoiceRow[];
  billing: PoBillingLine;
  today: string;
  canAdd: boolean;
}) {
  return (
    <div id="invoices" className="scroll-mt-20">
      <Panel
        id="po-invoices"
        title="Invoices"
        bodyClassName="p-0"
        actions={
          canAdd && (
            <Button asChild size="sm">
              <Link href={`/invoices/new?purchaseOrderId=${purchaseOrderId}`}>Add invoice</Link>
            </Button>
          )
        }
      >
        {invoices.length === 0 ? (
          <EmptyState
            message={
              canAdd ? 'No invoices yet. Add one when it is raised on this PO.' : 'No invoices yet.'
            }
          />
        ) : (
          <>
            <ul className="divide-y md:hidden">
              {invoices.map((invoice) => (
                <li key={invoice.id} className="flex flex-col gap-1 px-4 py-2.5">
                  <span className="flex items-center justify-between gap-2">
                    <Link className="font-medium hover:underline" href={`/invoices/${invoice.id}`}>
                      Invoice {invoice.invoiceNumber}
                    </Link>
                    <StatusBadge entity="invoice" status={invoice.status} />
                  </span>
                  <span className="text-muted-foreground flex items-center justify-between gap-2 text-[13px]">
                    <Money amountMinor={invoice.amountMinor} currency={invoice.currency} />
                    <RelativeDue
                      date={invoice.dueDate}
                      today={today}
                      active={invoice.status !== 'PAID'}
                    />
                  </span>
                  <DocumentStateLabel state={invoice.documentState} />
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="text-muted-foreground text-left text-[13px]">
                  <tr className="border-b">
                    <th scope="col" className="px-4 py-2 font-medium">
                      Invoice number
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Invoice date
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Due
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Amount
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
                  {invoices.map((invoice) => (
                    <tr key={invoice.id}>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <Link
                          className="font-medium hover:underline"
                          href={`/invoices/${invoice.id}`}
                        >
                          {invoice.invoiceNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <DateDisplay value={invoice.invoiceDate} />
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <RelativeDue
                          date={invoice.dueDate}
                          today={today}
                          active={invoice.status !== 'PAID'}
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <Money amountMinor={invoice.amountMinor} currency={invoice.currency} />
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge entity="invoice" status={invoice.status} />
                      </td>
                      <td className="px-4 py-2.5">
                        <DocumentStateLabel state={invoice.documentState} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p
              className={cn(
                'flex items-start gap-1.5 border-t px-4 py-3 text-sm',
                billing.overInvoiced && 'font-medium',
              )}
            >
              {billing.overInvoiced && (
                <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
              )}
              <span>
                Invoiced <Money amountMinor={billing.invoicedMinor} currency={billing.currency} />{' '}
                of <Money amountMinor={billing.poAmountMinor} currency={billing.currency} /> · Paid{' '}
                <Money amountMinor={billing.paidMinor} currency={billing.currency} />
                {billing.overInvoiced && ', more than the PO amount'}
              </span>
            </p>
          </>
        )}
      </Panel>
    </div>
  );
}
