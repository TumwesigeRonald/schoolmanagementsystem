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
 *      IMPORTANT: set the store's Access to **Public** when you create it.
 *      Every URL this app hands back (student photos, resource downloads)
 *      is rendered straight into <img src>/<a href> with no auth header,
 *      which only works against a public-access store. Access mode can't
 *      be changed after a store is created, so a private store has to be
 *      replaced with a new public one, not reconfigured.
 *   2. For local dev, run `vercel env pull` (or copy the token from the
 *      dashboard) into your local .env as BLOB_READ_WRITE_TOKEN.
 *
 * If that token isn't set yet, or the Blob call fails, uploads fall back to
 * storing the file as base64 in Postgres so the upload feature keeps
 * working — but only up to BASE64_FALLBACK_MAX_BYTES (see below). Base64
 * bloats whatever column it's stored in by about a third, and Postgres
 * rows/pages don't handle a pile of multi-MB text values well, so beyond
 * that size we reject outright and surface the real error instead of
 * silently writing something huge into the database.
 */
const hasBlobConfig = !!process.env.BLOB_READ_WRITE_TOKEN;

let blobPut = null;
if (hasBlobConfig) {
  ({ put: blobPut } = require('@vercel/blob'));
} else {
  console.warn('[storage] BLOB_READ_WRITE_TOKEN not set — resource uploads will fall back to storing base64 in Postgres. Connect a Vercel Blob store to this project (or set the token locally) to store files permanently.');
}

// Cap on how large a file we're willing to base64-encode into a Postgres
// column. Multer already caps the raw upload at 4MB (see the routes), but
// base64 inflates that by ~33% — a 4MB file becomes ~5.3MB of text — so this
// is intentionally tighter than the upload cap, not equal to it.
const BASE64_FALLBACK_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Throws a clear, actionable error if `buffer` is too large to fall back to
 * base64-in-Postgres, instead of letting a multi-MB text value get written
 * into the database. Call this immediately before any base64 fallback.
 */
function assertFallbackSizeOk(buffer, contextLabel) {
  if (buffer.length > BASE64_FALLBACK_MAX_BYTES) {
    throw new Error(
      `${contextLabel}: file is ${(buffer.length / (1024 * 1024)).toFixed(1)}MB, which is too large to fall back ` +
      `to base64-in-Postgres storage (limit ${BASE64_FALLBACK_MAX_BYTES / (1024 * 1024)}MB). Vercel Blob needs to ` +
      'be working (and connected as a *public* store) for files this size — see lib/storage.js for setup notes.'
    );
  }
}

function toDataUrl(buffer, mimetype) {
  return `data:${mimetype || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
}

/**
 * Turns a Vercel Blob SDK error into a one-line diagnosis of the likely
 * cause, so logs point straight at the fix instead of just showing a raw
 * SDK exception.
 */
function describeBlobError(err) {
  const message = (err && err.message) || String(err);
  if (/private store/i.test(message)) {
    return 'the connected Blob store was created with *private* access, but this app always requests `access: "public"` ' +
      '(it needs directly-fetchable URLs for <img>/<a> tags). Access mode can\'t be changed on an existing store — ' +
      'create a new Blob store with Access: Public in the Vercel dashboard and connect it to this project instead.';
  }
  return 'check that a Blob store is still connected to this project and BLOB_READ_WRITE_TOKEN matches it ' +
    '(Vercel dashboard -> Storage) — common causes are a stale/rotated token, the store being disconnected or ' +
    'recreated, or the account\'s Blob quota being exceeded.';
}

/**
 * Uploads a file buffer.
 * Returns { fileUrl, fileData } — exactly one of the two will be set:
 *   - fileUrl  when Vercel Blob is configured (the file lives in Blob storage,
 *              blob.url is a permanent public URL)
 *   - fileData when it isn't (base64 fallback, stored in Postgres) — only
 *              returned when the file is under BASE64_FALLBACK_MAX_BYTES;
 *              otherwise this function throws.
 */
async function uploadResourceFile(buffer, originalName) {
  if (!hasBlobConfig) {
    assertFallbackSizeOk(buffer, `[storage] "${originalName}"`);
    return { fileUrl: null, fileData: buffer.toString('base64') };
  }
  // A timestamped, sanitized pathname keeps filenames unique in the Blob
  // store even when two people upload files with the same name.
  const safeName = originalName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const pathname = `lcs-portal-resources/${Date.now()}-${safeName}`;

  try {
    const blob = await blobPut(pathname, buffer, {
      access: 'public',
      addRandomSuffix: true,
      token: process.env.BLOB_READ_WRITE_TOKEN
    });
    return { fileUrl: blob.url, fileData: null };
  } catch (err) {
    // BLOB_READ_WRITE_TOKEN is set but the call to Vercel Blob still failed.
    // Previously this exception propagated straight up and the whole
    // upload was rejected with a generic "Could not store the uploaded
    // file" error, even though nothing is actually wrong with the file
    // itself.
    //
    // Log the *real* reason, with a concrete diagnosis, so it can be fixed
    // instead of just noticed — then fall back to base64-in-Postgres (same
    // path used when no token is configured at all) as long as the file is
    // small enough that doing so is reasonable; otherwise let the caller's
    // own error handling take over.
    console.error(
      `[storage] Vercel Blob upload failed for "${originalName}" — ${describeBlobError(err)}`,
      err
    );
    assertFallbackSizeOk(buffer, `[storage] "${originalName}"`);
    return { fileUrl: null, fileData: buffer.toString('base64') };
  }
}

module.exports = {
  uploadResourceFile,
  hasBlobConfig,
  BASE64_FALLBACK_MAX_BYTES,
  assertFallbackSizeOk,
  toDataUrl,
  describeBlobError
};
