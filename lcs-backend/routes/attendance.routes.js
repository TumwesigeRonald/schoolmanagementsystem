const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// GET /api/attendance?class=S.4&date=2026-07-27&since=2026-01-01&studentId=LCS/001
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { class: classLevel, date, since, studentId } = req.query;

  if (req.user.role === 'Student') {
    const { rows } = await db.query(
      `SELECT record_key AS "recordKey", date, student_id AS "studentId", status
       FROM attendance WHERE student_id = $1 ORDER BY date DESC`,
      [req.user.studentId]
    );
    return res.json(rows);
  }

  const conditions = [];
  const values = [];
  let i = 1;
  if (classLevel) { conditions.push(`class_level = $${i++}`); values.push(classLevel); }
  if (date) { conditions.push(`date = $${i++}`); values.push(date); }
  // "since" scopes to a rolling recent window (e.g. the day-to-day register)
  // instead of the entire attendance history — every day is its own row, so
  // an unfiltered query grows without bound as terms/years accumulate.
  if (since) { conditions.push(`date >= $${i++}`); values.push(since); }
  // "studentId" scopes to one learner's full history — used only when
  // actually computing that student's report-card attendance summary,
  // rather than pulling every student's history to get one of them.
  if (studentId) { conditions.push(`student_id = $${i++}`); values.push(studentId); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT record_key AS "recordKey", date, student_id AS "studentId", class_level AS "classLevel", status
     FROM attendance ${where} ORDER BY date DESC, student_id`,
    values
  );
  res.json(rows);
}));

// POST /api/attendance — set a single student's status for a date.
// Body: { date, studentId, status }
router.post('/', authenticate, requireRole('Administrator', 'Teacher', 'Headteacher'), asyncHandler(async (req, res) => {
  const { date, studentId, status } = req.body || {};
  if (!date || !studentId || !status) {
    return res.status(400).json({ message: 'date, studentId and status are required.' });
  }

  const student = await db.query('SELECT class FROM students WHERE id = $1', [studentId]);
  if (!student.rows.length) {
    return res.status(404).json({ message: `Student ${studentId} not found.` });
  }

  const recordKey = `${date}_${studentId}`;
  const { rows } = await db.query(
    `INSERT INTO attendance (record_key, date, student_id, class_level, status, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (record_key) DO UPDATE SET status = EXCLUDED.status, updated_at = now()
     RETURNING record_key AS "recordKey", date, student_id AS "studentId", status`,
    [recordKey, date, studentId, student.rows[0].class, status]
  );

  res.json(rows[0]);
}));

// PUT /api/attendance — bulk-save a whole day's register for a class.
// Body: { date, classLevel, records: { "<date>_<studentId>": "<status>", ... } }
// (records mirrors the frontend's in-memory attendanceStorage object —
// only keys for the given date are applied, so it's safe to pass the
// entire client-side store without filtering it first.)
router.put('/', authenticate, requireRole('Administrator', 'Teacher', 'Headteacher'), asyncHandler(async (req, res) => {
  const { date, classLevel, records } = req.body || {};
  if (!date || !records || typeof records !== 'object') {
    return res.status(400).json({ message: 'date and records are required.' });
  }

  const prefix = `${date}_`;
  const entries = Object.entries(records).filter(([key]) => key.startsWith(prefix));

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const [key, status] of entries) {
      const studentId = key.slice(prefix.length);
      const student = await client.query('SELECT class FROM students WHERE id = $1', [studentId]);
      if (!student.rows.length) continue; // skip unknown IDs rather than failing the whole batch
      if (classLevel && student.rows[0].class !== classLevel) continue;

      await client.query(
        `INSERT INTO attendance (record_key, date, student_id, class_level, status, updated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (record_key) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
        [key, date, studentId, student.rows[0].class, status]
      );
      saved += 1;
    }
    await client.query('COMMIT');
    res.json({ ok: true, saved });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
