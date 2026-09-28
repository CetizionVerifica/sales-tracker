import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AC6 (CLAUDE.md rule 8): an invoice's status changes only through the machine in
// status/invoice.ts. In packages/core, only createInvoice (the initial status) and
// moveInvoiceStatus (which asserts every move) may write it.

const root = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === 'test') return [];
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** The argument text of each `.invoice.<write>(…)` call, with where it is. */
function invoiceWrites(file: string) {
  const text = readFileSync(file, 'utf8');
  const calls: { offset: number; args: string }[] = [];
  const pattern = /\.invoice\.(create|createMany|update|updateMany|upsert)\(/g;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (depth > 0 && end < text.length) {
      const char = text[end++];
      if (char === '(') depth++;
      else if (char === ')') depth--;
    }
    calls.push({ offset: match.index, args: text.slice(start, end - 1) });
  }
  return { text, calls };
}

const NAMES_STATUS = /[{,\s]status\s*[:,}]/;

/** The `data` part of a write's argument: a `where` naming `status` is only a guard. */
const dataOf = (args: string) => args.slice(args.indexOf('data:'));

describe('AC6: only the status machine writes an invoice’s status', () => {
  it('only createInvoice and moveInvoiceStatus write `status` on invoice', () => {
    const writers: string[] = [];
    for (const file of sources(root)) {
      const { text, calls } = invoiceWrites(file);
      for (const call of calls) {
        if (!NAMES_STATUS.test(dataOf(call.args))) continue;
        const fn = text
          .slice(0, call.offset)
          .match(/async function (\w+)/g)
          ?.at(-1);
        writers.push(`${path.relative(root, file)}:${fn ?? '?'}`);
      }
    }
    expect(writers.sort()).toEqual([
      `${path.join('services', 'invoice.service.ts')}:async function createInvoice`,
      `${path.join('services', 'invoice.service.ts')}:async function moveInvoiceStatus`,
    ]);
  });

  it('moveInvoiceStatus asserts the move before it writes', () => {
    const text = readFileSync(path.join(root, 'services', 'invoice.service.ts'), 'utf8');
    const body = text.slice(text.indexOf('async function moveInvoiceStatus'));
    const assertAt = body.indexOf('assertInvoiceTransition(');
    const writeAt = body.indexOf('.invoice.updateMany(');
    expect(assertAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(writeAt);
  });

  it('no raw SQL in packages/core updates invoice', () => {
    const raw = sources(root).filter((file) =>
      /UPDATE\s+"?invoice"?\s/i.test(readFileSync(file, 'utf8')),
    );
    expect(raw).toEqual([]);
  });

  it('no production caller passes its own invoice loader to the PO recompute (M9 risk)', () => {
    const callers = sources(root).flatMap((file) =>
      [
        ...readFileSync(file, 'utf8').matchAll(
          /(function )?recomputePurchaseOrderStatus\(([^)]*)\)/g,
        ),
      ]
        // A call passes (tx, poId); a third argument is the test-only loader.
        .filter((match) => !match[1] && match[2]!.split(',').filter((a) => a.trim()).length > 2)
        .map(() => path.relative(root, file)),
    );
    expect(callers).toEqual([]);
  });
});
