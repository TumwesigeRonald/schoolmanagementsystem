/**
 * routes/finance.routes.js — School Finance data: fee structures,
 * student payments/balances, and termly financial summaries.
 *
 * Every route here requires BOTH a valid login (`authenticate`) AND an
 * unlocked Finance session (`requireFinanceScope` — the separate
 * password gate in finance-auth.routes.js). Admin, Bursar and Teacher
 * can all reach these for reading; write routes additionally require
 * `requireRole(...EDIT_ROLES)` so Teachers stay view-only, matching
 * what was agreed for the feature (Admin + Bursar can record/edit,
 * Teacher can view only).
 */
const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requireFinanceScope } = require('../middleware/financeAuth');
const asyncHandler = require('../middleware/asyncHandler');
const { logActivity } = require('../lib/activityLog');

const router = express.Router();
const EDIT_ROLES = ['Administrator', 'Bursar'];

router.use(authenticate, requireFinanceScope);

/* ---------------------------- Fee structure ---------------------------- */

// GET /api/finance/fee-structure?term=Term 1&year=2026
router.get('/fee-structure', asyncHandler(async (req, res) => {
  const { term, year } = req.query;
  if (!term || !year) {
    return res.status(400).json({ message: 'term and year are required.' });
  }
  const { rows } = await db.query(
    `SELECT class, term, year, amount::float AS amount
     FROM fee_structures WHERE term = $1 AND year = $2 ORDER BY class`,
    [term, year]
  );
  res.json(rows);
}));

// PUT /api/finance/fee-structure — set/update the expected fee for one
// class/term/year. Admin + Bursar only.
router.put('/fee-structure', requireRole(...EDIT_ROLES), asyncHandler(async (req, res) => {
  const { class: className, term, year, amount } = req.body || {};
  if (!className || !term || !year || amount == null || amount < 0) {
    return res.status(400).json({ message: 'class, term, year and a non-negative amount are required.' });
  }
  const { rows } = await db.query(
    `INSERT INTO fee_structures (class, term, year, amount, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (class, term, year) DO UPDATE SET
       amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING class, term, year, amount::float AS amount`,
    [className, term, year, amount, req.user.username]
  );
  await logActivity(req.user.username, `Set ${className} fee (${term} ${year}) to ${amount}`, req.ip);
  res.json(rows[0]);
}));

/* ------------------------- Per-student fee override ------------------------- */

// PUT /api/finance/fee-override — set/update ONE student's expected fee for
// a term/year, overriding their class's default (scholarship, discount,
// extra charge, etc). Admin + Bursar only.
router.put('/fee-override', requireRole(...EDIT_ROLES), asyncHandler(async (req, res) => {
  const { studentId, term, year, amount, reason } = req.body || {};
  if (!studentId || !term || !year || amount == null || amount < 0) {
    return res.status(400).json({ message: 'studentId, term, year and a non-negative amount are required.' });
  }
  const { rows: studentRows } = await db.query('SELECT id FROM students WHERE id = $1', [studentId]);
  if (!studentRows.length) return res.status(404).json({ message: 'Student not found.' });

  const { rows } = await db.query(
    `INSERT INTO student_fee_overrides (student_id, term, year, amount, reason, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (student_id, term, year) DO UPDATE SET
       amount = EXCLUDED.amount, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING student_id AS "studentId", term, year, amount::float AS amount, reason`,
    [studentId, term, year, amount, reason || null, req.user.username]
  );
  await logActivity(req.user.username, `Set a custom fee of ${amount} for ${studentId} (${term} ${year})`, req.ip);
  res.json(rows[0]);
}));

// DELETE /api/finance/fee-override?studentId=&term=&year= — clear a
// student's override so they fall back to their class's default fee.
// Admin + Bursar only.
router.delete('/fee-override', requireRole(...EDIT_ROLES), asyncHandler(async (req, res) => {
  const { studentId, term, year } = req.query;
  if (!studentId || !term || !year) {
    return res.status(400).json({ message: 'studentId, term and year are required.' });
  }
  await db.query(
    'DELETE FROM student_fee_overrides WHERE student_id = $1 AND term = $2 AND year = $3',
    [studentId, term, year]
  );
  await logActivity(req.user.username, `Reset ${studentId} to the class default fee (${term} ${year})`, req.ip);
  res.json({ ok: true });
}));

/* ------------------------------- Payments ------------------------------- */

