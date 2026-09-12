/**
 * routes/payroll.routes.js — Staff Payroll, Allowances & Salary Advances.
 *
 * Mounted at /api/finance/payroll. Every route here requires BOTH a valid
 * login (`authenticate`) AND an unlocked Finance session
 * (`requireFinanceScope`), same as routes/finance.routes.js. Unlike that
 * file, there is NO single role set for the whole file anymore — this
 * file has TWO tiers, checked per-route (not via a blanket router.use):
 *
 *   - PAYROLL_EDIT_ROLES (Administrator, Human Resource, Director):
 *     staff profiles, base salaries, allowances, payroll generation/
 *     records, mark-paid. Bursar gets ZERO access to any of this —
 *     not even read-only — same strict exclusion as before.
 *
 *   - SALARY_ADVANCE_ROLES (PAYROLL_EDIT_ROLES + Bursar): viewing and
 *     issuing salary advances specifically. Bursar is allowed here on
 *     purpose (school policy: the Bursar handles cash-advance requests
 *     day to day), and gets a lightweight staff picker
 *     (GET /advance-lookup) that returns id+name+roleType only — never
 *     base_salary, phone, payment_details, allowances, or salary
 *     history, which stay behind PAYROLL_EDIT_ROLES on GET /staff/:id.
 *
 * A Bursar CAN still pass the Finance gate (see FINANCE_ROLES in
 * finance-auth.routes.js) to reach the General Finance module, but
 * every route below still requires one of these two role lists via its
 * own `requireRole(...)` call — the Finance gate alone is never
 * sufficient to reach anything in this file, salary advances included.
 *
 * NOT included yet (next step — Financial Integration): marking a payroll
 * record "paid" and writing the matching entry to the `expenses` ledger.
 * This file covers staff profiles, allowances, salary advances, and
 * payroll generation only.
 */
const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requireFinanceScope } = require('../middleware/financeAuth');
const asyncHandler = require('../middleware/asyncHandler');
const { logActivity } = require('../lib/activityLog');

const router = express.Router();
const PAYROLL_EDIT_ROLES = ['Administrator', 'Human Resource', 'Director'];
const SALARY_ADVANCE_ROLES = [...PAYROLL_EDIT_ROLES, 'Bursar'];

// Login + unlocked Finance session apply to every route below. The role
// check is NOT included here on purpose (unlike the old single-tier
// version of this file) — it's applied per-route below instead, since
// this file now has two different role sets rather than one.
router.use(authenticate, requireFinanceScope);

