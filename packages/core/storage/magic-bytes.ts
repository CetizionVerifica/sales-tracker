import type { DocumentMimeType } from '../schemas/document.ts';

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/**
 * Whether a file's first bytes match its declared type (M7: a renamed file is rejected).
 * Checked by hand so no file-type dependency is needed.
 */
export function matchesMimeType(bytes: Uint8Array, mimeType: DocumentMimeType): boolean {
  switch (mimeType) {
    case 'application/pdf':
      return startsWith(bytes, ascii('%PDF-'));
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/webp':
      return startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8);
  }
}
