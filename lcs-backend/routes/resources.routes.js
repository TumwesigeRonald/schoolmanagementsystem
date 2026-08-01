const express = require('express');
const multer = require('multer');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { uploadResourceFile } = require('../lib/storage');

const router = express.Router();

// Files are streamed into memory then handed to the cloud storage helper —
// nothing is written to the (ephemeral) local disk on Vercel.
// NOTE: Vercel's serverless functions hard-cap the incoming request body at
// ~4.5MB regardless of what multer is configured to accept — a request
// larger than that is rejected by the platform before Express even runs,
// which is why the old 8MB limit here produced an opaque "Something went
// wrong on the server" failure instead of a clear message. 4MB leaves
// headroom for multipart/form-data overhead (boundaries, headers, the
// other form fields) so real uploads stay comfortably under the hard cap.
const RESOURCE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: RESOURCE_UPLOAD_MAX_BYTES } });

// Multer throws a MulterError (e.g. LIMIT_FILE_SIZE) *inside* the
// upload.single('file') middleware, before our asyncHandler route body
// ever runs — asyncHandler can't catch it. Left uncaught, it fell through
// to Express's generic error handler, which returned the generic
// "Something went wrong on the server" message for what is really just an
// oversized file. This wraps multer so that case gets a clear, specific
// 413 response instead of crashing into the generic handler.
function handleResourceUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    console.error('[resources.upload] multer error while parsing the upload:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        message: `That file is too large. Maximum allowed upload size is ${RESOURCE_UPLOAD_MAX_BYTES / (1024 * 1024)}MB.`
      });
    }
    return res.status(400).json({ message: `Could not process the uploaded file (${err.message || 'invalid upload'}).` });
  });
}

// Shared row -> API shape mapper, kept in one place so GET and POST /upload
// always return identically-shaped resource objects to the frontend.
const RESOURCE_SELECT = `
  SELECT id, title, subject,
         class_level  AS "level",
         file_name    AS "fileName",
         file_type    AS "fileType",
         file_size    AS "fileSize",
         file_url     AS "fileUrl",
         file_data    AS "fileData",
         uploaded_by  AS "uploadedBy",
         created_at   AS "createdAt"
  FROM resources
`;

function toPublicResource(row) {
  // If the file lives in Vercel Blob, fileUrl is already a permanent public URL.
  // If it was stored as base64 (Blob not configured yet), rebuild a data: URL
  // so the existing download link still works.
  const fileUrl = row.fileUrl || (row.fileData ? `data:${row.fileType || 'application/octet-stream'};base64,${row.fileData}` : null);
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    level: row.level,
    fileName: row.fileName,
    fileType: row.fileType,
    fileSize: row.fileSize,
    fileUrl,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
    uploadedAt: row.createdAt ? new Date(row.createdAt).getTime() : Date.now()
  };
}

// GET /api/resources — everyone can view/download (Students are view-only).
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { rows } = await db.query(`${RESOURCE_SELECT} ORDER BY created_at DESC`);
  res.json(rows.map(toPublicResource));
}));

// POST /api/resources/upload — Admin or Teacher only.
// Stores the file in Vercel Blob when configured, and falls back to
// base64-in-Postgres otherwise — see lib/storage.js.
router.post('/upload', authenticate, requireRole('Administrator', 'Teacher'), handleResourceUpload, asyncHandler(async (req, res) => {
  // NOTE: the frontend's upload form sends the target level as "level"
  // (not "classLevel") — match that field name here.
  const { title, subject, level } = req.body || {};
  if (!title || !req.file) {
    return res.status(400).json({ message: 'title and a file are required.' });
  }

  let fileUrl, fileData;
  try {
    ({ fileUrl, fileData } = await uploadResourceFile(req.file.buffer, req.file.originalname));
  } catch (err) {
    console.error(`[resources.upload] file storage failed for "${req.file.originalname}" (${req.file.size} bytes):`, err);
    return res.status(502).json({ message: 'Could not store the uploaded file. Please try again in a moment.' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO resources (title, subject, class_level, file_name, file_type, file_size, file_url, file_data, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, title, subject, class_level AS "level", file_name AS "fileName", file_type AS "fileType",
                 file_size AS "fileSize", file_url AS "fileUrl", file_data AS "fileData",
                 uploaded_by AS "uploadedBy", created_at AS "createdAt"`,
      [title, subject || null, level || null, req.file.originalname, req.file.mimetype, req.file.size, fileUrl, fileData, req.user.name]
    );
    res.status(201).json(toPublicResource(rows[0]));
  } catch (err) {
    console.error(`[resources.upload] saving resource metadata to the database failed for "${title}":`, err);
    return res.status(500).json({ message: 'The file was stored but saving its record failed. Please try again.' });
  }
}));

// DELETE /api/resources/:id — Admin can delete any; Teacher only their own upload.
router.delete('/:id', authenticate, requireRole('Administrator', 'Teacher'), asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT uploaded_by AS "uploadedBy" FROM resources WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Resource not found.' });
  if (req.user.role !== 'Administrator' && rows[0].uploadedBy !== req.user.name) {
    return res.status(403).json({ message: 'You can only delete resources you uploaded.' });
  }
  await db.query('DELETE FROM resources WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
