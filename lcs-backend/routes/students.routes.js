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

// PUT /api/students/:id — Admin only. Edits Student ID, Full Name, Class,
// and Gender. Student ID is the primary key AND the login username
// (users.student_id / users.username), and it's embedded in
// scores.record_key / attendance.record_key ("SUBJECT_studentId" /
// "date_studentId"). None of those foreign keys are ON UPDATE CASCADE,
// so a bare `UPDATE students SET id=...` would fail as soon as the
// student has any scores, attendance, or login history. When the ID
// changes, this inserts the new row first (so children always have a
// valid parent to point to), repoints every dependent row, then drops
// the old row — all inside one transaction. Changing the ID also resets
// the student's login password to the new ID, matching how a password
// is assigned on initial registration.
router.put('/:id', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const currentId = req.params.id;
  const { id: newId, name, class: className, gender } = req.body || {};
  if (!newId || !name || !className) {
    return res.status(400).json({ message: 'id, name and class are required.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM students WHERE id = $1', [currentId]);
    if (!existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Student not found.' });
    }

    if (newId !== currentId) {
      const dupeStudent = await client.query('SELECT id FROM students WHERE id = $1', [newId]);
      if (dupeStudent.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: `A student with ID ${newId} already exists.` });
      }
      const dupeUser = await client.query(
        'SELECT id FROM users WHERE lower(username) = lower($1) AND student_id IS DISTINCT FROM $2',
        [newId, currentId]
      );
      if (dupeUser.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: `Username "${newId}" is already taken.` });
      }

      await client.query(
        'INSERT INTO students (id, name, class, gender) VALUES ($1,$2,$3,$4)',
        [newId, name, className, gender || null]
      );
      await client.query(
        `UPDATE scores SET student_id = $1, record_key = REPLACE(record_key, $2, $1) WHERE student_id = $2`,
        [newId, currentId]
      );
      await client.query(
        `UPDATE attendance SET student_id = $1, record_key = REPLACE(record_key, $2, $1) WHERE student_id = $2`,
        [newId, currentId]
      );
      const passwordHash = await bcrypt.hash(newId, HASH_ROUNDS); // new login password = new Student ID, same as on creation
      await client.query(
        `UPDATE users SET student_id = $1, username = $1, name = $2, password_hash = $3 WHERE student_id = $4`,
        [newId, name, passwordHash, currentId]
      );
      await client.query('DELETE FROM students WHERE id = $1', [currentId]);
    } else {
      await client.query(
        'UPDATE students SET name = $1, class = $2, gender = $3 WHERE id = $4',
        [name, className, gender || null, currentId]
      );
      await client.query('UPDATE users SET name = $1 WHERE student_id = $2', [name, currentId]);
    }

    await client.query('COMMIT');
    res.json({ id: newId, name, class: className, gender: gender || null });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ message: 'That Student ID or username is already in use.' });
    }
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
