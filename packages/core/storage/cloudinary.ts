import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { getEnv } from '../env.ts';
import { formatOf, type FileStore } from './types.ts';

/**
 * Cloudinary storage (M7 Decision 3): `authenticated` delivery, so no asset has a public
 * URL; every view gets a short-lived signed download link after a permission check. PDFs
 * upload as `image` so Cloudinary can render previews (see the M7 risks on PDF delivery).
 * The original filename is never part of the public_id.
 */
export function createCloudinaryFileStore(): FileStore {
  const env = getEnv();
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });

  const downloadUrl = (storageKey: string, resourceType: string, mimeType: string, ttl: number) =>
    cloudinary.utils.private_download_url(storageKey, formatOf(mimeType), {
      resource_type: resourceType as 'image' | 'raw',
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + ttl,
    });

  return {
    put({ bytes, folder }) {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder,
            public_id: crypto.randomUUID(),
            resource_type: 'image',
            type: 'authenticated',
            overwrite: false,
          },
          (error, result?: UploadApiResponse) => {
            if (error || !result) reject(error ?? new Error('Cloudinary upload failed'));
            else resolve({ storageKey: result.public_id, resourceType: result.resource_type });
          },
        );
        stream.end(Buffer.from(bytes));
      });
    },
    async get({ storageKey, resourceType, mimeType }) {
      const response = await fetch(downloadUrl(storageKey, resourceType, mimeType, 60));
      if (!response.ok) throw new Error(`Cloudinary download failed (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async remove({ storageKey, resourceType }) {
      await cloudinary.uploader.destroy(storageKey, {
        resource_type: resourceType as 'image' | 'raw',
        type: 'authenticated',
        invalidate: true,
      });
    },
    signedUrl({ storageKey, resourceType, mimeType }, ttlSeconds) {
      return downloadUrl(storageKey, resourceType, mimeType, ttlSeconds);
    },
  };
}
