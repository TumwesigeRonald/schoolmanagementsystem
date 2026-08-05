require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth.routes');
const studentsRoutes = require('./routes/students.routes');
const teachersRoutes = require('./routes/teachers.routes');
const scoresRoutes = require('./routes/scores.routes');
const attendanceRoutes = require('./routes/attendance.routes');
const termRoutes = require('./routes/term.routes');
const resourcesRoutes = require('./routes/resources.routes');
const uploadRoutes = require('./routes/upload.routes'); // <-- Added upload routes
const activityLogRoutes = require('./routes/activity-log.routes');
const noticesRoutes = require('./routes/notices.routes');

const app = express();

// Trust the platform's reverse proxy (Vercel/Render both sit behind one) so
// req.ip reflects the real client address from X-Forwarded-For instead of
// the proxy's own internal address — needed for accurate IP capture in the
// Activity Log (see routes/auth.routes.js + lib/activityLog.js).
app.set('trust proxy', 1);

// --- Core middleware ---
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({
  origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((o) => o.trim()),
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));

// --- Security headers ---
// Sets sane defaults (X-Content-Type-Options, HSTS, X-Frame-Options, etc.)
// for a JSON API. contentSecurityPolicy/crossOriginEmbedderPolicy are
// disabled here because this process only ever serves JSON to a separate
// frontend origin, not HTML — leaving them on adds their headers to API
// responses with no benefit (no HTML/inline-script surface to protect on
// this server) and occasionally confuses non-browser API clients.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// --- Rate limiting ---
// Defends against brute-force credential guessing and traffic spikes
// (accidental or malicious) overwhelming the DB connection pool. Uses
// express-rate-limit's default in-memory store, which is per-instance —
// on Vercel that means each serverless instance tracks its own counters
// rather than one global count, so this is a best-effort mitigation layer
// rather than a hard guarantee; pairing it with account lockout or a
// shared store (e.g. Redis) would tighten this further if it's ever
// needed, but this already meaningfully raises the cost of both a
// password-guessing script and a naive flood of requests.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 login attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please wait a few minutes and try again.' }
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // generous ceiling for normal multi-user use (dashboards, bulk saves), just enough to blunt a runaway client/script
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down and try again shortly.' }
});
app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);

// --- Health check (useful for Vercel/Render uptime checks) ---
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- Routes (paths match ENDPOINTS in the frontend's api.js) ---
app.use('/api/auth', authRoutes);
app.use('/api/students', studentsRoutes);
app.use('/api/teachers', teachersRoutes);
app.use('/api/scores', scoresRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/settings/term', termRoutes);
app.use('/api/resources', resourcesRoutes);
app.use('/api/upload', uploadRoutes); // <-- Mounted upload endpoint here
app.use('/api/activity-log', activityLogRoutes);
app.use('/api/notices', noticesRoutes);

// --- 404 for unmatched /api routes ---
app.use('/api', (req, res) => res.status(404).json({ message: 'Not found.' }));

// --- Centralized error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl} ->`, err);
  if (err.code === '23505') { // Postgres unique_violation
    return res.status(409).json({ message: 'A record with that identifier already exists.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Payload too large.' });
  }
  // Safety net: a MulterError (e.g. an oversized file upload) should normally
  // be caught locally by the upload route itself, but if one ever reaches
  // here instead, surface a clear message rather than the generic fallback.
  if (err.name === 'MulterError') {
    return res.status(413).json({ message: `Upload failed: ${err.message}` });
  }
  const isConnectionOrTimeout =
    err.code === 'ETIMEDOUT' ||
    err.code === 'ECONNREFUSED' ||
    err.code === 'ECONNRESET' ||
    err.code === '57P01' || 
    err.code === '53300' || 
    /timeout/i.test(err.message || '');
  if (isConnectionOrTimeout) {
    return res.status(503).json({ message: 'The database is taking too long to respond. Please try again in a moment — your changes were not saved.' });
  }
  res.status(500).json({ message: 'Something went wrong on the server.' });
});

module.exports = app;
