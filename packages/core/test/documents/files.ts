/** Tiny valid-looking files for tests. Each call can be made unique so hashes differ. */
const encoder = new TextEncoder();

export function samplePdf(text: string): Uint8Array {
  return encoder.encode(
    `%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
  );
}

export function samplePng(extra = ''): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...encoder.encode(extra)]);
}

export function sampleJpeg(extra = ''): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...encoder.encode(extra)]);
}

export function sampleWebp(extra = ''): Uint8Array {
  return new Uint8Array([
    ...encoder.encode('RIFF'),
    0x24,
    0,
    0,
    0,
    ...encoder.encode('WEBPVP8 '),
    ...encoder.encode(extra),
  ]);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex');
}