const STAFF_COLUMNS = `
  id, name, role_type AS "roleType", employment_type AS "employmentType",
  base_salary::float AS "baseSalary",
  phone, payment_details AS "paymentDetails", status,
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

/* ============================== Staff Profiles ============================== */

// GET /api/finance/payroll/staff?status=&roleType=&search=&page=&pageSize=
// Pagination is OPT-IN via `page`, same convention as GET /api/students:
// omit it and this returns the old plain array (unchanged for any caller
// that isn't the Staff Profiles table). Pass `page` to get back
// { data, total, page, pageSize, totalPages } instead.
router.get('/staff', requireRole(...PAYROLL_EDIT_ROLES), asyncHandler(async (req, res) => {
  const { status, roleType, employmentType, search, page: rawPage, pageSize: rawPageSize } = req.query;
  const params = [];
  const filters = [];
  if (status) { params.push(status); filters.push(`status = $${params.length}`); }
  if (roleType) { params.push(roleType); filters.push(`role_type = $${params.length}`); }
  if (employmentType) { params.push(employmentType); filters.push(`employment_type = $${params.length}`); }
  if (search) { params.push(`%${search}%`); filters.push(`name ILIKE $${params.length}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  if (rawPage === undefined) {
    const { rows } = await db.query(
      `SELECT ${STAFF_COLUMNS} FROM staff_profiles ${where} ORDER BY name`,
      params
    );
    return res.json(rows);
  }

  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(rawPageSize, 10) || 25));
  const offset = (page - 1) * pageSize;

  params.push(pageSize, offset);
  const limitParam = params.length - 1;
  const offsetParam = params.length;
  const { rows } = await db.query(
    `SELECT ${STAFF_COLUMNS}, COUNT(*) OVER()::int AS "totalCount"
     FROM staff_profiles ${where}
     ORDER BY name
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params
  );

  const total = rows.length ? rows[0].totalCount : 0;
  const data = rows.map(({ totalCount, ...rest }) => rest);

  res.json({
    data,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  });
}));

// GET /api/finance/payroll/staff/:id — profile + allowances + advances,
// for the staff detail/edit screen.
router.get('/staff/:id', requireRole(...PAYROLL_EDIT_ROLES), asyncHandler(async (req, res) => {
  const { rows } = await db.query(`SELECT ${STAFF_COLUMNS} FROM staff_profiles WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Staff member not found.' });

  const { rows: allowances } = await db.query(
    `SELECT id, title, amount::float AS amount, type, date_added AS "dateAdded",
            applied_payroll_id AS "appliedPayrollId"
     FROM allowances WHERE staff_id = $1 ORDER BY date_added DESC, id DESC`,
    [req.params.id]
  );
  const { rows: advances } = await db.query(
    `SELECT id, requested_amount::float AS "requestedAmount",
            repayment_amount_per_month::float AS "repaymentAmountPerMonth",
            balance_remaining::float AS "balanceRemaining", status,
            request_date AS "requestDate", issued_by AS "issuedBy"
     FROM salary_advances WHERE staff_id = $1 ORDER BY request_date DESC, id DESC`,
    [req.params.id]
  );
  const { rows: salaryHistory } = await db.query(
    `SELECT id, old_salary::float AS "oldSalary", new_salary::float AS "newSalary",
            changed_by AS "changedBy", reason, changed_at AS "changedAt"
     FROM staff_salary_history WHERE staff_id = $1 ORDER BY changed_at DESC, id DESC`,
    [req.params.id]
  );

  res.json({ ...rows[0], allowances, advances, salaryHistory });
}));

// POST /api/finance/payroll/staff — create a staff profile.
router.post('/staff', requireRole(...PAYROLL_EDIT_ROLES), asyncHandler(async (req, res) => {
  const { name, roleType, employmentType, baseSalary, phone, paymentDetails, status } = req.body || {};
  if (!name || !roleType || baseSalary == null) {
    return res.status(400).json({ message: 'name, roleType and baseSalary are required.' });
  }
  if (!['teaching', 'non-teaching'].includes(roleType)) {
    return res.status(400).json({ message: 'roleType must be "teaching" or "non-teaching".' });
  }
  if (employmentType !== undefined && !['full-time', 'part-time'].includes(employmentType)) {
    return res.status(400).json({ message: 'employmentType must be "full-time" or "part-time".' });
  }
  if (baseSalary < 0) {
    return res.status(400).json({ message: 'baseSalary cannot be negative.' });
  }

  const { rows } = await db.query(
    `INSERT INTO staff_profiles (name, role_type, employment_type, base_salary, phone, payment_details, status)
     VALUES ($1,$2, COALESCE($3, 'full-time'), $4,$5,$6, COALESCE($7, 'active'))
     RETURNING ${STAFF_COLUMNS}`,
    [name, roleType, employmentType || null, baseSalary, phone || null, JSON.stringify(paymentDetails || {}), status || null]
  );
  await logActivity(req.user.username, `Added staff profile for ${name} (payroll)`, req.ip);
  res.status(201).json(rows[0]);
}));

