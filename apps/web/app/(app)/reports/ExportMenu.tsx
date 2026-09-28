'use client';

import { ChevronDown, Download, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const REPORTS: { key: string; label: string }[] = [
  { key: 'enquiryVolume', label: 'R1 · Enquiries received' },
  { key: 'enquiryStatus', label: 'R2 · Enquiry status' },
  { key: 'sectorPos', label: 'R3 · POs by sector' },
  { key: 'serviceSales', label: 'R4 · Top services' },
  { key: 'customerMix', label: 'R5 · New and repeat customers' },
  { key: 'revenue', label: 'R6 · Monthly revenue' },
];

/** The page header's [Download PDF] [Export CSV ▾] actions (M12b). */
export function ReportExportActions({ query }: { query: string }) {
  return (
    <div className="flex items-center gap-2 print:hidden">
      <Button variant="outline" size="sm" onClick={() => window.print()}>
        <Printer className="size-4" strokeWidth={1.75} aria-hidden />
        Download PDF
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <Download className="size-4" strokeWidth={1.75} aria-hidden />
            Export CSV
            <ChevronDown className="size-3.5" strokeWidth={1.75} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {REPORTS.map((r) => (
            <DropdownMenuItem key={r.key} asChild>
              <a href={`/api/reports/export?report=${r.key}&${query}`} download>
                {r.label}
              </a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
