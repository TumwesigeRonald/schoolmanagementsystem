/**
 * routes/verify.routes.js — report-card authenticity (QR code) + trend data.
 *
 *  POST /api/verify/report-extras   (Admin / Teacher / Student, JWT)
 *      For a batch of learners returns, in one round trip:
 *        - codes:    a signed verification code per learner (goes in the QR)
 *        - previous: each subject's most recent EARLIER verified score, used
 *                    for the ▲ ▼ = trend arrows printed on the report card.
 *      A Student can only ever get their own entry.
 *
 *  GET  /api/verify?c=<code>        (PUBLIC — no login)
 *      What a phone opens after scanning the QR. Checks the signature and
 *      returns that learner's verified marks for that term, read live from
 *      the database, so a doctored printout can be compared against the truth.
 *      Deliberately minimal: name, class, marks, grades. No fees, photo,
 *      contacts or attendance.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { makeCode, parseCode, termNumber } = require('../lib/reportCode');
const { A_LEVEL_CLASSES, scoreForRow, gradeFor } = require('../lib/scoreMath');

const router = express.Router();

const MAX_STUDENTS_PER_CALL = 500;

// The public endpoint needs no login, so give it its own tighter ceiling on
// top of the global /api limiter (this is the only unauthenticated route that
// reads marks).
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { valid: false, message: 'Too many checks. Please wait a minute and try again.' }
});

// ---------------------------------------------------------------- extras --
router.post(
  '/report-extras',
  authenticate,
  requireRole('Administrator', 'Teacher', 'Student'),
  asyncHandler(async (req, res) => {
    const { term, year, levelType } = req.body || {};
    const yr = Number(year);
    const termNum = termNumber(term);
    if (termNum === null || !Number.isInteger(yr)) {
      return res.status(400).json({ message: 'term and year are required.' });
    }
    const wantALevel = levelType === 'A';

    let ids = Array.isArray(req.body.studentIds) ? req.body.studentIds.map(String) : [];
    if (req.user.role === 'Student') ids = ids.filter((id) => id === String(req.user.studentId));
    ids = [...new Set(ids)].slice(0, MAX_STUDENTS_PER_CALL);
    if (!ids.length) return res.json({ codes: {}, previous: {} });

    const codes = {};
    ids.forEach((id) => {
      const code = makeCode(id, term, yr);
      if (code) codes[id] = code;
    });

    // Every verified, touched score from an EARLIER term (same filters the
    // report card itself uses), newest first.
    const { rows } = await db.query(
      `SELECT student_id, subject, class_level, term, year, ao1, ao2, eot, p1, p2
         FROM scores
        WHERE student_id = ANY($1)
          AND status = 'verified' AND touched = true
          AND (year < $2 OR (year = $2
               AND COALESCE(NULLIF(regexp_replace(term, '\\D', '', 'g'), ''), '0')::int < $3))
        ORDER BY year DESC,
                 COALESCE(NULLIF(regexp_replace(term, '\\D', '', 'g'), ''), '0')::int DESC`,
      [ids, yr, termNum]
    );

    // First hit per (student, subject) is the most recent earlier term that
    // has a real mark. Only compare like with like: an O-Level mark is never
    // compared with an A-Level one (e.g. a learner promoted from S.4 to S.5).
    const previous = {};
    for (const row of rows) {
      if (A_LEVEL_CLASSES.has(row.class_level) !== wantALevel) continue;
      const score = scoreForRow(row);
      if (score === null) continue;
      const perStudent = previous[row.student_id] || (previous[row.student_id] = {});
      if (perStudent[row.subject]) continue;
      perStudent[row.subject] = { score, term: row.term, year: row.year };
    }

    res.json({ codes, previous });
  })
);

// ---------------------------------------------------------------- public --
router.get(
  '/',
  verifyLimiter,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const parsed = parseCode(req.query.c);
    if (!parsed) {
      return res.status(404).json({ valid: false, message: 'This code is not genuine.' });
    }

    const student = await db.query('SELECT id, name, class FROM students WHERE id = $1', [parsed.studentId]);
    if (!student.rows.length) {
      return res.status(404).json({ valid: false, message: 'This code is not genuine.' });
    }

    const { rows } = await db.query(
      `SELECT subject, class_level, ao1, ao2, eot, p1, p2
         FROM scores
        WHERE student_id = $1 AND term = $2 AND year = $3
          AND status = 'verified' AND touched = true
        ORDER BY subject`,
      [parsed.studentId, parsed.term, parsed.year]
    );

    const classLevel = (rows[0] && rows[0].class_level) || student.rows[0].class;
    const isALevel = A_LEVEL_CLASSES.has(classLevel);
    const subjects = rows
      .map((r) => ({ subject: r.subject, score: scoreForRow(r) }))
      .filter((s) => s.score !== null)
      .map((s) => ({ ...s, grade: gradeFor(s.score, isALevel) }));

    const average = subjects.length
      ? Math.round((subjects.reduce((sum, s) => sum + s.score, 0) / subjects.length) * 10) / 10
      : null;

    res.json({
      valid: true,
      student: { id: student.rows[0].id, name: student.rows[0].name, class: classLevel },
      term: parsed.term,
      year: parsed.year,
      levelType: isALevel ? 'A' : 'O',
      subjects,
      average,
      checkedAt: new Date().toISOString()
    });
  })
);

module.exports = router;
