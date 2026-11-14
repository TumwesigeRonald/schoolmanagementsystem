/**
 * routes/score-approval.routes.js — DOS approval workflow + marks audit trail.
 * Mounted at /api/scores (see app.js) alongside routes/scores.routes.js.
 *
 *   POST /api/scores/submit        Teacher/Admin — submit a class+subject's marks to the DOS
 *   GET  /api/scores/review        Admin — one line per class+subject with status counts
 *   GET  /api/scores/review/detail Admin — every student's marks for one class+subject
 *   POST /api/scores/verify        Admin — approve submitted marks
 *   POST /api/scores/reject        Admin — send marks back (reason required)
 *   GET  /api/scores/audit         Admin — the full audit trail, filterable
 *
 * "DOS" is the Administrator role in this system (there is no separate DOS
 * login), so the Administrator account(s) are the approvers.
 */
const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const {
  STATUS, withTransaction, resolveTermYear, pickMarks, insertAudit
} = require('../lib/scoreAudit');

const router = express.Router();

const MARK_COLS = 'ao1, ao2, eot, p1, p2';
const HAS_ANY_MARK = '(ao1 IS NOT NULL OR ao2 IS NOT NULL OR eot IS NOT NULL OR p1 IS NOT NULL OR p2 IS NOT NULL)';

// Moves rows of one class+subject+term+year from `fromStatuses` to `toStatus`
// and writes one audit row per moved score, all in one transaction. Each
// audit row snapshots the marks as they were at that moment, so the trail
// proves exactly which numbers the DOS verified/rejected.
async function transition(req, { classLevel, subject, term, year, recordKeys, fromStatuses, toStatus, action, note, extraSet, extraParams, requireMarks }) {
  return withTransaction(async (client) => {
    const params = [classLevel, subject, term, year, fromStatuses];
    let keyFilter = '';
    if (Array.isArray(recordKeys) && recordKeys.length) {
      params.push(recordKeys);
      keyFilter = ` AND record_key = ANY($${params.length})`;
    }
    const locked = await client.query(
      `SELECT * FROM scores
       WHERE class_level = $1 AND subject = $2 AND term = $3 AND year = $4
         AND status = ANY($5) AND touched = true${requireMarks ? ` AND ${HAS_ANY_MARK}` : ''}${keyFilter}
       FOR UPDATE`,
      params
    );
    if (!locked.rows.length) return [];

    const ids = locked.rows.map((r) => r.id);
    const setParams = [ids, toStatus, ...(extraParams || [])];
    await client.query(
      `UPDATE scores SET status = $2, updated_at = now()${extraSet ? ', ' + extraSet : ''} WHERE id = ANY($1)`,
      setParams
    );

    for (const row of locked.rows) {
      await insertAudit(client, req, {
        recordKey: row.record_key, studentId: row.student_id, subject: row.subject, classLevel: row.class_level,
        term: row.term, year: row.year, action,
        newValues: pickMarks(row), oldStatus: row.status, newStatus: toStatus, note
      });
    }
    return locked.rows;
  });
}

// POST /api/scores/submit — Teacher or Administrator.
// Body: { classLevel, subject, term?, year? }
// Submits every draft/rejected row (that actually has a mark) for the class
// + subject to the DOS. Rows with no marks are left alone, never submitted.
router.post('/submit', authenticate, requireRole('Teacher', 'Administrator'), asyncHandler(async (req, res) => {
  const { classLevel, subject } = req.body || {};
  if (!classLevel || !subject) {
    return res.status(400).json({ message: 'classLevel and subject are required.' });
  }
  const { term, year } = await resolveTermYear(req.body || {});

  const moved = await transition(req, {
    classLevel, subject, term, year,
    fromStatuses: [STATUS.DRAFT, STATUS.REJECTED],
    toStatus: STATUS.SUBMITTED,
    action: 'SUBMIT',
    extraSet: 'submitted_by = $3, submitted_at = now(), review_note = NULL',
    extraParams: [req.user.username],
    requireMarks: true
  });

  if (!moved.length) {
    return res.status(400).json({
      message: 'Nothing to submit — there are no draft marks for this class and subject (they may already be submitted or verified).'
    });
  }
  res.json({ submitted: moved.length, classLevel, subject, term, year });
}));