// PUT /api/finance/payroll/staff/:id — partial update. When baseSalary is
// included AND differs from the current value, this also writes a row to
// staff_salary_history (see the table's comment in migrations/schema.sql)
// in the same transaction as the update, so a salary change is never
// recorded without the profile actually changing, or vice versa. An
// optional `reason` in the body is attached to that history row; it's
// silently ignored if baseSalary isn't actually changing.
router.put('/staff/:id', requireRole(...PAYROLL_EDIT_ROLES), asyncHandler(async (req, res) => {
  const { name, roleType, employmentType, baseSalary, phone, paymentDetails, status, reason } = req.body || {};
  if (roleType !== undefined && !['teaching', 'non-teaching'].includes(roleType)) {
    return res.status(400).json({ message: 'roleType must be "teaching" or "non-teaching".' });
  }
  if (employmentType !== undefined && !['full-time', 'part-time'].includes(employmentType)) {
    return res.status(400).json({ message: 'employmentType must be "full-time" or "part-time".' });
  }
  if (baseSalary !== undefined && baseSalary < 0) {
    return res.status(400).json({ message: 'baseSalary cannot be negative.' });
  }
  if (status !== undefined && !['active', 'inactive'].includes(status)) {
    return res.status(400).json({ message: 'status must be "active" or "inactive".' });
  }

  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (roleType !== undefined) { fields.push(`role_type = $${i++}`); values.push(roleType); }
  if (employmentType !== undefined) { fields.push(`employment_type = $${i++}`); values.push(employmentType); }
  if (baseSalary !== undefined) { fields.push(`base_salary = $${i++}`); values.push(baseSalary); }
  if (phone !== undefined) { fields.push(`phone = $${i++}`); values.push(phone); }
  if (paymentDetails !== undefined) { fields.push(`payment_details = $${i++}`); values.push(JSON.stringify(paymentDetails || {})); }
  if (status !== undefined) { fields.push(`status = $${i++}`); values.push(status); }
  if (!fields.length) return res.status(400).json({ message: 'Nothing to update.' });
  fields.push(`updated_at = now()`);
  values.push(req.params.id);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    let previousSalary = null;
    if (baseSalary !== undefined) {
      const { rows: current } = await client.query(
        'SELECT base_salary::float AS "baseSalary" FROM staff_profiles WHERE id = $1 FOR UPDATE',
        [req.params.id]
      );
      if (!current.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'Staff member not found.' });
      }
      previousSalary = current[0].baseSalary;
    }

    const { rows, rowCount } = await client.query(
      `UPDATE staff_profiles SET ${fields.join(', ')} WHERE id = $${i} RETURNING ${STAFF_COLUMNS}`,
      values
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Staff member not found.' });
    }

    const salaryChanged = previousSalary !== null && previousSalary !== baseSalary;
    if (salaryChanged) {
      await client.query(
        `INSERT INTO staff_salary_history (staff_id, old_salary, new_salary, changed_by, reason)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, previousSalary, baseSalary, req.user.username, reason || null]
      );
    }

    await client.query('COMMIT');
    await logActivity(
      req.user.username,
      `Updated staff profile for ${rows[0].name} (payroll)${salaryChanged ? ` — salary ${previousSalary} \u2192 ${baseSalary}` : ''}`,
      req.ip
    );
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// POST /api/finance/payroll/staff/bulk-salary-update — apply one flat or
// percentage change across many staff in a single request (e.g. "give
// every active Teaching staff member a 10% raise") instead of editing
// profiles one at a time. Targets are EITHER an explicit staffIds array
// OR a { roleType, status } filter — staffIds wins if given; when neither
// staffIds nor status is given, status defaults to "active" so a bulk
// raise never silently touches inactive/former staff.
// A staff member whose new salary would go negative (a flat pay cut
// larger than their current salary) is skipped, not aborted — the rest
// of the batch still commits. Nothing here overlaps with PUT /staff/:id;
// it just does the same update+history-row pairing, once per target.
router.post('/staff/bulk-salary-update', requireRole(...PAYROLL_EDIT_ROLES), asyncHandler(async (req, res) => {
  const { staffIds, roleType, status, mode, value, reason } = req.body || {};
  if (!['percent', 'flat'].includes(mode)) {
    return res.status(400).json({ message: 'mode must be "percent" or "flat".' });
  }
  if (value == null || isNaN(value) || Number(value) === 0) {
    return res.status(400).json({ message: 'A non-zero numeric value is required.' });
  }
  if (roleType && !['teaching', 'non-teaching'].includes(roleType)) {
    return res.status(400).json({ message: 'roleType must be "teaching" or "non-teaching".' });
  }
  if (status && !['active', 'inactive'].includes(status)) {
    return res.status(400).json({ message: 'status must be "active" or "inactive".' });
  }

  let targets;
  if (Array.isArray(staffIds) && staffIds.length) {
    ({ rows: targets } = await db.query(
      `SELECT id, name, base_salary::float AS "baseSalary" FROM staff_profiles WHERE id = ANY($1::int[])`,
      [staffIds]
    ));
  } else {
    const params = [status || 'active'];
    const filters = ['status = $1'];
    if (roleType) { params.push(roleType); filters.push(`role_type = $${params.length}`); }
    ({ rows: targets } = await db.query(
      `SELECT id, name, base_salary::float AS "baseSalary" FROM staff_profiles WHERE ${filters.join(' AND ')}`,
      params
    ));
  }
  if (!targets.length) return res.status(404).json({ message: 'No staff members matched that selection.' });

  const client = await db.getClient();
  const updated = [];
  const skipped = [];
  try {
    await client.query('BEGIN');
    for (const staff of targets) {
      const newSalary = mode === 'percent'
        ? Math.round(staff.baseSalary * (1 + Number(value) / 100) * 100) / 100
        : Math.round((staff.baseSalary + Number(value)) * 100) / 100;
      if (newSalary < 0) {
        skipped.push({ id: staff.id, name: staff.name, reason: 'Would result in a negative salary.' });
        continue;
      }
      await client.query('UPDATE staff_profiles SET base_salary = $1, updated_at = now() WHERE id = $2', [newSalary, staff.id]);
      await client.query(
        `INSERT INTO staff_salary_history (staff_id, old_salary, new_salary, changed_by, reason)
         VALUES ($1,$2,$3,$4,$5)`,
        [staff.id, staff.baseSalary, newSalary, req.user.username, reason || null]
      );
      updated.push({ id: staff.id, name: staff.name, oldSalary: staff.baseSalary, newSalary });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logActivity(
    req.user.username,
    `Bulk salary update (${mode} ${value}) applied to ${updated.length} staff member(s)${skipped.length ? `, ${skipped.length} skipped` : ''}`,
    req.ip
  );
  res.json({ updated, skipped });
}));

// DELETE /api/finance/payroll/staff/:id — hard delete is only allowed if
// the staff member has no payroll history, so past payroll runs can never
// silently lose their staff record. Otherwise, set status to "inactive"
// instead (PUT /staff/:id) so they stop appearing in future payroll runs
// while their history stays intact.
router.delete('/staff/:id', requireRole(...PAYROLL_EDIT_ROLES), asyncHandler(async (req, res) => {
  const { rows: existing } = await db.query('SELECT id, name FROM staff_profiles WHERE id = $1', [req.params.id]);
  if (!existing.length) return res.status(404).json({ message: 'Staff member not found.' });

  const { rows: hasPayroll } = await db.query('SELECT id FROM payroll_records WHERE staff_id = $1 LIMIT 1', [req.params.id]);
  if (hasPayroll.length) {
    return res.status(409).json({
      message: 'This staff member has payroll history and cannot be deleted. Set their status to "inactive" instead.'
    });
  }

  await db.query('DELETE FROM staff_profiles WHERE id = $1', [req.params.id]);
  await logActivity(req.user.username, `Deleted staff profile for ${existing[0].name} (payroll)`, req.ip);
  res.json({ ok: true });
}));

/* ========================= Salary Advances staff picker ========================= */
// GET /api/finance/payroll/advance-lookup?search= — a deliberately minimal
// staff list (id, name, roleType only — NEVER baseSalary, phone,
// paymentDetails, allowances, or salary history) so Bursar can pick a
// staff member to issue/view a salary advance for, without exposing any
// of the general payroll data that stays behind PAYROLL_EDIT_ROLES on
// GET /staff and GET /staff/:id. Administrator/HR/Director can use this
// too, but they also have the fuller /staff and /staff/:id endpoints.
router.get('/advance-lookup', requireRole(...SALARY_ADVANCE_ROLES), asyncHandler(async (req, res) => {
  const { search } = req.query;
  const params = [];
  let filter = `status = 'active'`;
  if (search) { params.push(`%${search}%`); filter += ` AND name ILIKE $${params.length}`; }
  const { rows } = await db.query(
    `SELECT id, name, role_type AS "roleType" FROM staff_profiles WHERE ${filter} ORDER BY name`,
    params
  );
  res.json(rows);
}));

/* ============================== Allowances ============================== */

// GET /api/finance/payroll/staff/:staffId/allowances
router.get('/staff/:staffId/allowances', requireRole(...PAYROLL_EDIT_ROLES), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, title, amount::float AS amount, type, date_added AS "dateAdded",
            applied_payroll_id AS "appliedPayrollId"
     FROM allowances WHERE staff_id = $1 ORDER BY date_added DESC, id DESC`,
    [req.params.staffId]
  );
  res.json(rows);
}));

