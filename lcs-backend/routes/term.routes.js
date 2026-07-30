const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// GET /api/settings/term — everyone can read (report cards need it).
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT term, year, next_begins AS "nextBegins", next_ends AS "nextEnds" FROM term_settings WHERE id = 1`
  );
  if (!rows.length) {
    return res.json({ term: 'Term 1', year: new Date().getFullYear(), nextBegins: '', nextEnds: '' });
  }
  res.json(rows[0]);
}));

// PUT /api/settings/term — Admin only (canManageTerm is Admin-only in the frontend).
router.put('/', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { term, year, nextBegins, nextEnds } = req.body || {};
  const { rows } = await db.query(
    `INSERT INTO term_settings (id, term, year, next_begins, next_ends, updated_at)
     VALUES (1, $1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE SET
       term = EXCLUDED.term, year = EXCLUDED.year,
       next_begins = EXCLUDED.next_begins, next_ends = EXCLUDED.next_ends,
       updated_at = now()
     RETURNING term, year, next_begins AS "nextBegins", next_ends AS "nextEnds"`,
    [term || 'Term 1', year || new Date().getFullYear(), nextBegins || null, nextEnds || null]
  );
  res.json(rows[0]);
}));

module.exports = router;
