import { describe, expect, it } from 'vitest';
import { isSameOrigin, readCappedBody, TooLargeError } from '../lib/upload.ts';

const streamOf = (...chunks: number[]) =>
  new Request('http://app.test/api/documents', {
    method: 'POST',
    body: new ReadableStream({
      start(controller) {
        for (const size of chunks) controller.enqueue(new Uint8Array(size));
        controller.close();
      },
    }),
    // @ts-expect-error Node's fetch needs this for a stream body
    duplex: 'half',
  });

describe('upload route helpers', () => {
  it('reads a body under the cap', async () => {
    expect((await readCappedBody(streamOf(10, 20), 100)).byteLength).toBe(30);
  });

  it('stops reading once the cap is passed, whatever Content-Length says', async () => {
    await expect(readCappedBody(streamOf(60, 60), 100)).rejects.toBeInstanceOf(TooLargeError);
  });

  it('rejects a declared Content-Length over the cap without reading', async () => {
    const request = new Request('http://app.test/api/documents', {
      method: 'POST',
      headers: { 'content-length': '5000' },
      body: 'x',
    });
    await expect(readCappedBody(request, 100)).rejects.toBeInstanceOf(TooLargeError);
  });

  it('accepts same-origin posts and rejects cross-site ones', () => {
    const post = (headers: Record<string, string>) =>
      new Request('http://internal:3000/api/documents', { method: 'POST', headers });
    const app = 'https://sales.example.com';
    expect(isSameOrigin(post({ origin: app, host: 'sales.example.com' }), app)).toBe(true);
    expect(
      isSameOrigin(post({ origin: 'https://evil.test', host: 'sales.example.com' }), app),
    ).toBe(false);
    expect(isSameOrigin(post({ host: 'sales.example.com' }), app)).toBe(false); // no Origin
    expect(isSameOrigin(post({ origin: app, 'sec-fetch-site': 'cross-site' }), app)).toBe(false);
  });
});
