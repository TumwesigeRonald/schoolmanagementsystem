/**
 * routes/admin-staff.routes.js — Administrator-only management of the
 * three Finance-tier staff roles: Bursar, Human Resource, Director.
 *
 * Mounted at /api/admin. Every route here requires `authenticate` AND
 * `requireRole('Administrator')` — this is a SEPARATE gate from the
 * Finance password (finance-auth.routes.js): creating/resetting a staff
 * account is an Administrator-only capability regardless of Finance
 * unlock state, and does not itself grant the new account any Finance
 * access — that account still has to pass its own Finance gate the
 * first time it logs in and opens "School Finance", exactly like Bursar
 * always has.
 *
 * Deliberately scoped to ONLY these three roles (MANAGEABLE_ROLES below)
 * — Administrator, Teacher, and Student accounts are provisioned through
 * their own existing flows (the initial DB seed, and
 * routes/teachers.routes.js / routes/students.routes.js respectively)
 * and are intentionally untouchable through this file, including via
 * PUT/DELETE, so this endpoint can never be used to rename/delete/
 * demote an Administrator or Teacher account.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { logActivity } = require('../lib/activityLog');

const router = express.Router();
const HASH_ROUNDS = 10;

const MANAGEABLE_ROLES = ['Bursar', 'Human Resource', 'Director'];

router.use(authenticate, requireRole('Administrator'));

function toPublicStaff(row) {
  return { username: row.username, name: row.name, role: row.role, createdAt: row.created_at };
}

/* ------------------------------ List staff ------------------------------ */

// GET /api/admin/staff — every Bursar/Human Resource/Director account.
router.get('/staff', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT username, name, role, created_at
     FROM users WHERE role = ANY($1)
     ORDER BY role, name`,
    [MANAGEABLE_ROLES]
  );
  res.json(rows.map(toPublicStaff));
}));

/* ------------------------------ Create staff ------------------------------ */

// POST /api/admin/create-staff — { username, password, fullName, role }
router.post('/create-staff', asyncHandler(async (req, res) => {
  const { username, password, fullName, role } = req.body || {};

  if (!username || !password || !fullName || !role) {
    return res.status(400).json({ message: 'username, password, fullName and role are required.' });
  }
  if (!MANAGEABLE_ROLES.includes(role)) {
    return res.status(400).json({ message: `role must be one of: ${MANAGEABLE_ROLES.join(', ')}.` });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters.' });
  }

  const cleanUsername = String(username).trim();
  const { rows: existing } = await db.query(
    'SELECT username FROM users WHERE lower(username) = lower($1)',
    [cleanUsername]
  );
  if (existing.length) {
    return res.status(409).json({ message: `Username "${cleanUsername}" is already taken.` });
  }

  const passwordHash = await bcrypt.hash(password, HASH_ROUNDS);
  const { rows } = await db.query(
    `INSERT INTO users (username, password_hash, role, name)
     VALUES ($1,$2,$3,$4)
     RETURNING username, name, role, created_at`,
    [cleanUsername, passwordHash, role, String(fullName).trim()]
  );

  await logActivity(req.user.username, `Created a ${role} staff account (${cleanUsername})`, req.ip);
  res.status(201).json(toPublicStaff(rows[0]));
}));

/* --------------------------- Update staff details --------------------------- */

// PUT /api/admin/staff/:username — update fullName and/or role. Only ever
// matches a row whose CURRENT role is already one of MANAGEABLE_ROLES, so
// this can't be pointed at an Administrator/Teacher/Student account.
router.put('/staff/:username', asyncHandler(async (req, res) => {
  const { fullName, role } = req.body || {};
  if (role && !MANAGEABLE_ROLES.includes(role)) {
    return res.status(400).json({ message: `role must be one of: ${MANAGEABLE_ROLES.join(', ')}.` });
  }

  const { rows } = await db.query(
    `UPDATE users SET
       name = COALESCE($1, name),
       role = COALESCE($2::user_role, role)
     WHERE lower(username) = lower($3) AND role = ANY($4)
     RETURNING username, name, role, created_at`,
    [fullName ? String(fullName).trim() : null, role || null, req.params.username, MANAGEABLE_ROLES]
  );
  if (!rows.length) return res.status(404).json({ message: 'Staff account not found.' });

  await logActivity(req.user.username, `Updated staff account ${req.params.username}`, req.ip);
  res.json(toPublicStaff(rows[0]));
}));

/* ------------------------------ Reset password ------------------------------ */

// POST /api/admin/staff/:username/reset-password — { newPassword }
router.post('/staff/:username/reset-password', asyncHandler(async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ message: 'newPassword must be at least 6 characters.' });
  }

  const passwordHash = await bcrypt.hash(newPassword, HASH_ROUNDS);
  const { rows } = await db.query(
    `UPDATE users SET password_hash = $1
     WHERE lower(username) = lower($2) AND role = ANY($3)
     RETURNING username`,
    [passwordHash, req.params.username, MANAGEABLE_ROLES]
  );
  if (!rows.length) return res.status(404).json({ message: 'Staff account not found.' });

  await logActivity(req.user.username, `Reset the login password for staff account ${req.params.username}`, req.ip);
  res.json({ ok: true });
}));

/* -------------------------------- Delete staff -------------------------------- */

// DELETE /api/admin/staff/:username
router.delete('/staff/:username', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `DELETE FROM users WHERE lower(username) = lower($1) AND role = ANY($2) RETURNING username`,
    [req.params.username, MANAGEABLE_ROLES]
  );
  if (!rows.length) return res.status(404).json({ message: 'Staff account not found.' });

  await logActivity(req.user.username, `Deleted staff account ${req.params.username}`, req.ip);
  res.json({ ok: true });
}));

module.exports = router;