// GET /api/scores/review?term=&year= — Administrator only.
// One row per class+subject with a count of students in each status. Lets
// the DOS see at a glance what is waiting for approval.
router.get('/review', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { term, year } = await resolveTermYear(req.query);
  const { rows } = await db.query(
    `SELECT class_level AS "classLevel", subject,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'draft')::int     AS draft,
            COUNT(*) FILTER (WHERE status = 'submitted')::int AS submitted,
            COUNT(*) FILTER (WHERE status = 'verified')::int  AS verified,
            COUNT(*) FILTER (WHERE status = 'rejected')::int  AS rejected,
            MAX(submitted_at) AS "submittedAt",
            (ARRAY_AGG(submitted_by ORDER BY submitted_at DESC NULLS LAST))[1] AS "submittedBy"
     FROM scores
     WHERE term = $1 AND year = $2 AND touched = true AND ${HAS_ANY_MARK}
     GROUP BY class_level, subject
     ORDER BY (COUNT(*) FILTER (WHERE status = 'submitted')) DESC, class_level, subject`,
    [term, year]
  );
  res.json({ term, year, batches: rows });
}));

// GET /api/scores/review/detail?class=&subject=&term=&year= — Administrator only.
// Every student's marks for one class+subject, with who last changed them
// and how many times each row has been edited (a high edit count on a
// submitted mark is worth a look).
router.get('/review/detail', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { class: classLevel, subject } = req.query;
  if (!classLevel || !subject) {
    return res.status(400).json({ message: 'class and subject are required.' });
  }
  const { term, year } = await resolveTermYear(req.query);
  const { rows } = await db.query(
    `SELECT s.record_key AS "recordKey", s.student_id AS "studentId", st.name AS "studentName",
            s.ao1, s.ao2, s.eot, s.p1, s.p2, s.remarks, s.status,
            s.review_note AS "reviewNote", s.last_edited_by AS "lastEditedBy", s.updated_at AS "updatedAt",
            s.submitted_by AS "submittedBy", s.submitted_at AS "submittedAt",
            s.verified_by AS "verifiedBy", s.verified_at AS "verifiedAt",
            (SELECT COUNT(*)::int FROM scores_audit a
               WHERE a.record_key = s.record_key AND a.action IN ('CREATE', 'UPDATE')) AS "editCount",
            (SELECT COUNT(*)::int FROM scores_audit a
               WHERE a.record_key = s.record_key AND a.action = 'UPDATE'
                 AND s.submitted_at IS NOT NULL AND a.created_at > s.submitted_at) AS "editsAfterSubmit"
     FROM scores s
     LEFT JOIN students st ON st.id = s.student_id
     WHERE s.class_level = $1 AND s.subject = $2 AND s.term = $3 AND s.year = $4
       AND s.touched = true AND (s.ao1 IS NOT NULL OR s.ao2 IS NOT NULL OR s.eot IS NOT NULL OR s.p1 IS NOT NULL OR s.p2 IS NOT NULL)
     ORDER BY st.name NULLS LAST, s.student_id`,
    [classLevel, subject, term, year]
  );
  res.json({ term, year, classLevel, subject, rows });
}));

