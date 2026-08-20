/**
 * routes/remarks.routes.js — Report Card Remarks
 * (Class Teacher's Comment / Headteacher's Comment)
 *
 * One row per (student, term, year) in report_card_remarks — see
 * migrations/schema.sql for why this is its own table rather than
 * columns on `scores`.
 */
const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// GET /api/remarks?studentId=&term=&year=
// - Admin/Teacher: studentId is required (term/year optional — omit both
//   to get every term/year on file for that student, e.g. for the
//   frontend's rescue-migration merge).
// - Student: always forced to their own studentId, same pattern as
//   GET /api/scores, so a report card view can never leak another
//   student's comments.
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { term, year } = req.query;
  const studentId = req.user.role === 'Student' ? req.user.studentId : req.query.studentId;

  if (!studentId) {
    return res.status(400).json({ message: 'studentId is required.' });
  }

  const conditions = ['student_id = $1'];
  const values = [studentId];
  let i = 2;
  if (term) { conditions.push(`term = $${i++}`); values.push(term); }
  if (year) { conditions.push(`year = $${i++}`); values.push(Number(year)); }

  const { rows } = await db.query(
    `SELECT record_key AS "recordKey", student_id AS "studentId", term, year,
            class_teacher_comment AS "classTeacherComment",
            headteacher_comment AS "headteacherComment",
            updated_at AS "updatedAt"
     FROM report_card_remarks WHERE ${conditions.join(' AND ')}`,
    values
  );
  res.json(rows);
}));

// POST /api/remarks — Admin or Teacher only (mirrors the canViewAllReports
// guard the frontend already applies client-side; enforced here server-side
// too, since a client-side check alone can be bypassed).
// Body: { studentId, term, year, classTeacherComment?, headteacherComment? }
// Upserts by record_key = `${studentId}_${term}_${year}` — same convention
// scores.record_key / attendance.record_key already use, and matches the
// frontend's existing localStorage key exactly, so the rescue-migration
// script (see script.js) can compute the same key on the client.
//
// A field can legitimately be sent as an empty string to mean "this comment
// was cleared" — that must persist as cleared, not be silently ignored.
// Only a field genuinely absent from the request body falls back to
// whatever is already stored, same reasoning as POST /api/scores's
// hasAo1/hasAo2/... handling — so saving just one comment never blanks
// out the other one already on file for this student/term/year.
router.post('/', authenticate, requireRole('Administrator', 'Teacher'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { studentId, term, year } = body;
  if (!studentId || !term || !year) {
    return res.status(400).json({ message: 'studentId, term and year are required.' });
  }

  const student = await db.query('SELECT id FROM students WHERE id = $1', [studentId]);
  if (!student.rows.length) {
    return res.status(404).json({ message: `Student ${studentId} not found.` });
  }

  const has = (name) => Object.prototype.hasOwnProperty.call(body, name);
  const hasClassTeacherComment = has('classTeacherComment');
  const hasHeadteacherComment = has('headteacherComment');
  const classTeacherComment = hasClassTeacherComment ? body.classTeacherComment : null;
  const headteacherComment = hasHeadteacherComment ? body.headteacherComment : null;

  const recordKey = `${studentId}_${term}_${year}`;

  const { rows } = await db.query(
    `INSERT INTO report_card_remarks
       (record_key, student_id, term, year, class_teacher_comment, headteacher_comment, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (record_key) DO UPDATE SET
       class_teacher_comment = CASE WHEN $7 THEN EXCLUDED.class_teacher_comment ELSE report_card_remarks.class_teacher_comment END,
       headteacher_comment   = CASE WHEN $8 THEN EXCLUDED.headteacher_comment ELSE report_card_remarks.headteacher_comment END,
       updated_at = now()
     RETURNING record_key AS "recordKey", student_id AS "studentId", term, year,
               class_teacher_comment AS "classTeacherComment",
               headteacher_comment AS "headteacherComment",
               updated_at AS "updatedAt"`,
    [recordKey, studentId, term, Number(year), classTeacherComment, headteacherComment,
     hasClassTeacherComment, hasHeadteacherComment]
  );

  res.json(rows[0]);
}));

module.exports = router;
