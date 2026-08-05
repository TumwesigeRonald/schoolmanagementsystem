/**
 * lib/activityLog.js — records entries in the activity_log table
 * (see migrations/schema.sql) for the Admin dashboard's Activity Log view.
 *
 * Currently called from routes/auth.routes.js on every successful login.
 * Kept as its own best-effort helper so a logging failure (e.g. a
 * transient DB hiccup) can never block or fail the login request itself —
 * any error here is caught and logged server-side only.
 */
const db = require('../db');

async function logActivity(username, actionType, ipAddress) {
  try {
    await db.query(
      'INSERT INTO activity_log (username, action_type, ip_address) VALUES ($1, $2, $3)',
      [username, actionType, ipAddress || null]
    );
  } catch (err) {
    console.error('[activity-log] failed to record event:', err);
  }
}

module.exports = { logActivity };
