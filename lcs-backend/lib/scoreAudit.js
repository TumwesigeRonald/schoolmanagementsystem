/**
 * lib/scoreAudit.js — shared helpers for the marks audit trail and the
 * DOS approval workflow (see routes/scores.routes.js and
 * routes/score-approval.routes.js).
 *
 * Unlike lib/activityLog.js (best-effort, never blocks a login), the audit
 * trail for marks is deliberately NOT best-effort: every audited write runs
 * inside the same database transaction as the mark change itself. If the
 * audit row can't be written, the mark change is rolled back too — so a
 * mark can never change without leaving a record of who changed it.
 */
const db = require('../db');

const MARK_FIELDS = ['ao1', 'ao2', 'eot', 'p1', 'p2'];

// Same limits the marks-entry screen enforces (script.js O_LEVEL_FIELD_LIMITS
// and the A-Level 0-100 paper clamp), now also enforced server-side so a
// direct API call can't store an impossible mark.
const FIELD_LIMITS = { ao1: [0, 3], ao2: [0, 3], eot: [0, 80], p1: [0, 100], p2: [0, 100] };

// Score statuses. A teacher's entries start as 'draft'; "Submit to DOS"
// moves them to 'submitted' (locked for the teacher); the DOS then either
// 'verified' them or sends them back as 'rejected' with a reason.
const STATUS = { DRAFT: 'draft', SUBMITTED: 'submitted', VERIFIED: 'verified', REJECTED: 'rejected' };

// Runs fn(client) inside BEGIN/COMMIT, rolling back on any thrown error.
async function withTransaction(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection may already be gone */ }
    throw err;
  } finally {
    client.release();
  }
}

// Same fallback rule scores.routes.js has always used: an explicit
// term/year wins, otherwise the school's current term_settings row.
async function resolveTermYear(source) {
  const term = source.term;
  const year = source.year ? Number(source.year) : undefined;
  if (term && year) return { term, year };
  const { rows } = await db.query('SELECT term, year FROM term_settings WHERE id = 1');
  const current = rows[0] || { term: 'Term 1', year: new Date().getFullYear() };
  return { term: term || current.term, year: year || current.year };
}

// Normalises a mark for comparison/storage: blank/null -> null, otherwise a
// Number. Returns undefined for something that isn't a valid number.
function normaliseMark(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function pickMarks(row) {
  const out = {};
  MARK_FIELDS.forEach((f) => { out[f] = row && row[f] !== undefined && row[f] !== null ? Number(row[f]) : null; });
  return out;
}

// Who did it: stored by value (not a foreign key) so the trail survives an
// account being renamed or deleted — same reasoning as activity_log.
function actorOf(req) {
  const u = req.user || {};
  return { username: u.username || 'unknown', name: u.name || null, role: u.role || null };
}

// Writes one audit row using the caller's transaction client.
async function insertAudit(client, req, entry) {
  const actor = actorOf(req);
  await client.query(
    `INSERT INTO scores_audit
       (record_key, student_id, subject, class_level, term, year, action,
        old_values, new_values, old_status, new_status, note,
        actor_username, actor_name, actor_role, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      entry.recordKey, entry.studentId, entry.subject, entry.classLevel || null, entry.term, entry.year, entry.action,
      entry.oldValues ? JSON.stringify(entry.oldValues) : null,
      entry.newValues ? JSON.stringify(entry.newValues) : null,
      entry.oldStatus || null, entry.newStatus || null, entry.note || null,
      actor.username, actor.name, actor.role, req.ip || null
    ]
  );
}

module.exports = {
  MARK_FIELDS, FIELD_LIMITS, STATUS,
  withTransaction, resolveTermYear, normaliseMark, pickMarks, actorOf, insertAudit
};
