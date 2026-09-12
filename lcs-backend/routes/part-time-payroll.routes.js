/**
 * routes/part-time-payroll.routes.js — Part-Time Weekly Payroll.
 *
 * Mounted at /api/finance/part-time-payroll. A DELIBERATELY SEPARATE
 * track from routes/payroll.routes.js (Full-Time Monthly Payroll) — not
 * a shared table with a "frequency" flag. Business rule this encodes:
 *
 *   - Full-Time staff: paid MONTHLY, processed/disbursed by
 *     Administrator/Human Resource/Director only. That's the existing
 *     payroll.routes.js / payroll_records table — UNTOUCHED by this file.
 *
 *   - Part-Time staff: paid WEEKLY, and collect/sign for their pay
 *     directly at the Bursar's office, with NO HR/Director approval
 *     step required. That's this file / part_time_payroll_records.
 *
 * Every route here requires BOTH a valid login (`authenticate`) AND an
 * unlocked Finance session (`requireFinanceScope`), same as every other
 * finance-adjacent route file. Two role tiers:
 *
 *   - VIEW_ROLES (Administrator, Bursar, Human Resource, Director):
 *     read-only oversight for everyone who can reach Finance at all —
 *     HR/Director aren't approving anything here, but they can still
 *     see what's been paid out, for reporting/audit.
 *
 *   - EDIT_ROLES (Administrator, Bursar): generating a week's records,
 *     marking them paid, and deleting a not-yet-paid entry to correct a
 *     mistake. Bursar runs this track end-to-end without needing
 *     Human Resource or Director to act first — that's the whole point
 *     of this being a separate, streamlined track.
 *
 * `amount` is entered fresh per record rather than pulled from a fixed
 * base_salary, since part-time hours worked vary week to week — see the
 * schema comment on part_time_payroll_records in migrations/schema.sql.
 *
 * Marking a record "paid" writes a matching entry to the general
 * `expenses` ledger in the same transaction (same Financial Integration
 * pattern as payroll.routes.js's PUT /records/:id/mark-paid), by
 * inserting into `expenses` directly — NOT by calling
 * POST /api/finance/expenses, which stays behind EXPENSE_REVENUE_ROLES
 * in finance.routes.js (Bursar excluded there). This mirrors the
 * existing full-time mark-paid route exactly: a Bursar-run action can
 * produce a system-generated ledger entry for schoolwide reporting
 * without ever granting Bursar visibility into the Expenses tab itself.
 */
const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requireFinanceScope } = require('../middleware/financeAuth');
const asyncHandler = require('../middleware/asyncHandler');
const { logActivity } = require('../lib/activityLog');

const router = express.Router();
const VIEW_ROLES = ['Administrator', 'Bursar', 'Human Resource', 'Director'];
const EDIT_ROLES = ['Administrator', 'Bursar'];

router.use(authenticate, requireFinanceScope);

/* ------------------------- Part-time staff picker ------------------------- */
// GET /api/finance/part-time-payroll/staff?search= — minimal id/name list
// of active Part-Time staff (never base_salary/phone/paymentDetails —
// same "never leak the fuller profile" principle as
// GET /finance/payroll/advance-lookup in payroll.routes.js).
router.get('/staff', requireRole(...VIEW_ROLES), asyncHandler(async (req, res) => {
  const { search } = req.query;
  const params = [];
  let filter = `status = 'active' AND employment_type = 'part-time'`;
  if (search) { params.push(`%${search}%`); filter += ` AND name ILIKE $${params.length}`; }
  const { rows } = await db.query(
    `SELECT id, name FROM staff_profiles WHERE ${filter} ORDER BY name`,
    params
  );
  res.json(rows);
}));

/* ------------------------------ Weekly records ------------------------------ */

// GET /api/finance/part-time-payroll/records?weekStart=YYYY-MM-DD&staffId=
// At least one of weekStart/staffId is required, so this can never
// accidentally return the entire history table in one call.
router.get('/records', requireRole(...VIEW_ROLES), asyncHandler(async (req, res) => {
  const { weekStart, staffId } = req.query;
  if (!weekStart && !staffId) {
    return res.status(400).json({ message: 'weekStart or staffId is required.' });
  }
  const params = [];
  const filters = [];
  if (weekStart) { params.push(weekStart); filters.push(`ptpr.week_start_date = $${params.length}`); }
  if (staffId) { params.push(staffId); filters.push(`ptpr.staff_id = $${params.length}`); }

  const { rows } = await db.query(
    `SELECT ptpr.id, ptpr.staff_id AS "staffId", sp.name AS "staffName",
            ptpr.week_start_date AS "weekStartDate", ptpr.amount::float AS amount,
            ptpr.status, ptpr.note, ptpr.recorded_by AS "recordedBy",
            ptpr.paid_by AS "paidBy", ptpr.paid_at AS "paidAt",
            ptpr.expense_id AS "expenseId", ptpr.created_at AS "createdAt"
     FROM part_time_payroll_records ptpr
     JOIN staff_profiles sp ON sp.id = ptpr.staff_id
     WHERE ${filters.join(' AND ')}
     ORDER BY ptpr.week_start_date DESC, sp.name`,
    params
  );
  res.json(rows);
}));

