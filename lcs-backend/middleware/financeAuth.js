/**
 * middleware/financeAuth.js
 *
 * Verifies the short-lived "finance scope" token issued by
 * POST /api/finance-auth/verify-password (see routes/finance-auth.routes.js).
 * This is intentionally separate from the normal login JWT that
 * `authenticate` checks — both are required to reach any route in
 * routes/finance.routes.js, so a leaked/reused login token alone is
 * never enough to read or edit financial data.
 *
 * Frontend sends it as the `x-finance-token` header (never mixed into
 * the normal Authorization header) — see apiRequest() in api.js.
 */
const jwt = require('jsonwebtoken');

function requireFinanceScope(req, res, next) {
  const token = req.headers['x-finance-token'];
  if (!token) {
    return res.status(403).json({ message: 'Finance session required.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.scope !== 'finance') {
      throw new Error('Token is not Finance-scoped.');
    }
    // Extra guard against a stale token surviving a user switch on a
    // shared browser tab (sessionStorage is per-tab, not per-user) —
    // the finance token must belong to whoever is currently logged in.
    if (decoded.username !== req.user.username) {
      throw new Error('Finance token does not match the logged-in user.');
    }
    next();
  } catch (err) {
    return res.status(403).json({ message: 'Finance session expired or invalid. Please re-enter your Finance password.' });
  }
}

module.exports = { requireFinanceScope };
