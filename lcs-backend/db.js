/**
 * db.js — PostgreSQL connection pool (Neon-compatible).
 *
 * On Vercel, each serverless invocation may spin up a fresh Node process,
 * so we keep the pool small (max: 1) and let Neon's own connection pooler
 * (the "pooled" connection string, using pgbouncer) absorb the concurrency.
 * Locally / on Render (long-running process) a larger pool is fine.
 */
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  // Fail loudly at startup rather than on the first query.
  console.error('[db] DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
} else if (!/-pooler\./.test(process.env.DATABASE_URL) && process.env.VERCEL) {
  // Neon's pooled connection string (pgbouncer) has "-pooler" in the host,
  // e.g. ep-xxxx-pooler.us-east-2.aws.neon.tech. On Vercel, every concurrent
  // serverless invocation opens its own connection (max: 1 each below) — at
  // 300+ students, peak traffic can easily mean dozens of invocations at
  // once. Without the pooled string those connections go straight to
  // Postgres and can exhaust Neon's direct connection limit; the pooled
  // string absorbs them via pgbouncer instead. Copy the "Pooled connection"
  // string from the Neon dashboard (not "Direct connection") into
  // DATABASE_URL to fix this.
  console.warn('[db] DATABASE_URL does not look like Neon\'s pooled connection string (no "-pooler" in the host). On Vercel this risks exhausting Neon\'s connection limit under concurrent load — use the "Pooled connection" string from the Neon dashboard instead.');
}

const isServerless = !!process.env.VERCEL;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required by Neon/most free managed PG hosts
  max: isServerless ? 1 : 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  // Catches idle client errors so a dropped connection doesn't crash the process.
  console.error('[db] Unexpected error on idle client', err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect()
};
