require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const studentsRoutes = require('./routes/students.routes');
const teachersRoutes = require('./routes/teachers.routes');
const scoresRoutes = require('./routes/scores.routes');
const attendanceRoutes = require('./routes/attendance.routes');
const termRoutes = require('./routes/term.routes');
const resourcesRoutes = require('./routes/resources.routes');
const uploadRoutes = require('./routes/upload.routes'); // <-- Added upload routes

const app = express();

// --- Core middleware ---
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({
  origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((o) => o.trim()),
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));

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