// POST /api/finance/part-time-payroll/records — record one staff member's
// pay for one week. Bursar-facing: no approval step, takes effect (as
// "pending") immediately.
router.post('/records', requireRole(...EDIT_ROLES), asyncHandler(async (req, res) => {
  const { staffId, weekStartDate, amount, note } = req.body || {};
  if (!staffId || !weekStartDate || amount == null) {
    return res.status(400).json({ message: 'staffId, weekStartDate and amount are required.' });
  }
  if (amount < 0) return res.status(400).json({ message: 'amount cannot be negative.' });

  const { rows: staffRows } = await db.query(
    `SELECT id FROM staff_profiles WHERE id = $1 AND employment_type = 'part-time'`,
    [staffId]
  );
  if (!staffRows.length) {
    return res.status(404).json({ message: 'Part-time staff member not found.' });
  }

  let rows;
  try {
    ({ rows } = await db.query(
      `INSERT INTO part_time_payroll_records (staff_id, week_start_date, amount, note, recorded_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, staff_id AS "staffId", week_start_date AS "weekStartDate",
                 amount::float AS amount, status, note, recorded_by AS "recordedBy",
                 created_at AS "createdAt"`,
      [staffId, weekStartDate, amount, note || null, req.user.username]
    ));
  } catch (err) {
    if (err.code === '23505') { // unique_violation on (staff_id, week_start_date)
      return res.status(409).json({ message: 'This staff member already has a payroll record for that week.' });
    }
    throw err;
  }

  await logActivity(req.user.username, `Recorded a part-time payroll entry of ${amount} for staff #${staffId} (week of ${weekStartDate})`, req.ip);
  res.status(201).json(rows[0]);
}));

// DELETE /api/finance/part-time-payroll/records/:id — only while still
// 'pending', same guard as allowances/DELETE — once paid, it's part of
// the expense ledger's audit trail and stays put.
router.delete('/records/:id', requireRole(...EDIT_ROLES), asyncHandler(async (req, res) => {
  const { rows: existing } = await db.query(
    'SELECT status FROM part_time_payroll_records WHERE id = $1',
    [req.params.id]
  );
  if (!existing.length) return res.status(404).json({ message: 'Payroll record not found.' });
  if (existing[0].status === 'paid') {
    return res.status(409).json({ message: 'This record has already been paid and cannot be deleted.' });
  }

  await db.query('DELETE FROM part_time_payroll_records WHERE id = $1', [req.params.id]);
  await logActivity(req.user.username, `Deleted a part-time payroll record (id ${req.params.id})`, req.ip);
  res.json({ ok: true });
}));

// PUT /api/finance/part-time-payroll/records/:id/mark-paid — marks one
// record "paid" and, in the same transaction, writes a matching entry to
// the general `expenses` ledger (category "Salaries") — same pattern as
// payroll.routes.js's monthly mark-paid, so both tracks show up
// consistently on the Finance Flow chart/reports even though Bursar
// never has to touch the Expenses tab itself to make that happen.
router.put('/records/:id/mark-paid', requireRole(...EDIT_ROLES), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: recordRows } = await client.query(
      `SELECT ptpr.id, ptpr.status, ptpr.week_start_date AS "weekStartDate",
              ptpr.amount::float AS amount, sp.name AS "staffName"
       FROM part_time_payroll_records ptpr
       JOIN staff_profiles sp ON sp.id = ptpr.staff_id
       WHERE ptpr.id = $1
       FOR UPDATE OF ptpr`,
      [id]
    );
    if (!recordRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Payroll record not found.' });
    }
    const record = recordRows[0];
    if (record.status === 'paid') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This record has already been marked paid.' });
    }

    const note = `Part-Time Payroll: ${record.staffName} (week of ${record.weekStartDate.toISOString ? record.weekStartDate.toISOString().slice(0, 10) : record.weekStartDate})`;
    const { rows: expenseRows } = await client.query(
      `INSERT INTO expenses (category, amount, expense_date, note, recorded_by)
       VALUES ('Salaries', $1, CURRENT_DATE, $2, $3)
       RETURNING id`,
      [record.amount, note, req.user.username]
    );
    const expenseId = expenseRows[0].id;

    const { rows: updated, rowCount } = await client.query(
      `UPDATE part_time_payroll_records
       SET status = 'paid', paid_by = $1, paid_at = now(), expense_id = $2
       WHERE id = $3 AND status = 'pending'
       RETURNING id, staff_id AS "staffId", week_start_date AS "weekStartDate",
                 amount::float AS amount, status, note, recorded_by AS "recordedBy",
                 paid_by AS "paidBy", paid_at AS "paidAt", expense_id AS "expenseId",
                 created_at AS "createdAt"`,
      [req.user.username, expenseId, id]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This record has already been marked paid.' });
    }

    await client.query('COMMIT');
    await logActivity(req.user.username, `Marked part-time payroll paid for ${record.staffName} (week of ${record.weekStartDate}), logged expense #${expenseId}`, req.ip);
    res.json({ ...updated[0], staffName: record.staffName });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
