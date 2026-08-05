-- =============================================================
-- Luweero Community SS Portal — Database Schema
-- Target: PostgreSQL 14+ (Neon / Supabase free tier compatible)
-- Safe to re-run: uses IF NOT EXISTS / DO blocks throughout.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -------------------------------------------------------------
-- Enum for user roles. Values match ROLES in the frontend's
-- api.js exactly ("Administrator" / "Teacher" / "Student") so
-- the role string returned by /api/auth/login can be used
-- as-is by the existing frontend RBAC logic with no translation.
-- -------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE user_role AS ENUM ('Administrator', 'Teacher', 'Student');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- -------------------------------------------------------------
-- students — the learner registry (Admin-managed)
-- id uses the school's own format, e.g. "LCS/001"
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  class       TEXT NOT NULL,           -- e.g. S.1, S.2 ... S.6
  gender      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- teachers — staff registry.
-- NOTE: login credentials are NOT duplicated here. They live
-- exclusively in `users`, referenced by teacher_id, so there is
-- a single source of truth for password hashes (see users table
-- below and README "Design notes" for why).
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teachers (
  id          TEXT PRIMARY KEY,        -- e.g. "T001"
  name        TEXT NOT NULL,
  username    TEXT NOT NULL UNIQUE,
  subject     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- users — single authentication table for every role.
-- - Admin rows:   student_id and teacher_id both NULL
-- - Teacher rows: teacher_id -> teachers.id
-- - Student rows: student_id -> students.id, username = student id
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL,
  name          TEXT NOT NULL,
  student_id    TEXT REFERENCES students(id) ON DELETE CASCADE,
  teacher_id    TEXT REFERENCES teachers(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- scores — one row per (subject, student). Covers both O-Level
-- fields (ao1, ao2, eot) and A-Level fields (p1, p2) in the same
-- table since a given deployment only uses one set at a time,
-- matching how marksStorage[recordKey] works on the frontend.
-- record_key mirrors the frontend's `${SUBJECT}_${studentId}` key.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scores (
  id           SERIAL PRIMARY KEY,
  record_key   TEXT NOT NULL UNIQUE,        -- e.g. "MATHEMATICS_LCS/001"
  subject      TEXT NOT NULL,
  student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_level  TEXT,                        -- class at time of entry, e.g. "S.4"
  ao1          NUMERIC(5,2),
  ao2          NUMERIC(5,2),
  eot          NUMERIC(5,2),
  p1           NUMERIC(5,2),
  p2           NUMERIC(5,2),
  remarks      TEXT,
  touched      BOOLEAN NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- attendance — one row per (date, student).
-- record_key mirrors the frontend's `${date}_${studentId}` key.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance (
  id           SERIAL PRIMARY KEY,
  record_key   TEXT NOT NULL UNIQUE,        -- e.g. "2026-07-27_LCS/001"
  date         DATE NOT NULL,
  student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_level  TEXT,
  status       TEXT NOT NULL DEFAULT 'Present',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- term_settings — academic calendar. Single "current" row
-- (id = 1) that the frontend reads/writes as one object.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS term_settings (
  id           SERIAL PRIMARY KEY,
  term         TEXT NOT NULL DEFAULT 'Term 1',
  year         INTEGER NOT NULL DEFAULT EXTRACT(YEAR FROM now())::INTEGER,
  next_begins  DATE,
  next_ends    DATE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- resources — learning materials (optional module; the frontend
-- degrades gracefully if these routes are unused).
-- file_data holds small files as base64. For anything beyond a
-- few MB, swap file_data for a URL into object storage (Supabase
-- Storage / Cloudinary / S3) instead of storing bytes in Postgres.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resources (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  subject      TEXT,
  class_level  TEXT,
  file_name    TEXT,
  file_type    TEXT,
  file_data    TEXT,
  uploaded_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- file_url / file_size support storing the file in cloud object storage
-- (Vercel Blob) instead of as base64 in file_data.
-- Additive + idempotent: safe to re-run, does not touch any other table.
ALTER TABLE resources ADD COLUMN IF NOT EXISTS file_url  TEXT;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS file_size INTEGER;

-- -------------------------------------------------------------
-- activity_log — records login events (and any other tracked admin
-- actions later) for the Admin dashboard's Activity Log view.
-- Written by routes/auth.routes.js on every successful login via
-- lib/activityLog.js. Deliberately does NOT reference users/students/
-- teachers with a foreign key: a login event should still be kept
-- (and stay attributable to the username that logged in) even if that
-- account is later renamed or removed.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id           SERIAL PRIMARY KEY,
  username     TEXT NOT NULL,
  action_type  TEXT NOT NULL,        -- e.g. "LOGIN"
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scores_student      ON scores(student_id);
CREATE INDEX IF NOT EXISTS idx_scores_subject      ON scores(subject);
CREATE INDEX IF NOT EXISTS idx_scores_class        ON scores(class_level);
CREATE INDEX IF NOT EXISTS idx_attendance_date     ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_attendance_student  ON attendance(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_class    ON attendance(class_level);
CREATE INDEX IF NOT EXISTS idx_students_class      ON students(class);
CREATE INDEX IF NOT EXISTS idx_users_student       ON users(student_id);
CREATE INDEX IF NOT EXISTS idx_users_teacher       ON users(teacher_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);
