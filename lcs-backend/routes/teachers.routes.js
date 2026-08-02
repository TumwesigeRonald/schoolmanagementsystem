const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
const HASH_ROUNDS = 10;

// GET /api/teachers — Admin and Teacher can both see the staff list
// (frontend shows the "teachers" tab to both; Teachers just can't edit others).
router.get('/', authenticate, requireRole('Administrator', 'Teacher'), asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT id, name, username, subject FROM teachers ORDER BY id');
  res.json(rows);
}));

// POST /api/teachers — Admin only. Creates the teacher record + login.
router.post('/', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { id, name, username, password, subject } = req.body || {};
  if (!id || !name || !username || !password) {
    return res.status(400).json({ message: 'id, name, username and password are required.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const dupeId = await client.query('SELECT id FROM teachers WHERE id = $1', [id]);
    if (dupeId.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `A teacher with ID ${id} already exists.` });
    }
    const dupeUser = await client.query('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
    if (dupeUser.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Username "${username}" is already taken.` });
    }

    await client.query(
      'INSERT INTO teachers (id, name, username, subject) VALUES ($1,$2,$3,$4)',
      [id, name, username, subject || null]
    );
    const passwordHash = await bcrypt.hash(password, HASH_ROUNDS);
    await client.query(
      `INSERT INTO users (username, password_hash, role, name, teacher_id) VALUES ($1,$2,'Teacher',$3,$4)`,
      [username, passwordHash, name, id]
    );

    await client.query('COMMIT');
    res.status(201).json({ id, name, username, subject: subject || null });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// PUT /api/teachers/:id — Admin can edit anyone; a Teacher can edit only
// their own profile (name/subject/username), matching canManageTeachers
// being false-but-self-editable in the frontend's ROLE_PERMISSIONS.
router.put('/:id', authenticate, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const isSelf = req.user.role === 'Teacher' && req.user.teacherId === id;
  if (req.user.role !== 'Administrator' && !isSelf) {
    return res.status(403).json({ message: 'You can only edit your own profile.' });
  }

  const { name, username, subject } = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (subject !== undefined) { fields.push(`subject = $${i++}`); values.push(subject); }
  if (username !== undefined) { fields.push(`username = $${i++}`); values.push(username); }
  if (!fields.length) return res.status(400).json({ message: 'Nothing to update.' });

  values.push(id);
  const { rows, rowCount } = await db.query(
    `UPDATE teachers SET ${fields.join(', ')} WHERE id = $${i} RETURNING id, name, username, subject`,
    values
  );
  if (!rowCount) return res.status(404).json({ message: 'Teacher not found.' });

  // Keep the login username in sync if it changed.
  if (username !== undefined) {
    await db.query('UPDATE users SET username = $1, name = COALESCE($2, name) WHERE teacher_id = $3', [username, name || null, id]);
  } else if (name !== undefined) {
    await db.query('UPDATE users SET name = $1 WHERE teacher_id = $2', [name, id]);
  }

  res.json(rows[0]);
}));

// DELETE /api/teachers/:id — Admin only.
router.delete('/:id', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM teachers WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ message: 'Teacher not found.' });
  res.json({ ok: true });
}));

// POST /api/teachers/:id/reset-password — Admin only.
router.post('/:id/reset-password', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) {
    return res.status(400).json({ message: 'A new password of at least 6 characters is required.' });
  }
  const passwordHash = await bcrypt.hash(password, HASH_ROUNDS);
  const { rowCount } = await db.query('UPDATE users SET password_hash = $1 WHERE teacher_id = $2', [passwordHash, req.params.id]);
  if (!rowCount) return res.status(404).json({ message: 'Teacher login not found.' });
  res.json({ ok: true });
}));

module.exports = router;