// POST /api/finance/payroll/staff/:staffId/allowances — assign an allowance.
router.post('/staff/:staffId/allowances', requireRole(...PAYROLL_EDIT_ROLES), asyncHandler(async (req, res) => {
  const { staffId } = req.params;
  const { title, amount, type, dateAdded } = req.body || {};
  if (!title || amount == null || !type) {
    return res.status(400).json({ message: 'title, amount and type are required.' });
  }
  if (amount <= 0) return res.status(400).json({ message: 'amount must be greater than 0.' });
  if (!['recurring', 'one-time'].includes(type)) {
    return res.status(400).json({ message: 'type must be "recurring" or "one-time".' });
  }

  const { rows: staffRows } = await db.query('SELECT id FROM staff_profiles WHERE id = $1', [staffId]);
  if (!staffRows.length) return res.status(404).json({ message: 'Staff member not found.' });

  const { rows } = await db.query(
    `INSERT INTO allowances (staff_id, title, amount, type, date_added)
     VALUES ($1,$2,$3,$4, COALESCE($5, CURRENT_DATE))
     RETURNING id, title, amount::float AS amount, type, date_added AS "dateAdded",
               applied_payroll_id AS "appliedPayrollId"`,
    [staffId, title, amount, type, dateAdded || null]
  );
  await logActivity(req.user.username, `Added a ${type} allowance "${title}" of ${amount} for staff #${staffId}`, req.ip);
  res.status(201).json(rows[0]);
}));

