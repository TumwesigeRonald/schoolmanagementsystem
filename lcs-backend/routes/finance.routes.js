/**
 * routes/finance.routes.js — School Finance data: fee structures,
 * student payments/balances, and termly financial summaries.
 *
 * Every route here requires BOTH a valid login (`authenticate`) AND an
 * unlocked Finance session (`requireFinanceScope` — the separate
 * password gate in finance-auth.routes.js). As of the FINANCE_ROLES
 * change in finance-auth.routes.js, Teachers can no longer set or
 * verify a Finance password at all, so they can never obtain that
 * finance-scoped token and never reach any route below — Admin and
 * Bursar are the only roles that get here now. Write routes still
 * additionally require `requireRole(...EDIT_ROLES)` so Bursar stays
 * scoped to record/edit while Admin retains full access; there is no
 * remaining "view-only" role on this file.
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

/* ----------------------------- Finance Flow ----------------------------- */
// GET /api/finance/finance-flow?year=2026 — month-by-month Revenue vs
// Expenses for the whole calendar year (Jan-Dec), for the Finance Flow
// line chart. Revenue = student fee payments + other recorded revenues.
// Also returns category breakdowns for the year (expenses by category,
// and "other" revenue by category) for pie/donut charts.
router.get('/finance-flow', asyncHandler(async (req, res) => {
  const { year } = req.query;
  if (!year) return res.status(400).json({ message: 'year is required.' });

  const { rows: months } = await db.query(
    `WITH months AS (SELECT generate_series(1,12) AS m),
     fees AS (
       SELECT EXTRACT(MONTH FROM created_at)::int AS m, SUM(amount) AS amt
       FROM fee_payments WHERE EXTRACT(YEAR FROM created_at) = $1 GROUP BY 1
     ),
     other_rev AS (
       SELECT EXTRACT(MONTH FROM revenue_date)::int AS m, SUM(amount) AS amt
       FROM revenues WHERE EXTRACT(YEAR FROM revenue_date) = $1 GROUP BY 1
     ),
     exp AS (
       SELECT EXTRACT(MONTH FROM expense_date)::int AS m, SUM(amount) AS amt
       FROM expenses WHERE EXTRACT(YEAR FROM expense_date) = $1 GROUP BY 1
     )
     SELECT months.m AS month,
            (COALESCE(fees.amt,0) + COALESCE(other_rev.amt,0))::float AS revenue,
            COALESCE(exp.amt,0)::float AS expenses
     FROM months
     LEFT JOIN fees ON fees.m = months.m
     LEFT JOIN other_rev ON other_rev.m = months.m
     LEFT JOIN exp ON exp.m = months.m
     ORDER BY months.m`,
    [year]
  );

  const { rows: expensesByCategory } = await db.query(
    `SELECT category, SUM(amount)::float AS amount
     FROM expenses WHERE EXTRACT(YEAR FROM expense_date) = $1
     GROUP BY category ORDER BY amount DESC`,
    [year]
  );

  const { rows: otherRevenueByCategory } = await db.query(
    `SELECT category, SUM(amount)::float AS amount
     FROM revenues WHERE EXTRACT(YEAR FROM revenue_date) = $1
     GROUP BY category ORDER BY amount DESC`,
    [year]
  );

  const totals = months.reduce((acc, m) => ({
    revenue: acc.revenue + m.revenue,
    expenses: acc.expenses + m.expenses
  }), { revenue: 0, expenses: 0 });
  totals.net = totals.revenue - totals.expenses;

  res.json({ year, months, totals, expensesByCategory, otherRevenueByCategory });
}));

/* -------------------------------- Expenses -------------------------------- */
// Dated (not term/year) — see the schema comment on the `expenses` table.
// Listed/filtered by calendar year + optional month so they line up with
// the Finance Flow chart below.

// GET /api/finance/expenses?year=2026&month=3 (month optional, 1-12)
router.get('/expenses', asyncHandler(async (req, res) => {
  const { year, month } = req.query;
  if (!year) return res.status(400).json({ message: 'year is required.' });
  const params = [year];
  let monthFilter = '';
  if (month) { params.push(month); monthFilter = ` AND EXTRACT(MONTH FROM expense_date) = $${params.length}`; }
  const { rows } = await db.query(
    `SELECT id, category, amount::float AS amount, expense_date AS "date", note,
            recorded_by AS "recordedBy", created_at AS "createdAt"
     FROM expenses WHERE EXTRACT(YEAR FROM expense_date) = $1 ${monthFilter}
     ORDER BY expense_date DESC, id DESC`,
    params
  );
  res.json(rows);
}));

