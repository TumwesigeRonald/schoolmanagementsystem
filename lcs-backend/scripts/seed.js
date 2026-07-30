/**
 * scripts/seed.js
 * Seeds default data so the app is usable immediately after migration:
 *  - admin / admin123          (Administrator)
 *  - gnamuli / teach123        (Teacher, Mathematics)
 *  - pokello / teach123        (Teacher, English)
 *  - LCS/001..LCS/004          (Students; default password = their own ID)
 *  - a default term_settings row
 *
 * CHANGE ALL DEFAULT PASSWORDS AFTER FIRST LOGIN.
 * Usage: npm run seed
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const HASH_ROUNDS = 10;

async function upsertUser(client, { username, password, role, name, studentId = null, teacherId = null }) {
  const hash = await bcrypt.hash(password, HASH_ROUNDS);
  await client.query(
    `INSERT INTO users (username, password_hash, role, name, student_id, teacher_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           name = EXCLUDED.name,
           student_id = EXCLUDED.student_id,
           teacher_id = EXCLUDED.teacher_id`,
    [username, hash, role, name, studentId, teacherId]
  );
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- Students (matches the frontend's current in-memory defaults) ---
    const students = [
      { id: 'LCS/001', name: 'Namubiru Grace', class: 'S.4', gender: 'Female' },
      { id: 'LCS/002', name: 'Kigozi John', class: 'S.4', gender: 'Male' },
      { id: 'LCS/003', name: 'Akwero Patricia', class: 'S.3', gender: 'Female' },
      { id: 'LCS/004', name: 'TUMWESIGE RONALD', class: 'S.1', gender: 'Male' }
    ];
    for (const s of students) {
      await client.query(
        `INSERT INTO students (id, name, class, gender) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, class = EXCLUDED.class, gender = EXCLUDED.gender`,
        [s.id, s.name, s.class, s.gender]
      );
      // Default student password = their own ID. They should change it
      // via /api/auth/change-password on first login in a real rollout.
      await upsertUser(client, {
        username: s.id,
        password: s.id,
        role: 'Student',
        name: s.name,
        studentId: s.id
      });
    }

    // --- Teachers ---
    const teachers = [
      { id: 'T001', name: 'Namuli Grace', username: 'gnamuli', password: 'teach123', subject: 'MATHEMATICS' },
      { id: 'T002', name: 'Okello Peter', username: 'pokello', password: 'teach123', subject: 'ENGLISH' }
    ];
    for (const t of teachers) {
      await client.query(
        `INSERT INTO teachers (id, name, username, subject) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, username = EXCLUDED.username, subject = EXCLUDED.subject`,
        [t.id, t.name, t.username, t.subject]
      );
      await upsertUser(client, {
        username: t.username,
        password: t.password,
        role: 'Teacher',
        name: t.name,
        teacherId: t.id
      });
    }

    // --- Admin ---
    await upsertUser(client, {
      username: 'admin',
      password: 'admin123',
      role: 'Administrator',
      name: 'System Administrator'
    });

    // --- Default term settings (single row, id = 1) ---
    await client.query(
      `INSERT INTO term_settings (id, term, year, next_begins, next_ends)
       VALUES (1, 'Term 1', EXTRACT(YEAR FROM now())::INTEGER, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`
    );

    await client.query('COMMIT');
    console.log('[seed] Done. Default logins:');
    console.log('  admin / admin123');
    console.log('  gnamuli / teach123, pokello / teach123');
    console.log('  LCS/001, LCS/002, LCS/003, LCS/004 (password = same as ID)');
    console.log('[seed] Change every one of these after first login.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
