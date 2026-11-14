const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const {
  MARK_FIELDS, FIELD_LIMITS, STATUS,
  withTransaction, resolveTermYear, normaliseMark, pickMarks, insertAudit
} = require('../lib/scoreAudit');

const router = express.Router();

// resolveTermYear lives in lib/scoreAudit.js now so the approval/audit
// routes share it: an explicit term/year always wins, otherwise the
// school's current term_settings row.
// GET /api/scores?class=S.4&subject=MATHEMATICS&term=Term 1&year=2026
// - Admin/Teacher: filter by class and/or subject (both optional); term/year
//   resolve to the current term if omitted (see resolveTermYear above).
// - Student: always forced to their own studentId, ignoring class/subject.
//   term/year still apply so a student's report card can ask for one term
//   at a time; omit both to get every term/year on file (e.g. for a
//   transcript view), same convention as GET /api/remarks.
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { class: classLevel, subject, term: rawTerm, year: rawYear } = req.query;

  if (req.user.role === 'Student') {
    // Students only ever see marks the DOS has verified.
    const conditions = ['student_id = $1', "status = 'verified'"];
    const values = [req.user.studentId];
    let i = 2;
    if (rawTerm) { conditions.push(`term = $${i++}`); values.push(rawTerm); }
    if (rawYear) { conditions.push(`year = $${i++}`); values.push(Number(rawYear)); }

    const { rows } = await db.query(
      `SELECT record_key AS "recordKey", subject, student_id AS "studentId", class_level AS "classLevel",
              term, year, ao1, ao2, eot, p1, p2, remarks, touched, updated_at AS "updatedAt",
              status, review_note AS "reviewNote", last_edited_by AS "lastEditedBy", verified_by AS "verifiedBy", verified_at AS "verifiedAt"
       FROM scores WHERE ${conditions.join(' AND ')} ORDER BY year, term, subject`,
      values
    );
    return res.json(rows);
  }

  const { term, year } = await resolveTermYear(req.query);

  const conditions = ['term = $1', 'year = $2'];
  const values = [term, year];
  let i = 3;
  if (classLevel) { conditions.push(`class_level = $${i++}`); values.push(classLevel); }
  if (subject) { conditions.push(`subject = $${i++}`); values.push(subject); }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const { rows } = await db.query(
    `SELECT record_key AS "recordKey", subject, student_id AS "studentId", class_level AS "classLevel",
            term, year, ao1, ao2, eot, p1, p2, remarks, touched, updated_at AS "updatedAt",
              status, review_note AS "reviewNote", last_edited_by AS "lastEditedBy", verified_by AS "verifiedBy", verified_at AS "verifiedAt"
     FROM scores ${where} ORDER BY student_id`,
    values
  );
  res.json(rows);
}));

// --- Term-by-term trend helpers -------------------------------------------
// These mirror script.js's exact same Final/Average-mark formulas
// (calculateAOAverage -> faScore -> +EOT for O-Level classes; average of
// attempted papers for A-Level classes) so GET /trend below can never
// silently disagree with the report card / performance summary a student
// sees elsewhere in the portal. A subject only counts once it has a real
// mark — an untouched or cleared field yields null, not a misleading 0.
const A_LEVEL_TREND_CLASSES = new Set(['S.5', 'S.6']);

function computeOLevelSubjectScore(row) {
  const ao1 = row.ao1 === null || row.ao1 === undefined ? 0 : Number(row.ao1);
  const ao2 = row.ao2 === null || row.ao2 === undefined ? 0 : Number(row.ao2);
  let avScore;
  if (ao1 > 0 && ao2 > 0) avScore = (ao1 + ao2) / 2;
  else if (ao1 > 0) avScore = ao1;
  else if (ao2 > 0) avScore = ao2;
  else avScore = 0;
  const faScore = (avScore / 3.0) * 20;
  if (row.eot === null || row.eot === undefined) return null; // no valid Final mark yet
  return Math.round(faScore + Number(row.eot));
}

