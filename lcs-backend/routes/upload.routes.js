const express = require('express');
const multer = require('multer');
const router = express.Router();
const { put } = require('@vercel/blob');

// This endpoint previously handed the raw (still multipart-encoded) request
// stream straight to Blob's put() — that stores the multipart envelope
// itself (boundaries, headers, other fields and all) as the file, not the
// actual uploaded file, and offered no size guard, so a large upload could
// exceed Vercel's request body limit with no clear error. multer.memoryStorage()
// parses the file into a Buffer in memory (no disk writes — Vercel's
// filesystem is read-only) so the real file bytes are what gets stored.
const RESOURCE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: RESOURCE_UPLOAD_MAX_BYTES } });

router.post('/', (req, res) => {
  upload.single('file')(req, res, async (multerErr) => {
    if (multerErr) {
      console.error('[upload] multer error while parsing the upload:', multerErr);
      if (multerErr.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: `That file is too large. Maximum allowed upload size is ${RESOURCE_UPLOAD_MAX_BYTES / (1024 * 1024)}MB.`
        });
      }
      return res.status(400).json({ error: `Could not process the uploaded file (${multerErr.message || 'invalid upload'}).` });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file was included in the upload.' });
    }
    try {
      const filename = req.file.originalname || req.query.filename || 'school-document';
      const blob = await put(filename, req.file.buffer, {
        access: 'public',
        addRandomSuffix: true
      });

      res.status(200).json({
        message: 'File uploaded successfully',
        url: blob.url
      });
    } catch (error) {
      console.error(`[upload] Blob upload error for "${req.file.originalname}" (${req.file.size} bytes):`, error);
      res.status(502).json({ error: 'Failed to upload file to Vercel Blob storage.' });
    }
  });
});

module.exports = router;