// DELETE /api/finance/payroll/allowances/:id — only while it hasn't been
// paid out yet. Once a payroll run has consumed it (applied_payroll_id is
// set), it's part of that payroll record's audit trail and stays put.
router.delete('/allowances/:id', requireRole(...PAYROLL_EDIT_ROLES), asyncHandler(async (req, res) => {
  const { rows: existing } = await db.query('SELECT applied_payroll_id AS "appliedPayrollId" FROM allowances WHERE id = $1', [req.params.id]);
  if (!existing.length) return res.status(404).json({ message: 'Allowance not found.' });
  if (existing[0].appliedPayrollId != null) {
    return res.status(409).json({ message: 'This allowance has already been paid out and cannot be deleted.' });
  }

  await db.query('DELETE FROM allowances WHERE id = $1', [req.params.id]);
  await logActivity(req.user.username, `Deleted allowance #${req.params.id}`, req.ip);
  res.json({ ok: true });
}));

/* ============================== Salary Advances ============================== */

// GET /api/finance/payroll/staff/:staffId/advances
router.get('/staff/:staffId/advances', requireRole(...SALARY_ADVANCE_ROLES), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, requested_amount::float AS "requestedAmount",
            repayment_amount_per_month::float AS "repaymentAmountPerMonth",
            balance_remaining::float AS "balanceRemaining", status,
            request_date AS "requestDate", issued_by AS "issuedBy"
     FROM salary_advances WHERE staff_id = $1 ORDER BY request_date DESC, id DESC`,
    [req.params.staffId]
  );
  res.json(rows);
}));

// POST /api/finance/payroll/staff/:staffId/advances — issue a salary
// advance. Issuing (not just requesting) is what this endpoint does: it
// immediately creates the tracking balance and sets status to "active" so
// the next payroll run(s) start deducting the monthly repayment. There's
// no separate "approve" step in this design — approval happens outside
// the system (e.g. a conversation with the Bursar) before this is called.
router.post('/staff/:staffId/advances', requireRole(...SALARY_ADVANCE_ROLES), asyncHandler(async (req, res) => {
  const { staffId } = req.params;
  const { requestedAmount, repaymentAmountPerMonth, requestDate } = req.body || {};
  if (requestedAmount == null || repaymentAmountPerMonth == null) {
    return res.status(400).json({ message: 'requestedAmount and repaymentAmountPerMonth are required.' });
  }
  if (requestedAmount <= 0) return res.status(400).json({ message: 'requestedAmount must be greater than 0.' });
  if (repaymentAmountPerMonth <= 0) return res.status(400).json({ message: 'repaymentAmountPerMonth must be greater than 0.' });

  const { rows: staffRows } = await db.query('SELECT id FROM staff_profiles WHERE id = $1', [staffId]);
  if (!staffRows.length) return res.status(404).json({ message: 'Staff member not found.' });

  const { rows } = await db.query(
    `INSERT INTO salary_advances
       (staff_id, requested_amount, repayment_amount_per_month, balance_remaining, status, request_date, issued_by)
     VALUES ($1,$2,$3,$2, 'active', COALESCE($4, CURRENT_DATE), $5)
     RETURNING id, requested_amount::float AS "requestedAmount",
               repayment_amount_per_month::float AS "repaymentAmountPerMonth",
               balance_remaining::float AS "balanceRemaining", status,
               request_date AS "requestDate", issued_by AS "issuedBy"`,
    [staffId, requestedAmount, repaymentAmountPerMonth, requestDate || null, req.user.username]
  );
  await logActivity(req.user.username, `Issued a salary advance of ${requestedAmount} to staff #${staffId}`, req.ip);
  res.status(201).json(rows[0]);
}));

