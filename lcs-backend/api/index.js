/**
 * api/index.js — Vercel serverless function entry point.
 * Vercel calls this file's exported handler for every request matched
 * by the rewrite rule in vercel.json ("/api/(.*)" -> "/api/index").
 * Exporting the Express app directly works because Express apps are
 * valid (req, res) => {} handlers.
 */
module.exports = require('../app');