// POST /api/finance/expenses — Admin + Bursar only.
router.post('/expenses', requireRole(...EDIT_ROLES), asyncHandler(async (req, res) => {
  const { category, amount, date, note } = req.body || {};
  if (!category || !amount || amount <= 0) {
    return res.status(400).json({ message: 'category and a positive amount are required.' });
  }
  const { rows } = await db.query(
    `INSERT INTO expenses (category, amount, expense_date, note, recorded_by)
     VALUES ($1,$2, COALESCE($3, CURRENT_DATE), $4, $5)
     RETURNING id, category, amount::float AS amount, expense_date AS "date", note,
               recorded_by AS "recordedBy", created_at AS "createdAt"`,
    [category, amount, date || null, note || null, req.user.username]
  );
  await logActivity(req.user.username, `Recorded a ${category} expense of ${amount}`, req.ip);
  res.status(201).json(rows[0]);
}));

// DELETE /api/finance/expenses/:id — Admin + Bursar only.
router.delete('/expenses/:id', requireRole(...EDIT_ROLES), asyncHandler(async (req, res) => {
  const { rows } = await db.query('DELETE FROM expenses WHERE id = $1 RETURNING category, amount::float AS amount', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Expense not found.' });
  await logActivity(req.user.username, `Deleted an expense record (id ${req.params.id})`, req.ip);
  res.json({ ok: true });
}));

/* -------------------------------- Revenues -------------------------------- */
// Non-fee income (donations, grants, rent, fundraising, etc). Student fee
// income is tracked separately in fee_payments — see the Finance Flow
// route below, which combines both for the monthly chart.

// GET /api/finance/revenues?year=2026&month=3 (month optional, 1-12)
router.get('/revenues', asyncHandler(async (req, res) => {
  const { year, month } = req.query;
  if (!year) return res.status(400).json({ message: 'year is required.' });
  const params = [year];
  let monthFilter = '';
  if (month) { params.push(month); monthFilter = ` AND EXTRACT(MONTH FROM revenue_date) = $${params.length}`; }
  const { rows } = await db.query(
    `SELECT id, category, amount::float AS amount, revenue_date AS "date", note,
            recorded_by AS "recordedBy", created_at AS "createdAt"
     FROM revenues WHERE EXTRACT(YEAR FROM revenue_date) = $1 ${monthFilter}
     ORDER BY revenue_date DESC, id DESC`,
    params
  );
  res.json(rows);
}));

// POST /api/finance/revenues — Admin + Bursar only.
router.post('/revenues', requireRole(...EDIT_ROLES), asyncHandler(async (req, res) => {
  const { category, amount, date, note } = req.body || {};
  if (!category || !amount || amount <= 0) {
    return res.status(400).json({ message: 'category and a positive amount are required.' });
  }
  const { rows } = await db.query(
    `INSERT INTO revenues (category, amount, revenue_date, note, recorded_by)
     VALUES ($1,$2, COALESCE($3, CURRENT_DATE), $4, $5)
     RETURNING id, category, amount::float AS amount, revenue_date AS "date", note,
               recorded_by AS "recordedBy", created_at AS "createdAt"`,
    [category, amount, date || null, note || null, req.user.username]
  );
  await logActivity(req.user.username, `Recorded ${category} revenue of ${amount}`, req.ip);
  res.status(201).json(rows[0]);
}));

// DELETE /api/finance/revenues/:id — Admin + Bursar only.
router.delete('/revenues/:id', requireRole(...EDIT_ROLES), asyncHandler(async (req, res) => {
  const { rows } = await db.query('DELETE FROM revenues WHERE id = $1 RETURNING category, amount::float AS amount', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Revenue not found.' });
  await logActivity(req.user.username, `Deleted a revenue record (id ${req.params.id})`, req.ip);
  res.json({ ok: true });
}));

module.exports = router;
