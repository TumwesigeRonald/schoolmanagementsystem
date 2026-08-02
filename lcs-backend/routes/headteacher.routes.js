/**
 * routes/headteacher.routes.js
 * -----------------------------------------------------------
 * Admin-only management of the single "Headteacher" account.
 * Isolated in its own file/route so it never touches the
 * existing Teacher CRUD logic in teachers.routes.js — the
 * Headteacher isn't a row in `teachers`, just a `users` row
 * with role = 'Headteacher' (student_id and teacher_id both
 * NULL), the same pattern the Administrator account already
 * uses.
 *
 * Only one Headteacher account is expected to exist at a time,
 * so GET/PUT operate on "the" account rather than taking an id.
 * -----------------------------------------------------------
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
const HASH_ROUNDS = 10;

// GET /api/headteacher — Admin only. Returns the current Headteacher
// account's public profile (never the password/hash), or null if the
// admin hasn't created one yet.
router.get('/', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT username, name FROM users WHERE role = 'Headteacher' ORDER BY id LIMIT 1`
  );
  res.json(rows[0] || null);
}));

// PUT /api/headteacher — Admin only. Creates the Headteacher account
// if none exists yet, or updates username/name/password on the
// existing one. Password is required on first creation; on update it's
// optional (omit it to leave the current password unchanged).
router.put('/', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { username, password, name } = req.body || {};
  if (!username) {
    return res.status(400).json({ message: 'Username is required.' });
  }

  const existing = await db.query(`SELECT id FROM users WHERE role = 'Headteacher' ORDER BY id LIMIT 1`);
  const current = existing.rows[0];

  // Username must stay unique across every account in the system,
  // whether we're creating a new Headteacher row or renaming the
  // existing one.
  const dupeUser = await db.query(
    'SELECT id FROM users WHERE lower(username) = lower($1) AND id IS DISTINCT FROM $2',
    [username, current ? current.id : null]
  );
  if (dupeUser.rows.length) {
    return res.status(409).json({ message: `Username "${username}" is already taken.` });
  }

  const displayName = (name && name.trim()) || 'Headteacher';

  if (!current) {
    if (!password) {
      return res.status(400).json({ message: 'A password is required to create the Headteacher account.' });
    }
    const passwordHash = await bcrypt.hash(password, HASH_ROUNDS);
    await db.query(
      `INSERT INTO users (username, password_hash, role, name) VALUES ($1, $2, 'Headteacher', $3)`,
      [username, passwordHash, displayName]
    );
    return res.status(201).json({ username, name: displayName });
  }

  if (password) {
    const passwordHash = await bcrypt.hash(password, HASH_ROUNDS);
    await db.query('UPDATE users SET username = $1, name = $2, password_hash = $3 WHERE id = $4', [
      username, displayName, passwordHash, current.id
    ]);
  } else {
    await db.query('UPDATE users SET username = $1, name = $2 WHERE id = $3', [username, displayName, current.id]);
  }

  res.json({ username, name: displayName });
}));

module.exports = router;
