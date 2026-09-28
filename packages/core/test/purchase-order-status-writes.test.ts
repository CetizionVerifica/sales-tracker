import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AC5 (M9 Decision 4): a PO's status is derived, and only recomputePurchaseOrderStatus
// writes it. Any other purchaseOrder write that names `status` would let it drift.

const root = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === 'test') return [];
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** The argument text of each `.purchaseOrder.<write>(…)` call, with where it is. */
function purchaseOrderWrites(file: string) {
  const text = readFileSync(file, 'utf8');
  const calls: { offset: number; args: string }[] = [];
  const pattern = /\.purchaseOrder\.(create|createMany|update|updateMany|upsert)\(/g;
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

describe('AC5: only recomputePurchaseOrderStatus writes a PO’s status', () => {
  it('no other purchaseOrder write in packages/core names `status`', () => {
    const writers: string[] = [];
    for (const file of sources(root)) {
      const { text, calls } = purchaseOrderWrites(file);
      for (const call of calls) {
        if (!NAMES_STATUS.test(call.args)) continue;
        const fn = text
          .slice(0, call.offset)
          .match(/export async function (\w+)/g)
          ?.at(-1);
        writers.push(`${path.relative(root, file)}:${fn ?? '?'}`);
      }
    }
    expect(writers).toEqual([
      `${path.join('services', 'purchase-order-status.ts')}:export async function recomputePurchaseOrderStatus`,
    ]);
  });

  it('no raw SQL in packages/core updates purchase_order', () => {
    const raw = sources(root).filter((file) =>
      /UPDATE\s+"?purchase_order"?/i.test(readFileSync(file, 'utf8')),
    );
    expect(raw).toEqual([]);
  });

  it('recomputePurchaseOrderStatus is not exported from the package', () => {
    const index = readFileSync(path.join(root, 'services', 'index.ts'), 'utf8');
    expect(index).not.toContain('purchase-order-status');
    const pkg = readFileSync(path.join(root, 'index.ts'), 'utf8');
    expect(pkg).not.toContain('recomputePurchaseOrderStatus');
  });
});
