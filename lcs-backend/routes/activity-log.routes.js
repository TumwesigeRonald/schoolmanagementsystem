const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// GET /api/activity-log?limit=200 — Administrator-only. Returns login
// (and any other tracked) events, most recent first, for the Admin
// dashboard's Activity Log view.
//
// Wrapped in its own try/catch (rather than just relying on asyncHandler
// + the global error handler) so that a missing/not-yet-migrated table —
// Postgres error 42P01 "undefined_table", which happens on a fresh Neon
// database before `npm run migrate` has been run, e.g. a first deploy to
// Vercel — degrades to an empty log instead of a 500 "Something went
// wrong on the server." A truly unexpected DB error also falls back to
// an empty 200 response rather than crashing the view, since the
// Activity Log is a read-only, non-critical dashboard widget: it's far
// better for the admin to see "No login activity has been recorded yet"
// than a broken page.
router.get('/', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  try {
    const { rows } = await db.query(
      `SELECT id, username, action_type AS "actionType", ip_address AS "ipAddress", created_at AS "createdAt"
       FROM activity_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return res.status(200).json(rows);
  } catch (err) {
    if (err.code === '42P01') {
      // relation "activity_log" does not exist — migrations haven't run yet.
      console.warn('[activity-log] activity_log table does not exist yet (has `npm run migrate` been run?) — returning an empty log.');
      return res.status(200).json([]);
    }
    console.error('[activity-log] query failed — returning an empty log instead of a 500:', err);
    return res.status(200).json([]);
  }
}));

// DELETE /api/activity-log — Administrator-only. Clears every recorded
// login event so the log doesn't grow unbounded. Same 42P01 fallback as
// GET above: on a fresh/not-yet-migrated database there's nothing to
// clear, so that's treated as a successful no-op rather than an error.
router.delete('/', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  try {
    await db.query('DELETE FROM activity_log');
    return res.status(200).json({ message: 'Activity log cleared.' });
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(200).json({ message: 'Activity log cleared.' });
    }
    console.error('[activity-log] clear failed:', err);
    return res.status(500).json({ message: 'Could not clear the activity log.' });
  }
}));

module.exports = router;
