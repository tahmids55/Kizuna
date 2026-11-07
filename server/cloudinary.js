import { v2 as cloudinary } from 'cloudinary';

export function isCloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );
}

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (!isCloudinaryConfigured()) return;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
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
