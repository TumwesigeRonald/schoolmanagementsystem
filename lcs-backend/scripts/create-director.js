/**
 * scripts/create-director.js
 * Creates (or updates) the Director login. The Director has full
 * administrative access: every Administrator screen and action, plus
 * School Finance once the Finance password gate is passed.
 *
 * Usage (from lcs-backend/):
 *   node scripts/create-director.js <username> "<Full Name>" <password>
 *   e.g. node scripts/create-director.js director "Mr. Director" "S0me-Str0ng-Pass"
 *
 * Or keep the password out of your shell history:
 *   DIRECTOR_PASSWORD="S0me-Str0ng-Pass" node scripts/create-director.js director "Mr. Director"
 *
 * Re-running with an existing username updates that account's name and
 * password and makes sure its role is Director.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const HASH_ROUNDS = 10;

async function main() {
  const [username, fullName, passwordArg] = process.argv.slice(2);
  const password = passwordArg || process.env.DIRECTOR_PASSWORD;

  if (!username || !fullName || !password) {
    console.error('Usage: node scripts/create-director.js <username> "<Full Name>" <password>');
    console.error('       (or set DIRECTOR_PASSWORD instead of passing the password)');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    // Safe to repeat: no-op if the Director role already exists in the enum
    // (migrations/schema.sql adds it too, this just covers older databases).
    await client.query(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Director'`);

    const hash = await bcrypt.hash(password, HASH_ROUNDS);
    const existing = await client.query(
      'SELECT username, role FROM users WHERE lower(username) = lower($1)',
      [username.trim()]
    );

    // Never silently convert an Administrator/Teacher/Student login.
    if (existing.rows[0] && !['Director', 'Bursar', 'Human Resource'].includes(existing.rows[0].role)) {
      console.error(`"${existing.rows[0].username}" already exists as a ${existing.rows[0].role}. Pick a different username.`);
      process.exit(1);
    }

    await client.query(
      `INSERT INTO users (username, password_hash, role, name)
       VALUES ($1, $2, 'Director', $3)
       ON CONFLICT (username) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = 'Director',
             name = EXCLUDED.name`,
      [username.trim(), hash, fullName.trim()]
    );
    console.log(`[create-director] Director account "${username.trim()}" is ready.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[create-director] Failed:', err.message);
  process.exit(1);
});
