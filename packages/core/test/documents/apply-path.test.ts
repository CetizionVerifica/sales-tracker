import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AC4 (the "done when"): extracted values reach a record only through confirmExtraction.
// The registry's applyConfirmed is the one bridge from an extraction to a record's update
// service; only document.service.ts may call it, and only once (in confirmExtraction).

const root = fileURLToPath(new URL('../..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === 'test') return [];
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('AC4: one path from extraction to a record', () => {
  it('only confirmExtraction calls applyConfirmed', () => {
    const callers = sources(root).filter((file) =>
      /\.applyConfirmed\(/.test(readFileSync(file, 'utf8')),
    );
    expect(callers.map((file) => path.relative(root, file))).toEqual([
      path.join('services', 'document.service.ts'),
    ]);
    const service = readFileSync(path.join(root, 'services', 'document.service.ts'), 'utf8');
    expect(service.match(/\.applyConfirmed\(/g)).toHaveLength(1);
    const confirm = service.slice(service.indexOf('export async function confirmExtraction'));
    expect(confirm.slice(0, confirm.indexOf('\nexport '))).toContain('.applyConfirmed(');
  });

  it('runExtraction never writes to a record model', () => {
    const service = readFileSync(path.join(root, 'services', 'document.service.ts'), 'utf8');
    const start = service.indexOf('export async function runExtraction');
    const body = service.slice(start, service.indexOf('\nexport ', start + 1));
    expect(body).not.toMatch(/tx\.(quotation|purchaseOrder|invoice)\./);
    expect(body).not.toMatch(/setDocument|applyConfirmed/);
  });
});
