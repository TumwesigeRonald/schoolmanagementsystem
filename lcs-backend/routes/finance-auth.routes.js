/**
 * routes/finance-auth.routes.js — "School Finance" access gate.
 *
 * This is a SECOND password, independent of the user's normal login
 * password, that Admin/Teacher accounts enter to unlock the Finance
 * section for the rest of the browser session. It is stored as its
 * own bcrypt hash on `users.finance_password_hash` (see migrations/
 * schema.sql) — never compared or stored in plain text, and never
 * checked on the client.
 *
 * On success this issues a short-lived, narrowly-scoped JWT
 * (`scope: 'finance'`) separate from the normal login token. The
 * frontend stores it in sessionStorage (api.js's TokenStore pattern)
 * so it disappears when the tab closes, matching how the login token
 * already behaves.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
const HASH_ROUNDS = 10;
// Deliberately shorter than the normal login token (12h) — the whole
// point of this gate is a fresh check-in per browser session, not a
// second all-day pass.
const FINANCE_TOKEN_EXPIRES_IN = '4h';

// Admin, Bursar, and Teacher (view-only once past this gate — see
// EDIT_ROLES in finance.routes.js) all see the "School Finance" nav
// item (renderFinanceNavItem() in script.js) — mirror that here so a
// Student token can never reach this endpoint even directly.
const FINANCE_ROLES = ['Administrator', 'Bursar', 'Teacher'];

// POST /api/finance-auth/verify-password
// Body: { password }
// Returns: { financeToken } on success.
router.post('/verify-password', authenticate, requireRole(...FINANCE_ROLES), asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ message: 'Password is required.' });
  }

  const { rows } = await db.query('SELECT finance_password_hash FROM users WHERE username = $1', [req.user.username]);
  const hash = rows[0] && rows[0].finance_password_hash;

  if (!hash) {
    // No finance password has ever been set for this account — tell the
    // frontend explicitly so it can prompt "set a password" instead of
    // a confusing "incorrect password".
    return res.status(409).json({ message: 'No Finance password has been set for your account yet.', code: 'NOT_SET' });
  }

  const ok = await bcrypt.compare(password, hash);
  if (!ok) {
    return res.status(401).json({ message: 'Incorrect Finance password.' });
  }

  const financeToken = jwt.sign(
    { username: req.user.username, role: req.user.role, scope: 'finance' },
    process.env.JWT_SECRET,
    { expiresIn: FINANCE_TOKEN_EXPIRES_IN }
  );

  return res.json({ financeToken });
}));

// POST /api/finance-auth/set-password
// Body: { currentPassword?, newPassword }
// currentPassword is required only when a Finance password already
// exists (proves whoever is at the keyboard actually knows it before
// they can change it) — omit it for first-time setup.
router.post('/set-password', authenticate, requireRole(...FINANCE_ROLES), asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters.' });
  }

  const { rows } = await db.query('SELECT finance_password_hash FROM users WHERE username = $1', [req.user.username]);
  const existingHash = rows[0] && rows[0].finance_password_hash;

  if (existingHash) {
    if (!currentPassword) {
      return res.status(400).json({ message: 'Current Finance password is required to change it.' });
    }
    const ok = await bcrypt.compare(currentPassword, existingHash);
    if (!ok) {
      return res.status(401).json({ message: 'Current Finance password is incorrect.' });
    }
  }

  const newHash = await bcrypt.hash(newPassword, HASH_ROUNDS);
  await db.query('UPDATE users SET finance_password_hash = $1 WHERE username = $2', [newHash, req.user.username]);

  return res.json({ ok: true });
}));

// GET /api/finance-auth/status
// Lets the frontend know, before opening the modal, whether this
// account has a Finance password set yet — so it can show a
// "create password" flow instead of a "wrong password" one.
router.get('/status', authenticate, requireRole(...FINANCE_ROLES), asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT finance_password_hash FROM users WHERE username = $1', [req.user.username]);
  res.json({ hasPassword: !!(rows[0] && rows[0].finance_password_hash) });
}));

module.exports = router;
