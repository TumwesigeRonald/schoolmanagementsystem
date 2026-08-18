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
  const body = req.body || {};
  const { subject, studentId, classLevel, remarks, touched } = body;
  if (!subject || !studentId) {
    return res.status(400).json({ message: 'subject and studentId are required.' });
  }

  const student = await db.query('SELECT class FROM students WHERE id = $1', [studentId]);
  if (!student.rows.length) {
    return res.status(404).json({ message: `Student ${studentId} not found.` });
  }

  const recordKey = `${subject}_${studentId}`;
  const resolvedClass = classLevel || student.rows[0].class;

  // A mark field can legitimately be sent as `null` to mean "this mark was
  // cleared/deleted" — that must actually be persisted as null. The old
  // COALESCE(EXCLUDED.x, scores.x) treated an explicit null exactly like a
  // field that was never sent at all, so a cleared mark silently reverted
  // to whatever number was previously stored. Track presence per field
  // (script.js always sends every relevant field for a subject's type, so
  // "present" reliably means "the client has an opinion about this field"),
  // and only fall back to the existing stored value when a field is truly
  // absent from the request body.
  const has = (name) => Object.prototype.hasOwnProperty.call(body, name);
  const hasAo1 = has('ao1'), hasAo2 = has('ao2'), hasEot = has('eot'), hasP1 = has('p1'), hasP2 = has('p2');
  const ao1 = has('ao1') ? body.ao1 : null;
  const ao2 = has('ao2') ? body.ao2 : null;
  const eot = has('eot') ? body.eot : null;
  const p1 = has('p1') ? body.p1 : null;
  const p2 = has('p2') ? body.p2 : null;

  const { rows } = await db.query(
    `INSERT INTO scores (record_key, subject, student_id, class_level, ao1, ao2, eot, p1, p2, remarks, touched, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (record_key) DO UPDATE SET
       class_level = EXCLUDED.class_level,
       ao1 = CASE WHEN $12 THEN EXCLUDED.ao1 ELSE scores.ao1 END,
       ao2 = CASE WHEN $13 THEN EXCLUDED.ao2 ELSE scores.ao2 END,
       eot = CASE WHEN $14 THEN EXCLUDED.eot ELSE scores.eot END,
       p1 = CASE WHEN $15 THEN EXCLUDED.p1 ELSE scores.p1 END,
       p2 = CASE WHEN $16 THEN EXCLUDED.p2 ELSE scores.p2 END,
       remarks = COALESCE(EXCLUDED.remarks, scores.remarks),
       touched = EXCLUDED.touched OR scores.touched,
       updated_at = now()
     RETURNING record_key AS "recordKey", subject, student_id AS "studentId", class_level AS "classLevel",
               ao1, ao2, eot, p1, p2, remarks, touched, updated_at AS "updatedAt"`,
    [recordKey, subject, studentId, resolvedClass, ao1, ao2, eot, p1, p2, remarks ?? null, !!touched,
     hasAo1, hasAo2, hasEot, hasP1, hasP2]
  );

  res.json(rows[0]);
}));

// POST /api/scores/bulk-initials — Admin or Teacher only.
// Body: { classLevel, subject, initials }
// Stamps the same "TR's Initial" value onto every EXISTING scores row for a
// given class+subject in a single statement, so a teacher no longer has to
// retype their initials once per student.
//
// Deliberately an UPDATE, never an INSERT: this must only touch students who
// already have a scores row for this subject (i.e. at least one mark has
// been entered for them at some point). It must never fabricate a phantom
// scores row for a student with no marks at all — same principle the rest
// of this file already follows for ao1/ao2/eot/p1/p2 (a subject with no real
// data must never silently appear as "recorded").
//
// The value is written directly into each row's `remarks` column — the same
// column the single-row POST above and the report-card renderer both already
// use — rather than being resolved from a separate "who currently teaches
// this class/subject" table. That's intentional: report cards are historical
// documents, so the initials on a Term 1 report must keep reflecting whoever
// actually marked it then, even if the subject is reassigned to a different
// teacher later. Freezing the value onto each row at write time (instead of
// looking it up live at render time) guarantees past report cards never
// silently change.
router.post('/bulk-initials', authenticate, requireRole('Administrator', 'Teacher'), asyncHandler(async (req, res) => {
  const { classLevel, subject, initials } = req.body || {};
  if (!classLevel || !subject || !initials) {
    return res.status(400).json({ message: 'classLevel, subject and initials are required.' });
  }

  // Mirror the same normalization the single-row per-student initials input
  // already applies client-side (script.js: maxlength="4", uppercase) —
  // enforced here too since a client-side constraint alone can't be trusted.
  const normalizedInitials = String(initials).trim().toUpperCase().slice(0, 4);
  if (!normalizedInitials) {
    return res.status(400).json({ message: 'initials cannot be blank.' });
  }

  const { rows } = await db.query(
    `UPDATE scores SET remarks = $1, updated_at = now()
     WHERE class_level = $2 AND subject = $3
     RETURNING record_key AS "recordKey", student_id AS "studentId"`,
    [normalizedInitials, classLevel, subject]
  );

  res.json({ initials: normalizedInitials, updated: rows });
}));

// DELETE /api/scores/:recordKey — Admin or Teacher only.
// Fully removes one subject<->student association: deletes the scores row
// outright (not a soft-clear/touched=false toggle), so the subject and its
// marks vanish from that student's summary/report card immediately. Scoped
// to a single record_key ("SUBJECT_studentId"), so this can never touch any
// other student's rows, the global subject lists, or grading logic — those
// live entirely outside the `scores` table.
router.delete('/:recordKey', authenticate, requireRole('Administrator', 'Teacher'), asyncHandler(async (req, res) => {
  const { recordKey } = req.params;

  const { rows } = await db.query(
    `DELETE FROM scores WHERE record_key = $1
     RETURNING record_key AS "recordKey", subject, student_id AS "studentId"`,
    [recordKey]
  );

  if (!rows.length) {
    return res.status(404).json({ message: `No score record found for ${recordKey}.` });
  }

  res.json({ message: 'Subject unlinked and marks cleared.', removed: rows[0] });
}));

module.exports = router;