/* ============================= Payroll Generation ============================= */

// GET /api/finance/payroll/records?month=&year=&staffId=
router.get('/records', requireRole(...PAYROLL_EDIT_ROLES), asyncHandler(async (req, res) => {
  const { month, year, staffId } = req.query;
  if (!month || !year) return res.status(400).json({ message: 'month and year are required.' });

  const params = [month, year];
  let staffFilter = '';
  if (staffId) { params.push(staffId); staffFilter = ` AND pr.staff_id = $${params.length}`; }

  const { rows } = await db.query(
    `SELECT pr.id, pr.staff_id AS "staffId", sp.name AS "staffName", sp.role_type AS "roleType",
            pr.month, pr.year, pr.base_salary::float AS "baseSalary",
            pr.total_allowances::float AS "totalAllowances",
            pr.advance_deduction::float AS "advanceDeduction",
            pr.net_pay::float AS "netPay", pr.status,
            pr.generated_by AS "generatedBy", pr.paid_by AS "paidBy", pr.paid_at AS "paidAt",
            pr.expense_id AS "expenseId", pr.created_at AS "createdAt"
     FROM payroll_records pr
     JOIN staff_profiles sp ON sp.id = pr.staff_id
     WHERE pr.month = $1 AND pr.year = $2 ${staffFilter}
     ORDER BY sp.name`,
    params
  );
  res.json(rows);
}));

