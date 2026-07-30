/**
 * server.js — local dev / Render entry point.
 * (Vercel doesn't use this file — see api/index.js instead.)
 */
const app = require('./app');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`[server] LCS Portal API listening on http://localhost:${PORT}`);
  console.log(`[server] Health check: http://localhost:${PORT}/api/health`);
});
