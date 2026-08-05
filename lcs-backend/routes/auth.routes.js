const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { logActivity } = require('../lib/activityLog');

const router = express.Router();
const HASH_ROUNDS = 10;

function toPublicUser(user) {
  return {
    username: user.username,
    role: user.role,
    name: user.name,
    studentId: user.student_id,
    teacherId: user.teacher_id
  };
}

// POST /api/auth/login
router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  const { rows } = await db.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  const user = rows[0];
  if (!user) {
    return res.status(401).json({ message: 'Invalid username or password.' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ message: 'Invalid username or password.' });
  }

  const publicUser = toPublicUser(user);
  const token = jwt.sign(publicUser, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '12h'
  });

  // Fire-and-forget: logActivity() catches its own errors, so this never
  // delays or fails the login response itself.
  logActivity(publicUser.username, 'LOGIN', req.ip);

  return res.json({ token, user: publicUser });
}));

// POST /api/auth/logout
// JWTs are stateless, so there's nothing to invalidate server-side —
// this just gives the frontend a clean endpoint to call. The client
// is responsible for discarding the token (api.js already does this).
router.post('/logout', (req, res) => {
  res.json({ ok: true });
});

// GET /api/auth/me — returns the current session's profile.
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Current and new password are required.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters.' });
  }

  const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [req.user.username]);
  const user = rows[0];
  if (!user) return res.status(404).json({ message: 'User not found.' });

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ message: 'Current password is incorrect.' });

  const newHash = await bcrypt.hash(newPassword, HASH_ROUNDS);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);

  res.json({ ok: true });
}));

module.exports = router;
