const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// GET /api/activity-log?limit=200 — Administrator-only. Returns login
// (and any other tracked) events, most recent first, for the Admin
// dashboard's Activity Log view.
router.get('/', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const { rows } = await db.query(
    `SELECT id, username, action_type AS "actionType", ip_address AS "ipAddress", created_at AS "createdAt"
     FROM activity_log ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  res.json(rows);
}));

module.exports = router;
