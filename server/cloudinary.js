import { v2 as cloudinary } from 'cloudinary';

export const DEFAULT_CLOUDINARY_API_KEY = '993251399583494';
export const DEFAULT_CLOUDINARY_API_SECRET = 'MZzlEsgFsg9uxXHK2nwYuq9xX3M';

export function isCloudinaryConfigured() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY || DEFAULT_CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET || DEFAULT_CLOUDINARY_API_SECRET;
  return Boolean(cloudName && apiKey && apiSecret);
}

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (!isCloudinaryConfigured()) return;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY || DEFAULT_CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET || DEFAULT_CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
}

/**
 * Upload a file buffer to Cloudinary using streaming upload.
 */
export async function uploadToCloudinary(buffer, { folder = 'kizuna', resourceType = 'auto', filename = 'file' } = {}) {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        public_id: `${Date.now()}-${filename.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50)}`,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}
