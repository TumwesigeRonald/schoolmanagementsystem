const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// GET /api/scores?class=S.4&subject=MATHEMATICS
// - Admin/Teacher: filter by class and/or subject (both optional).
// - Student: always forced to their own studentId, ignoring class/subject,
//   so a report card can pull every subject at once.
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { class: classLevel, subject } = req.query;

  if (req.user.role === 'Student') {
    const { rows } = await db.query(
      `SELECT record_key AS "recordKey", subject, student_id AS "studentId", class_level AS "classLevel",
              ao1, ao2, eot, p1, p2, remarks, touched, updated_at AS "updatedAt"
       FROM scores WHERE student_id = $1 ORDER BY subject`,
      [req.user.studentId]
    );
    return res.json(rows);
  }

  const conditions = [];
  const values = [];
  let i = 1;
  if (classLevel) { conditions.push(`class_level = $${i++}`); values.push(classLevel); }
  if (subject) { conditions.push(`subject = $${i++}`); values.push(subject); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT record_key AS "recordKey", subject, student_id AS "studentId", class_level AS "classLevel",
            ao1, ao2, eot, p1, p2, remarks, touched, updated_at AS "updatedAt"
     FROM scores ${where} ORDER BY student_id`,
    values
  );
  res.json(rows);
}));

// POST /api/scores — Admin or Teacher only.
// Body: { subject, studentId, classLevel?, ao1?, ao2?, eot?, p1?, p2?, remarks?, touched? }
// Upserts by record_key = `${subject}_${studentId}` (same convention script.js uses).
router.post('/', authenticate, requireRole('Administrator', 'Teacher'), asyncHandler(async (req, res) => {
  const { subject, studentId, classLevel, ao1, ao2, eot, p1, p2, remarks, touched } = req.body || {};
  if (!subject || !studentId) {
    return res.status(400).json({ message: 'subject and studentId are required.' });
  }

  const student = await db.query('SELECT class FROM students WHERE id = $1', [studentId]);
  if (!student.rows.length) {
    return res.status(404).json({ message: `Student ${studentId} not found.` });
  }

  const recordKey = `${subject}_${studentId}`;
  const resolvedClass = classLevel || student.rows[0].class;

  const { rows } = await db.query(
    `INSERT INTO scores (record_key, subject, student_id, class_level, ao1, ao2, eot, p1, p2, remarks, touched, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (record_key) DO UPDATE SET
       class_level = EXCLUDED.class_level,
       ao1 = COALESCE(EXCLUDED.ao1, scores.ao1),
       ao2 = COALESCE(EXCLUDED.ao2, scores.ao2),
       eot = COALESCE(EXCLUDED.eot, scores.eot),
       p1 = COALESCE(EXCLUDED.p1, scores.p1),
       p2 = COALESCE(EXCLUDED.p2, scores.p2),
       remarks = COALESCE(EXCLUDED.remarks, scores.remarks),
       touched = EXCLUDED.touched OR scores.touched,
       updated_at = now()
     RETURNING record_key AS "recordKey", subject, student_id AS "studentId", class_level AS "classLevel",
               ao1, ao2, eot, p1, p2, remarks, touched, updated_at AS "updatedAt"`,
    [recordKey, subject, studentId, resolvedClass, ao1 ?? null, ao2 ?? null, eot ?? null, p1 ?? null, p2 ?? null, remarks ?? null, !!touched]
  );

  res.json(rows[0]);
}));

module.exports = router;
