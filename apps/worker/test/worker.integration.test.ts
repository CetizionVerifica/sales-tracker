import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));

describe('worker process (integration: real Redis)', () => {
  it('starts, reports ready and exits cleanly on SIGTERM', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', main], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

    await expect.poll(() => output, { timeout: 15_000, interval: 100 }).toContain('worker ready');

    const exitCode = new Promise<number | null>((resolve) => child.on('exit', resolve));
    child.kill('SIGTERM');
    expect(await exitCode).toBe(0);
    expect(output).toContain('worker stopped');
  });
});
