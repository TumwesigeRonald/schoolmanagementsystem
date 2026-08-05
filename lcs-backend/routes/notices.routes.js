const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// Shared row -> API shape mapper. `date` is derived from created_at so the
// frontend (which renders/sorts on a plain YYYY-MM-DD string) doesn't need
// to know about timestamps.
function toPublicNotice(row) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    author: row.author,
    date: row.createdAt ? new Date(row.createdAt).toISOString().slice(0, 10) : null,
    createdAt: row.createdAt
  };
}

const NOTICE_SELECT = `
  SELECT id, title, message, author, created_at AS "createdAt"
  FROM notices
`;

// GET /api/notices — any authenticated user (Admin/Teacher see this on the
// Dashboard's notice board; Students don't have a "dashboard" tab, so this
// never reaches them in the UI, but the route itself isn't Admin-only).
router.get('/', authenticate, asyncHandler(async (req, res) => {
  try {
    const { rows } = await db.query(`${NOTICE_SELECT} ORDER BY created_at DESC`);
    return res.status(200).json(rows.map(toPublicNotice));
  } catch (err) {
    if (err.code === '42P01') {
      // relation "notices" does not exist yet — migrations haven't run.
      console.warn('[notices] notices table does not exist yet (has `npm run migrate` been run?) — returning an empty board.');
      return res.status(200).json([]);
    }
    console.error('[notices] query failed — returning an empty board instead of a 500:', err);
    return res.status(200).json([]);
  }
}));

// POST /api/notices — Administrator-only. Posts a new notice.
router.post('/', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { title, message } = req.body || {};
  if (!title || !title.trim() || !message || !message.trim()) {
    return res.status(400).json({ message: 'title and message are required.' });
  }
  const author = req.user.name || req.user.username;
  const { rows } = await db.query(
    `INSERT INTO notices (title, message, author) VALUES ($1, $2, $3)
     RETURNING id, title, message, author, created_at AS "createdAt"`,
    [title.trim(), message.trim(), author]
  );
  res.status(201).json(toPublicNotice(rows[0]));
}));

// DELETE /api/notices?id=... — Administrator-only. Deletes a single notice
// directly from the database; the frontend only removes it from view after
// this confirms success, so a deleted notice never reappears on reload.
router.delete('/', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ message: 'id query parameter is required, e.g. DELETE /api/notices?id=3' });
  }
  const { rowCount } = await db.query('DELETE FROM notices WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ message: 'Notice not found.' });
  res.status(200).json({ ok: true });
}));

module.exports = router;