function computeALevelSubjectScore(row) {
  const attempted = [row.p1, row.p2]
    .map((p) => (p === null || p === undefined ? null : Number(p)))
    .filter((p) => p !== null && p > 0);
  if (!attempted.length) return null; // no paper attempted yet
  return Math.round(attempted.reduce((sum, p) => sum + p, 0) / attempted.length);
}

// Terms are labelled "Term 1" / "Term 2" / "Term 3" — sort by the number
// embedded in the label so terms order correctly within a year.
function termSortKey(term) {
  const match = String(term).match(/\d+/);
  return match ? Number(match[0]) : 0;
}

// GET /api/scores/trend — Student only (self-service; scoped to
// req.user.studentId exactly like every other Student-role scores read
// above, so a student can never request another learner's trend).
// Returns one point per term/year that has at least one touched scores
// row on file, in chronological order: { term, year, label, average,
// subjectsCounted }. A term with rows but no subject that has a real
// mark yet still appears, with average: null, so the frontend can render
// a gap in the trend line instead of a misleading 0 — it is never simply
// omitted, which would make an in-progress term look identical to one
// with no data at all.
router.get('/trend', authenticate, requireRole('Student'), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT class_level AS "classLevel", term, year, ao1, ao2, eot, p1, p2
     FROM scores WHERE student_id = $1 AND touched = true AND status = 'verified'`,
    [req.user.studentId]
  );

  const groups = new Map(); // "term|year" -> { term, year, scores: [] }
  for (const row of rows) {
    const key = `${row.term}|${row.year}`;
    if (!groups.has(key)) groups.set(key, { term: row.term, year: row.year, scores: [] });
    const isALevel = A_LEVEL_TREND_CLASSES.has(row.classLevel);
    const score = isALevel ? computeALevelSubjectScore(row) : computeOLevelSubjectScore(row);
    if (score !== null) groups.get(key).scores.push(score);
  }

  const trend = Array.from(groups.values())
    .sort((a, b) => a.year - b.year || termSortKey(a.term) - termSortKey(b.term))
    .map((g) => ({
      term: g.term,
      year: g.year,
      label: `${g.term} ${g.year}`,
      average: g.scores.length
        ? Math.round((g.scores.reduce((sum, v) => sum + v, 0) / g.scores.length) * 10) / 10
        : null,
      subjectsCounted: g.scores.length
    }));

  res.json(trend);
}));

// POST /api/scores — Admin or Teacher only.
// Body: { subject, studentId, classLevel?, term?, year?, ao1?, ao2?, eot?, p1?, p2?, remarks?, touched? }
// term/year resolve to the current term_settings row if omitted, same as
// GET above — but the frontend always sends them explicitly, so a save made
// while viewing Term 1 can never land on whatever term the server thinks is
// active. Upserts by (student_id, subject, term, year).
//
// MARKS AUDIT TRAIL + DOS APPROVAL (this is what stops "cooked" marks):
//  - Every change to an actual mark value (ao1/ao2/eot/p1/p2) writes a row
//    to scores_audit — who, when, from which IP, old value -> new value —
//    in the SAME transaction as the change itself.
//  - A Teacher can only edit rows that are 'draft' or 'rejected'. Once a
//    subject is submitted to the DOS ('submitted') or approved ('verified')
//    it is locked for teachers; only the DOS (Administrator) can change it,
//    or send it back with a reason so the teacher can correct it.
//  - A Teacher's edit always leaves the row as 'draft', so a mark can never
//    stay "verified" after someone changed it.
//  - Remark/initial-only saves (no mark value changed) are not audited and
//    don't affect status.
router.post('/', authenticate, requireRole('Administrator', 'Teacher'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { subject, studentId, classLevel, remarks, touched } = body;
  if (!subject || !studentId) {
    return res.status(400).json({ message: 'subject and studentId are required.' });
  }

  // A mark field sent as `null`/'' means "cleared" and must be persisted as
  // null; a field absent from the body keeps its stored value.
  const has = (name) => Object.prototype.hasOwnProperty.call(body, name);
  const incoming = {};
  for (const f of MARK_FIELDS) {
    if (!has(f)) continue;
    const n = normaliseMark(body[f]);
    if (n === undefined) {
      return res.status(400).json({ message: `${f.toUpperCase()} must be a number.` });
    }
    const [min, max] = FIELD_LIMITS[f];
    if (n !== null && (n < min || n > max)) {
      return res.status(400).json({ message: `${f.toUpperCase()} must be between ${min} and ${max}.` });
    }
    incoming[f] = n;
  }

  const student = await db.query('SELECT class FROM students WHERE id = $1', [studentId]);
  if (!student.rows.length) {
    return res.status(404).json({ message: `Student ${studentId} not found.` });
  }

  const { term, year } = await resolveTermYear(body);
  const recordKey = `${subject}_${studentId}_${term}_${year}`;
  const resolvedClass = classLevel || student.rows[0].class;
  const isTeacher = req.user.role === 'Teacher';

  const outcome = await withTransaction(async (client) => {
    const existingRes = await client.query(
      `SELECT * FROM scores WHERE student_id = $1 AND subject = $2 AND term = $3 AND year = $4 FOR UPDATE`,
      [studentId, subject, term, year]
    );
    const existing = existingRes.rows[0] || null;

    if (existing && isTeacher && (existing.status === STATUS.SUBMITTED || existing.status === STATUS.VERIFIED)) {
      return {
        status: 409,
        body: {
          message: existing.status === STATUS.VERIFIED
            ? 'These marks have been verified by the DOS and are locked. Ask the DOS to send them back if they need correcting.'
            : 'These marks have been submitted to the DOS and are locked while awaiting approval.',
          code: 'SCORE_LOCKED',
          scoreStatus: existing.status
        }
      };
    }

    // Final mark values = incoming where sent, otherwise what's stored.
    const before = pickMarks(existing);
    const after = {};
    for (const f of MARK_FIELDS) after[f] = has(f) ? incoming[f] : before[f];

    const changedFields = MARK_FIELDS.filter((f) => before[f] !== after[f]);
    const marksChanged = changedFields.length > 0;

    // Status: new rows start as draft. A teacher changing a mark always
    // leaves the row 'draft' (never silently stays verified/rejected). An
    // Administrator's edit keeps whatever status the row had — it is still
    // fully audited below.
    let newStatus = existing ? existing.status : STATUS.DRAFT;
    if (existing && marksChanged && isTeacher) newStatus = STATUS.DRAFT;

    const lastEditedBy = marksChanged ? req.user.username : (existing ? existing.last_edited_by : null);

    const { rows } = await client.query(
      `INSERT INTO scores (record_key, subject, student_id, class_level, term, year, ao1, ao2, eot, p1, p2, remarks, touched, status, last_edited_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       ON CONFLICT (student_id, subject, term, year) DO UPDATE SET
         record_key = EXCLUDED.record_key,
         class_level = EXCLUDED.class_level,
         ao1 = EXCLUDED.ao1, ao2 = EXCLUDED.ao2, eot = EXCLUDED.eot, p1 = EXCLUDED.p1, p2 = EXCLUDED.p2,
         remarks = COALESCE(EXCLUDED.remarks, scores.remarks),
         touched = EXCLUDED.touched OR scores.touched,
         status = EXCLUDED.status,
         last_edited_by = EXCLUDED.last_edited_by,
         updated_at = now()
       RETURNING record_key AS "recordKey", subject, student_id AS "studentId", class_level AS "classLevel",
                 term, year, ao1, ao2, eot, p1, p2, remarks, touched, updated_at AS "updatedAt",
                 status, review_note AS "reviewNote", last_edited_by AS "lastEditedBy", verified_by AS "verifiedBy", verified_at AS "verifiedAt"`,
      [recordKey, subject, studentId, resolvedClass, term, year,
       after.ao1, after.ao2, after.eot, after.p1, after.p2, remarks ?? null, !!touched,
       newStatus, lastEditedBy]
    );

    if (marksChanged) {
      const oldValues = {}, newValues = {};
      changedFields.forEach((f) => { oldValues[f] = before[f]; newValues[f] = after[f]; });
      await insertAudit(client, req, {
        recordKey, studentId, subject, classLevel: resolvedClass, term, year,
        action: existing ? 'UPDATE' : 'CREATE',
        oldValues: existing ? oldValues : null,
        newValues,
        oldStatus: existing ? existing.status : null,
        newStatus
      });
    }

    return { status: 200, body: rows[0] };
  });

  res.status(outcome.status).json(outcome.body);
}));

// POST /api/scores/bulk-initials — Admin or Teacher only.
// Body: { classLevel, subject, initials, term?, year? }
// Stamps the same "TR's Initial" value onto every EXISTING scores row for a
// given class+subject+term+year in a single statement. Scoped to term/year
// (resolving to the current term if omitted) so bulk-stamping this term's
// class never touches a past term's already-finalised report-card rows.
//
// Deliberately an UPDATE, never an INSERT: this must only touch students who
// already have a scores row for this subject/term/year. Same reasoning as
// before this migration — a subject with no real data must never silently
// appear as "recorded".
router.post('/bulk-initials', authenticate, requireRole('Administrator', 'Teacher'), asyncHandler(async (req, res) => {
  const { classLevel, subject, initials } = req.body || {};
  if (!classLevel || !subject || !initials) {
    return res.status(400).json({ message: 'classLevel, subject and initials are required.' });
  }

  const { term, year } = await resolveTermYear(req.body || {});

  const normalizedInitials = String(initials).trim().toUpperCase().slice(0, 4);
  if (!normalizedInitials) {
    return res.status(400).json({ message: 'initials cannot be blank.' });
  }

  const { rows } = await db.query(
    `UPDATE scores SET remarks = $1, updated_at = now()
     WHERE class_level = $2 AND subject = $3 AND term = $4 AND year = $5
     RETURNING record_key AS "recordKey", student_id AS "studentId"`,
    [normalizedInitials, classLevel, subject, term, year]
  );

  res.json({ initials: normalizedInitials, term, year, updated: rows });
}));

// DELETE /api/scores/:recordKey — Admin or Teacher only.
// Fully removes one subject<->student<->term<->year association. recordKey
// carries all four segments ("SUBJECT_studentId_Term X_YYYY"), so this can
// never delete the same subject's marks from a different term.
// A Teacher can't delete marks that are submitted/verified (locked); every
// delete — including the marks that were removed — is written to the audit
// trail, so deleting marks can no longer be done without a trace.
router.delete('/:recordKey', authenticate, requireRole('Administrator', 'Teacher'), asyncHandler(async (req, res) => {
  const { recordKey } = req.params;
  const isTeacher = req.user.role === 'Teacher';

  const outcome = await withTransaction(async (client) => {
    const existingRes = await client.query('SELECT * FROM scores WHERE record_key = $1 FOR UPDATE', [recordKey]);
    const existing = existingRes.rows[0];
    if (!existing) {
      return { status: 404, body: { message: `No score record found for ${recordKey}.` } };
    }
    if (isTeacher && (existing.status === STATUS.SUBMITTED || existing.status === STATUS.VERIFIED)) {
      return {
        status: 409,
        body: { message: 'These marks are submitted/verified and locked. Only the DOS can remove them.', code: 'SCORE_LOCKED', scoreStatus: existing.status }
      };
    }

    await client.query('DELETE FROM scores WHERE id = $1', [existing.id]);
    await insertAudit(client, req, {
      recordKey, studentId: existing.student_id, subject: existing.subject, classLevel: existing.class_level,
      term: existing.term, year: existing.year, action: 'DELETE',
      oldValues: pickMarks(existing), oldStatus: existing.status
    });

    return {
      status: 200,
      body: {
        message: 'Subject unlinked and marks cleared.',
        removed: { recordKey, subject: existing.subject, studentId: existing.student_id, term: existing.term, year: existing.year }
      }
    };
  });

  res.status(outcome.status).json(outcome.body);
}));

module.exports = router;