// POST /api/scores/verify — Administrator only.
// Body: { classLevel, subject, term?, year?, recordKeys? }
// Approves every 'submitted' row for the class+subject (or only the listed
// recordKeys). Only submitted marks can be verified — a draft that the
// teacher is still editing can't be approved by accident.
router.post('/verify', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { classLevel, subject, recordKeys } = req.body || {};
  if (!classLevel || !subject) {
    return res.status(400).json({ message: 'classLevel and subject are required.' });
  }
  const { term, year } = await resolveTermYear(req.body || {});
  const moved = await transition(req, {
    classLevel, subject, term, year, recordKeys,
    fromStatuses: [STATUS.SUBMITTED],
    toStatus: STATUS.VERIFIED,
    action: 'VERIFY',
    extraSet: 'verified_by = $3, verified_at = now(), review_note = NULL',
    extraParams: [req.user.username]
  });
  if (!moved.length) {
    return res.status(400).json({ message: 'There are no submitted marks to verify for this class and subject.' });
  }
  res.json({ verified: moved.length, classLevel, subject, term, year });
}));

// POST /api/scores/reject — Administrator only.
// Body: { classLevel, subject, term?, year?, recordKeys?, reason }
// Sends submitted (or already-verified) marks back to the teacher with a
// written reason, which is also stored in the audit trail. This is also the
// only way a verified mark can be re-opened for correction.
router.post('/reject', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { classLevel, subject, recordKeys } = req.body || {};
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!classLevel || !subject) {
    return res.status(400).json({ message: 'classLevel and subject are required.' });
  }
  if (reason.length < 3) {
    return res.status(400).json({ message: 'Please give a reason so the teacher knows what to correct.' });
  }
  const { term, year } = await resolveTermYear(req.body || {});
  const moved = await transition(req, {
    classLevel, subject, term, year, recordKeys,
    fromStatuses: [STATUS.SUBMITTED, STATUS.VERIFIED],
    toStatus: STATUS.REJECTED,
    action: 'REJECT',
    note: reason,
    extraSet: 'review_note = $3, verified_by = NULL, verified_at = NULL',
    extraParams: [reason]
  });
  if (!moved.length) {
    return res.status(400).json({ message: 'There are no submitted or verified marks to send back for this class and subject.' });
  }
  res.json({ rejected: moved.length, classLevel, subject, term, year });
}));

// GET /api/scores/audit — Administrator only. Newest first.
// Filters (all optional): term, year, class, subject, student (id), actor
// (username), action (CREATE|UPDATE|DELETE|SUBMIT|VERIFY|REJECT), limit
// (default 200, max 1000), offset.
router.get('/audit', authenticate, requireRole('Administrator'), asyncHandler(async (req, res) => {
  const { term, year, class: classLevel, subject, student, actor, action } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const where = [];
  const values = [];
  const add = (sql, v) => { values.push(v); where.push(sql.replace('?', `$${values.length}`)); };
  if (term) add('a.term = ?', term);
  if (year) add('a.year = ?', Number(year));
  if (classLevel) add('a.class_level = ?', classLevel);
  if (subject) add('a.subject = ?', subject);
  if (student) {
    values.push(`%${student}%`);
    where.push(`(a.student_id ILIKE $${values.length} OR st.name ILIKE $${values.length})`);
  }
  if (actor) add('a.actor_username ILIKE ?', `%${actor}%`);
  if (action) add('a.action = ?', String(action).toUpperCase());

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  values.push(limit, offset);
  const { rows } = await db.query(
    `SELECT a.id, a.record_key AS "recordKey", a.student_id AS "studentId", st.name AS "studentName",
            a.subject, a.class_level AS "classLevel", a.term, a.year, a.action,
            a.old_values AS "oldValues", a.new_values AS "newValues",
            a.old_status AS "oldStatus", a.new_status AS "newStatus", a.note,
            a.actor_username AS "actorUsername", a.actor_name AS "actorName", a.actor_role AS "actorRole",
            a.ip_address AS "ipAddress", a.created_at AS "createdAt"
     FROM scores_audit a
     LEFT JOIN students st ON st.id = a.student_id
     ${whereSql}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  res.json(rows);
}));

module.exports = router;
