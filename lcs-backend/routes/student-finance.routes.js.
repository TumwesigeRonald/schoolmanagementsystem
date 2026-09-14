/**
 * routes/student-finance.routes.js — a single, narrow, read-only endpoint
 * that lets a logged-in Student see their OWN fee balance.
 *
 * This is deliberately its own router rather than a route added to
 * finance.routes.js: every route in that file sits behind
 * `requireFinanceScope` (the separate Finance password), and Students can
 * never obtain that finance-scoped token at all (see the comment at the
 * top of finance.routes.js). A Student-facing balance view has no business
 * needing that staff-only gate anyway — it only ever needs to prove who
 * the caller is (the normal login JWT) and hand back that one caller's
 * own numbers.
 *
 * Security note: the student ID used for every query below comes ONLY
 * from `req.user.studentId` (a claim baked into the JWT at login — see
 * toPublicUser() in auth.routes.js). It is never read from a query
 * param or request body, so there is no way for a student to request
 * (or even guess their way into) another student's balance.
 */
const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

async function resolveTermYear(query) {
  const term = query.term;
  const year = query.year ? Number(query.year) : undefined;
  if (term && year) return { term, year };

  const { rows } = await db.query(`SELECT term, year FROM term_settings WHERE id = 1`);
  const current = rows[0] || { term: 'Term 1', year: new Date().getFullYear() };
  return { term: term || current.term, year: year || current.year };
}

router.get('/my-balance', authenticate, requireRole('Student'), asyncHandler(async (req, res) => {
  const { term, year } = await resolveTermYear(req.query);
  const studentId = req.user.studentId;

  if (!studentId) {
    return res.status(404).json({ message: 'No student record is linked to your account. Ask your Administrator to check it.' });
  }

  const { rows } = await db.query(
    `SELECT s.id, s.name, s.class,
            COALESCE(sfo.amount, fs.amount, 0)::float AS billed,
            (sfo.amount IS NOT NULL) AS "hasCustomFee",
            sfo.reason AS "customFeeReason",
            COALESCE(p.paid, 0)::float AS paid
     FROM students s
     LEFT JOIN fee_structures fs ON fs.class = s.class AND fs.term = $2 AND fs.year = $3
     LEFT JOIN student_fee_overrides sfo ON sfo.student_id = s.id AND sfo.term = $2 AND sfo.year = $3
     LEFT JOIN (
       SELECT student_id, SUM(amount) AS paid FROM fee_payments
       WHERE term = $2 AND year = $3 GROUP BY student_id
     ) p ON p.student_id = s.id
     WHERE s.id = $1`,
    [studentId, term, year]
  );

  const student = rows[0];
  if (!student) {
    return res.status(404).json({ message: 'Student record not found.' });
  }

  const { rows: history } = await db.query(
    `SELECT amount::float AS amount, method, created_at AS "createdAt"
     FROM fee_payments WHERE student_id = $1 AND term = $2 AND year = $3
     ORDER BY created_at DESC`,
    [studentId, term, year]
  );

  res.json({
    term, year,
    billed: student.billed,
    paid: student.paid,
    balance: Math.max(0, student.billed - student.paid),
    hasCustomFee: student.hasCustomFee,
    customFeeReason: student.customFeeReason,
    history
  });
}));

module.exports = router;
