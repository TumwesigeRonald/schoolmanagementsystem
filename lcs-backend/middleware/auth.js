/**
 * middleware/auth.js — JWT verification + role guards.
 */
const jwt = require('jsonwebtoken');

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ message: 'Missing or invalid Authorization header.' });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Session expired or invalid. Please log in again.' });
  }
}

// Director is the school's top-level account: anywhere a route is open to
// 'Administrator', a Director is let through too. Routes that don't list
// Administrator (e.g. Student-only endpoints) are unaffected.
const ADMIN_EQUIVALENT_ROLES = ['Administrator', 'Director'];

function requireRole(...roles) {
  const allowed = roles.includes('Administrator')
    ? Array.from(new Set([...roles, ...ADMIN_EQUIVALENT_ROLES]))
    : roles;
  return (req, res, next) => {
    if (!req.user || !allowed.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission to perform this action.' });
    }
    return next();
  };
}

module.exports = { authenticate, requireRole, ADMIN_EQUIVALENT_ROLES };
