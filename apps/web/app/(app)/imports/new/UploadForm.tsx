'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Panel } from '@/components/charts/Panel';
import { Button } from '@/components/ui/button';
import { applyResult } from '@/lib/apply-result';
import { uploadImportFile } from '@/lib/import-upload';

const ACCEPTED = '.xlsx,.xlsm,.xls,.ods,.csv,.tsv,.txt';

/** Upload step (M10b wizard, step 1). The rest of the wizard runs on `/imports/[id]`. */
export function UploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!file) return;
    setUploading(true);
    setError(null);
    const result = await uploadImportFile(file);
    setUploading(false);
    if (applyResult(result, undefined, 'File uploaded')) {
      router.push(`/imports/${result.data.id}`);
    } else if (!result.ok) {
      setError(result.error);
    }
  }

  return (
    <Panel
      title="Upload a spreadsheet"
      description="xlsx, xlsm, xls, ods, csv, tsv or txt, up to 20 MB and 50,000 rows. Phase 1 imports enquiries from a single sheet."
      actions={
        <Button variant="outline" size="sm" asChild>
          <a href="/api/imports/template" download>
            <Download className="size-4" strokeWidth={1.75} aria-hidden />
            Download template
          </a>
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <label
          htmlFor="import-file"
          className="border-input hover:bg-accent flex cursor-pointer flex-col items-center gap-2 rounded-[var(--radius)] border border-dashed px-6 py-10 text-center"
        >
          <span className="font-medium">{file ? file.name : 'Choose a file, or drag it here'}</span>
          <span className="text-muted-foreground text-[13px]">
            {file
              ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
              : 'Enquiry register, tracker sheet or similar'}
          </span>
        </label>
        <input
          id="import-file"
          type="file"
          accept={ACCEPTED}
          className="sr-only"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button onClick={submit} disabled={!file || uploading}>
            {uploading ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
