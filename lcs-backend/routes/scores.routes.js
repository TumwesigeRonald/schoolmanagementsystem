const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// Every scores read/write is scoped to a term+year. If the caller doesn't
// pass one explicitly (older frontend code, or a screen that just wants
// "whatever's current"), fall back to term_settings' current row — but an
// explicit term/year in the request always wins, since that's what lets a
// user view a *past* term while the school is actively in a later one.
async function resolveTermYear(query) {
  const term = query.term;
  const year = query.year ? Number(query.year) : undefined;
  if (term && year) return { term, year };

  const { rows } = await db.query(
    `SELECT term, year FROM term_settings WHERE id = 1`
  );
  const current = rows[0] || { term: 'Term 1', year: new Date().getFullYear() };
  return { term: term || current.term, year: year || current.year };
}

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
    const conditions = ['student_id = $1'];
    const values = [req.user.studentId];
    let i = 2;
    if (rawTerm) { conditions.push(`term = $${i++}`); values.push(rawTerm); }
    if (rawYear) { conditions.push(`year = $${i++}`); values.push(Number(rawYear)); }

    const { rows } = await db.query(
      `SELECT record_key AS "recordKey", subject, student_id AS "studentId", class_level AS "classLevel",
              term, year, ao1, ao2, eot, p1, p2, remarks, touched, updated_at AS "updatedAt"
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
            term, year, ao1, ao2, eot, p1, p2, remarks, touched, updated_at AS "updatedAt"
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
     FROM scores WHERE student_id = $1 AND touched = true`,
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
// GET above — but the frontend should always send them explicitly once the
// term-switcher is wired up, so a save made while viewing Term 1 can never
// accidentally land on whatever term the server currently thinks is active.
// Upserts by (student_id, subject, term, year) — this is the change that
// stops a new term's marks from overwriting an old term's marks: the
// conflict target now includes term/year, so a different term is always a
// different row, never an UPDATE of the old one.
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

  const { term, year } = await resolveTermYear(body);
  const recordKey = `${subject}_${studentId}_${term}_${year}`;
  const resolvedClass = classLevel || student.rows[0].class;

  // A mark field can legitimately be sent as `null` to mean "this mark was
  // cleared/deleted" — that must actually be persisted as null. Track
  // presence per field (script.js always sends every relevant field for a
  // subject's type, so "present" reliably means "the client has an opinion
  // about this field"), and only fall back to the existing stored value
  // when a field is truly absent from the request body.
  const has = (name) => Object.prototype.hasOwnProperty.call(body, name);
  const hasAo1 = has('ao1'), hasAo2 = has('ao2'), hasEot = has('eot'), hasP1 = has('p1'), hasP2 = has('p2');
  const ao1 = has('ao1') ? body.ao1 : null;
  const ao2 = has('ao2') ? body.ao2 : null;
  const eot = has('eot') ? body.eot : null;
  const p1 = has('p1') ? body.p1 : null;
  const p2 = has('p2') ? body.p2 : null;

  const { rows } = await db.query(
    `INSERT INTO scores (record_key, subject, student_id, class_level, term, year, ao1, ao2, eot, p1, p2, remarks, touched, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (student_id, subject, term, year) DO UPDATE SET
       record_key = EXCLUDED.record_key,
       class_level = EXCLUDED.class_level,
       ao1 = CASE WHEN $14 THEN EXCLUDED.ao1 ELSE scores.ao1 END,
       ao2 = CASE WHEN $15 THEN EXCLUDED.ao2 ELSE scores.ao2 END,
       eot = CASE WHEN $16 THEN EXCLUDED.eot ELSE scores.eot END,
       p1 = CASE WHEN $17 THEN EXCLUDED.p1 ELSE scores.p1 END,
       p2 = CASE WHEN $18 THEN EXCLUDED.p2 ELSE scores.p2 END,
       remarks = COALESCE(EXCLUDED.remarks, scores.remarks),
       touched = EXCLUDED.touched OR scores.touched,
       updated_at = now()
     RETURNING record_key AS "recordKey", subject, student_id AS "studentId", class_level AS "classLevel",
               term, year, ao1, ao2, eot, p1, p2, remarks, touched, updated_at AS "updatedAt"`,
    [recordKey, subject, studentId, resolvedClass, term, year, ao1, ao2, eot, p1, p2, remarks ?? null, !!touched,
     hasAo1, hasAo2, hasEot, hasP1, hasP2]
  );

  res.json(rows[0]);
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
// now carries all four segments ("SUBJECT_studentId_Term X_YYYY"), so this
// can never accidentally delete the same subject's marks from a different
// term — only the exact term/year the caller is looking at.
router.delete('/:recordKey', authenticate, requireRole('Administrator', 'Teacher'), asyncHandler(async (req, res) => {
  const { recordKey } = req.params;

  const { rows } = await db.query(
    `DELETE FROM scores WHERE record_key = $1
     RETURNING record_key AS "recordKey", subject, student_id AS "studentId", term, year`,
    [recordKey]
  );

  if (!rows.length) {
    return res.status(404).json({ message: `No score record found for ${recordKey}.` });
  }

  res.json({ message: 'Subject unlinked and marks cleared.', removed: rows[0] });
}));

module.exports = router;
