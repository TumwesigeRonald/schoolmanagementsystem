const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
const HASH_ROUNDS = 10;

// GET /api/students
// Admin/Teacher: full registry. Student: only their own record
// (defense in depth — the frontend already hides this tab for Students).
router.get('/', authenticate, asyncHandler(async (req, res) => {
  if (req.user.role === 'Student') {
    const { rows } = await db.query('SELECT id, name, class, gender FROM students WHERE id = $1', [req.user.studentId]);
    return res.json(rows);
  }
  const { rows } = await db.query('SELECT id, name, class, gender FROM students ORDER BY id');
  res.json(rows);
}));

// POST /api/students — Admin only (matches canManageStudents in api.js).
// Also provisions a login for the student (username = id, default
// password = id) so they can access the portal immediately.
router.post('/', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { id, name, class: className, gender } = req.body || {};
  if (!id || !name || !className) {
    return res.status(400).json({ message: 'id, name and class are required.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM students WHERE id = $1', [id]);
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `A student with ID ${id} already exists.` });
    }

    await client.query(
      'INSERT INTO students (id, name, class, gender) VALUES ($1,$2,$3,$4)',
      [id, name, className, gender || null]
    );

    const passwordHash = await bcrypt.hash(id, HASH_ROUNDS); // default password = student ID
    await client.query(
      `INSERT INTO users (username, password_hash, role, name, student_id)
       VALUES ($1,$2,'Student',$3,$4)`,
      [id, passwordHash, name, id]
    );

    await client.query('COMMIT');
    res.status(201).json({ id, name, class: className, gender: gender || null });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// DELETE /api/students/:id — Admin only. Cascades to users/scores/attendance.
router.delete('/:id', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM students WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ message: 'Student not found.' });
  res.json({ ok: true });
}));

module.exports = router;