// POST /api/finance/payroll/generate — run payroll for a month/year.
// Body: { month, year, staffIds?: number[] }. Omit staffIds to run for
// every 'active' staff member.
//
// For each eligible staff member NOT already having a payroll_records row
// for this month/year:
//   net_pay = base_salary
//           + SUM(recurring allowances) + SUM(un-applied one-time allowances)
//           - SUM(this month's advance deduction across their active advances)
// Staff who already have a row for this month/year are skipped (idempotent
// re-run), and reported back separately so nothing looks silently dropped.
//
// Everything for one staff member happens in a single transaction: the
// payroll_records insert, stamping consumed one-time allowances, and
// decrementing/clearing advance balances all succeed or fail together.
router.post('/generate', requireRole(...PAYROLL_EDIT_ROLES), asyncHandler(async (req, res) => {
  const { month, year, staffIds } = req.body || {};
  if (!month || !year || month < 1 || month > 12) {
    return res.status(400).json({ message: 'A valid month (1-12) and year are required.' });
  }

  const params = [];
  let staffFilter = `status = 'active'`;
  if (Array.isArray(staffIds) && staffIds.length) {
    params.push(staffIds);
    staffFilter += ` AND id = ANY($${params.length})`;
  }
  const { rows: staffList } = await db.query(
    `SELECT id, name, base_salary::float AS "baseSalary" FROM staff_profiles WHERE ${staffFilter} ORDER BY name`,
    params
  );

  const generated = [];
  const skipped = []; // already had a record for this month/year

  for (const staff of staffList) {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Idempotency check + row lock: SELECT ... FOR UPDATE isn't needed
      // here since the UNIQUE (staff_id, month, year) constraint is the
      // real guard — this check just lets us skip with a friendly message
      // instead of hitting a 23505 unique_violation.
      const dupe = await client.query(
        'SELECT id FROM payroll_records WHERE staff_id = $1 AND month = $2 AND year = $3',
        [staff.id, month, year]
      );
      if (dupe.rows.length) {
        await client.query('ROLLBACK');
        skipped.push({ staffId: staff.id, name: staff.name, reason: 'Already generated for this month/year.' });
        continue;
      }

      // Allowances: recurring ones always count; one-time ones only if
      // not yet consumed by an earlier payroll run.
      const { rows: eligibleAllowances } = await client.query(
        `SELECT id, amount::float AS amount FROM allowances
         WHERE staff_id = $1 AND (type = 'recurring' OR (type = 'one-time' AND applied_payroll_id IS NULL))`,
        [staff.id]
      );
      const totalAllowances = eligibleAllowances.reduce((sum, a) => sum + a.amount, 0);

      // Advances: every 'active' advance is deducted this run, by its
      // monthly repayment amount or whatever balance is left, whichever
      // is smaller (so the last installment doesn't overshoot into a
      // negative balance).
      const { rows: activeAdvances } = await client.query(
        `SELECT id, repayment_amount_per_month::float AS "repaymentAmountPerMonth",
                balance_remaining::float AS "balanceRemaining"
         FROM salary_advances WHERE staff_id = $1 AND status = 'active'`,
        [staff.id]
      );
      let advanceDeduction = 0;
      const advanceUpdates = activeAdvances.map((adv) => {
        const deduction = Math.min(adv.repaymentAmountPerMonth, adv.balanceRemaining);
        advanceDeduction += deduction;
        return { id: adv.id, newBalance: adv.balanceRemaining - deduction };
      });

      const netPay = staff.baseSalary + totalAllowances - advanceDeduction;

      const { rows: recordRows } = await client.query(
        `INSERT INTO payroll_records
           (staff_id, month, year, base_salary, total_allowances, advance_deduction, net_pay, status, generated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7, 'pending', $8)
         RETURNING id, staff_id AS "staffId", month, year, base_salary::float AS "baseSalary",
                   total_allowances::float AS "totalAllowances", advance_deduction::float AS "advanceDeduction",
                   net_pay::float AS "netPay", status, created_at AS "createdAt"`,
        [staff.id, month, year, staff.baseSalary, totalAllowances, advanceDeduction, netPay, req.user.username]
      );
      const record = recordRows[0];

      if (eligibleAllowances.length) {
        await client.query(
          `UPDATE allowances SET applied_payroll_id = $1
           WHERE id = ANY($2) AND type = 'one-time' AND applied_payroll_id IS NULL`,
          [record.id, eligibleAllowances.map((a) => a.id)]
        );
      }
      for (const upd of advanceUpdates) {
        await client.query(
          `UPDATE salary_advances
           SET balance_remaining = $1, status = CASE WHEN $1 <= 0 THEN 'cleared' ELSE status END
           WHERE id = $2`,
          [upd.newBalance, upd.id]
        );
      }

      await client.query('COMMIT');
      generated.push({ ...record, name: staff.name });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  if (generated.length) {
    await logActivity(req.user.username, `Generated payroll for ${generated.length} staff (${month}/${year})`, req.ip);
  }
  res.status(201).json({ generated, skipped });
}));

/* ========================= Financial Integration (mark paid) ========================= */

// PUT /api/finance/payroll/records/:id/mark-paid — marks one payroll record
// "paid" and, in the same transaction, writes the matching entry to the
// general `expenses` ledger (category "Salaries") so payroll shows up
// alongside every other school expense on the Finance Flow chart/reports.
// The insert + update happen in one transaction so a paid record can never
// exist without its ledger entry (or vice versa). Guarded by
// `WHERE status = 'pending'` at the UPDATE, not just a preceding SELECT, so
// two concurrent requests for the same record can't both create an expense
// row — the second one's UPDATE simply matches 0 rows and is reported back
// as a conflict instead.
router.put('/records/:id/mark-paid', requireRole(...PAYROLL_EDIT_ROLES), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: recordRows } = await client.query(
      `SELECT pr.id, pr.status, pr.month, pr.year, pr.net_pay::float AS "netPay",
              sp.name AS "staffName"
       FROM payroll_records pr
       JOIN staff_profiles sp ON sp.id = pr.staff_id
       WHERE pr.id = $1
       FOR UPDATE OF pr`,
      [id]
    );
    if (!recordRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Payroll record not found.' });
    }
    const record = recordRows[0];
    if (record.status === 'paid') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This payroll record has already been marked paid.' });
    }

    const note = `Payroll: ${record.staffName} (${record.month}/${record.year})`;
    const { rows: expenseRows } = await client.query(
      `INSERT INTO expenses (category, amount, expense_date, note, recorded_by)
       VALUES ('Salaries', $1, CURRENT_DATE, $2, $3)
       RETURNING id`,
      [record.netPay, note, req.user.username]
    );
    const expenseId = expenseRows[0].id;

    const { rows: updated, rowCount } = await client.query(
      `UPDATE payroll_records
       SET status = 'paid', paid_by = $1, paid_at = now(), expense_id = $2
       WHERE id = $3 AND status = 'pending'
       RETURNING id, staff_id AS "staffId", month, year, base_salary::float AS "baseSalary",
                 total_allowances::float AS "totalAllowances", advance_deduction::float AS "advanceDeduction",
                 net_pay::float AS "netPay", status, generated_by AS "generatedBy",
                 paid_by AS "paidBy", paid_at AS "paidAt", expense_id AS "expenseId",
                 created_at AS "createdAt"`,
      [req.user.username, expenseId, id]
    );
    if (!rowCount) {
      // Someone else's request won the race between our SELECT and this
      // UPDATE — roll back so the expense row we just inserted isn't left
      // orphaned, and report it as the same conflict as the earlier check.
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This payroll record has already been marked paid.' });
    }

    await client.query('COMMIT');
    await logActivity(req.user.username, `Marked payroll paid for ${record.staffName} (${record.month}/${record.year}), logged expense #${expenseId}`, req.ip);
    res.json({ ...updated[0], staffName: record.staffName });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
