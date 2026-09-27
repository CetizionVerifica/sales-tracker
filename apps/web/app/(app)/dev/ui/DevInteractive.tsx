'use client';

import { useState } from 'react';
import { Panel } from '@/components/charts/Panel';
import { RowActions } from '@/components/data/RowActions';
import { ErrorState } from '@/components/feedback/ErrorState';
import { FormSheet } from '@/components/layout/FormSheet';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/** The interactive pieces of the UI kit: error state, row menu, form sheet. */
export function DevInteractive() {
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <>
      <Panel title="Error">
        <ErrorState onRetry={() => setPicked('Retry')} />
      </Panel>
      <Panel title="Row menu and form sheet">
        <div className="flex items-center gap-3">
          <RowActions
            label="QUO-2026-0001"
            actions={[
              { label: 'Edit quotation', onSelect: () => setOpen(true) },
              { label: 'Delete', onSelect: () => setPicked('Delete'), destructive: true },
            ]}
          />
          <Button variant="outline" onClick={() => setOpen(true)}>
            Open form sheet
          </Button>
          {picked && <span className="text-muted-foreground text-[13px]">Picked: {picked}</span>}
        </div>
        <FormSheet
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setDirty(false);
          }}
          title="New enquiry"
          description="A sample sheet: type something, then Cancel to see the unsaved-changes check."
          submitLabel="Create enquiry"
          submitting={false}
          dirty={dirty}
          formError="Couldn’t save. Check your connection and try again."
          onSubmit={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="dev-name">Client</FieldLabel>
              <Input id="dev-name" onChange={() => setDirty(true)} />
            </Field>
          </FieldGroup>
        </FormSheet>
      </Panel>
    </>
  );
}
