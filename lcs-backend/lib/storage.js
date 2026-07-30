/**
 * lib/storage.js — resource-panel file storage.
 *
 * On Vercel, anything written to the local filesystem disappears when the
 * serverless instance recycles ("file wasn't available on site" errors),
 * so uploaded files go to Vercel Blob instead — a permanent, publicly
 * addressable object store that's already integrated with Vercel deploys.
 *
 * Setup:
 *   1. In the Vercel dashboard: Storage -> Create Database -> Blob,
 *      then connect it to this project. Vercel automatically injects
 *      BLOB_READ_WRITE_TOKEN into your deployment's environment — no
 *      manual token copying needed in production.
 *   2. For local dev, run `vercel env pull` (or copy the token from the
 *      dashboard) into your local .env as BLOB_READ_WRITE_TOKEN.
 *
 * If that token isn't set yet, uploads fall back to storing the file as
 * base64 in the `resources.file_data` column (same behaviour as before)
 * so the upload feature keeps working while Blob is being set up — it
 * just won't scale well for large files or many uploads, and is why you
 * should set BLOB_READ_WRITE_TOKEN as soon as you can.
 */
const hasBlobConfig = !!process.env.BLOB_READ_WRITE_TOKEN;

let blobPut = null;
if (hasBlobConfig) {
  ({ put: blobPut } = require('@vercel/blob'));
} else {
  console.warn('[storage] BLOB_READ_WRITE_TOKEN not set — resource uploads will fall back to storing base64 in Postgres. Connect a Vercel Blob store to this project (or set the token locally) to store files permanently.');
}

/**
 * Uploads a file buffer.
 * Returns { fileUrl, fileData } — exactly one of the two will be set:
 *   - fileUrl  when Vercel Blob is configured (the file lives in Blob storage,
 *              blob.url is a permanent public URL)
 *   - fileData when it isn't (base64 fallback, stored in Postgres)
 */
async function uploadResourceFile(buffer, originalName) {
  if (!hasBlobConfig) {
    return { fileUrl: null, fileData: buffer.toString('base64') };
  }
  // A timestamped, sanitized pathname keeps filenames unique in the Blob
  // store even when two people upload files with the same name.
  const safeName = originalName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const pathname = `lcs-portal-resources/${Date.now()}-${safeName}`;

  const blob = await blobPut(pathname, buffer, {
    access: 'public',
    addRandomSuffix: true,
    token: process.env.BLOB_READ_WRITE_TOKEN
  });
  return { fileUrl: blob.url, fileData: null };
}

module.exports = { uploadResourceFile, hasBlobConfig };