// GET /api/finance/payments?term=&year=&class=          -> list with balances
// GET /api/finance/payments?term=&year=&studentId=       -> one student + history
router.get('/payments', asyncHandler(async (req, res) => {
  const { class: className, term, year, studentId } = req.query;
  if (!term || !year) {
    return res.status(400).json({ message: 'term and year are required.' });
  }

  const params = [term, year];
  let filter = '';
  if (studentId) {
    params.push(studentId);
    filter = ` AND s.id = $${params.length}`;
  } else if (className) {
    params.push(className);
    filter = ` AND s.class = $${params.length}`;
  }

  // billed = the student's own override if one is set for this term/year,
  // otherwise their class's default fee_structures amount, otherwise 0.
  const { rows: students } = await db.query(
    `SELECT s.id, s.name, s.class,
            COALESCE(sfo.amount, fs.amount, 0)::float AS billed,
            (sfo.amount IS NOT NULL) AS "hasCustomFee",
            sfo.reason AS "customFeeReason",
            COALESCE(p.paid, 0)::float AS paid
     FROM students s
     LEFT JOIN fee_structures fs ON fs.class = s.class AND fs.term = $1 AND fs.year = $2
     LEFT JOIN student_fee_overrides sfo ON sfo.student_id = s.id AND sfo.term = $1 AND sfo.year = $2
     LEFT JOIN (
       SELECT student_id, SUM(amount) AS paid FROM fee_payments
       WHERE term = $1 AND year = $2 GROUP BY student_id
     ) p ON p.student_id = s.id
     WHERE 1=1 ${filter}
     ORDER BY s.class, s.name`,
    params
  );
  const withBalance = students.map(s => ({ ...s, balance: Math.max(0, s.billed - s.paid) }));

  if (studentId) {
    if (!withBalance.length) return res.status(404).json({ message: 'Student not found.' });
    const { rows: history } = await db.query(
      `SELECT id, amount::float AS amount, method, reference, note,
              recorded_by AS "recordedBy", created_at AS "createdAt"
       FROM fee_payments WHERE student_id = $1 AND term = $2 AND year = $3
       ORDER BY created_at DESC`,
      [studentId, term, year]
    );
    return res.json({ ...withBalance[0], history });
  }

  res.json(withBalance);
}));

// POST /api/finance/payments — record a new payment. Admin + Bursar only.
router.post('/payments', requireRole(...EDIT_ROLES), asyncHandler(async (req, res) => {
  const { studentId, term, year, amount, method, reference, note } = req.body || {};
  if (!studentId || !term || !year || !amount || amount <= 0) {
    return res.status(400).json({ message: 'studentId, term, year and a positive amount are required.' });
  }

  const { rows: studentRows } = await db.query('SELECT id FROM students WHERE id = $1', [studentId]);
  if (!studentRows.length) return res.status(404).json({ message: 'Student not found.' });

  const { rows } = await db.query(
    `INSERT INTO fee_payments (student_id, term, year, amount, method, reference, note, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, amount::float AS amount, method, reference, note,
               recorded_by AS "recordedBy", created_at AS "createdAt"`,
    [studentId, term, year, amount, method || null, reference || null, note || null, req.user.username]
  );
  await logActivity(req.user.username, `Recorded a fee payment of ${amount} for ${studentId} (${term} ${year})`, req.ip);
  res.status(201).json(rows[0]);
}));

// DELETE /api/finance/payments/:id — correct a mistaken entry. Admin + Bursar only.
router.delete('/payments/:id', requireRole(...EDIT_ROLES), asyncHandler(async (req, res) => {
  const { rows } = await db.query('DELETE FROM fee_payments WHERE id = $1 RETURNING student_id', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Payment not found.' });
  await logActivity(req.user.username, `Deleted a fee payment record (id ${req.params.id})`, req.ip);
  res.json({ ok: true });
}));

/* -------------------------------- Summary -------------------------------- */

// GET /api/finance/summary?term=&year= — termly financial report, by class + totals.
// Aggregates each student's actual billed amount (override-aware), not
// just class-count × class-fee, so overrides are reflected correctly here too.
router.get('/summary', asyncHandler(async (req, res) => {
  const { term, year } = req.query;
  if (!term || !year) return res.status(400).json({ message: 'term and year are required.' });

  const { rows: byClass } = await db.query(
    `SELECT s.class,
            COUNT(DISTINCT s.id)::int AS "studentCount",
            COALESCE(SUM(COALESCE(sfo.amount, fs.amount, 0)), 0)::float AS billed,
            COALESCE(SUM(p.amount), 0)::float AS collected
     FROM students s
     LEFT JOIN fee_structures fs ON fs.class = s.class AND fs.term = $1 AND fs.year = $2
     LEFT JOIN student_fee_overrides sfo ON sfo.student_id = s.id AND sfo.term = $1 AND sfo.year = $2
     LEFT JOIN fee_payments p ON p.student_id = s.id AND p.term = $1 AND p.year = $2
     GROUP BY s.class
     ORDER BY s.class`,
    [term, year]
  );

  const summary = byClass.map(c => ({ ...c, outstanding: Math.max(0, c.billed - c.collected) }));
  const totals = summary.reduce((acc, c) => ({
    billed: acc.billed + c.billed,
    collected: acc.collected + c.collected,
    outstanding: acc.outstanding + c.outstanding
  }), { billed: 0, collected: 0, outstanding: 0 });

  // Collected-amount breakdown by payment method (Cash, Mobile Money, Bank,
  // etc), for the "Collections by Method" chart on the summary page. Blank
  // method values are grouped together as "Unspecified".
  const { rows: byMethod } = await db.query(
    `SELECT COALESCE(NULLIF(method, ''), 'Unspecified') AS method,
            COUNT(*)::int AS count,
            COALESCE(SUM(amount), 0)::float AS amount
     FROM fee_payments
     WHERE term = $1 AND year = $2
     GROUP BY COALESCE(NULLIF(method, ''), 'Unspecified')
     ORDER BY amount DESC`,
    [term, year]
  );

  res.json({ term, year, byClass: summary, totals, byMethod });
}));

module.exports = router;
