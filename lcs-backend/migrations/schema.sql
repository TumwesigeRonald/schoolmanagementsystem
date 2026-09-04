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
  initials    TEXT,                    -- e.g. "JN" — a teacher's standing initials,
                                        -- used only to prefill the bulk "TR's Initial"
                                        -- box on the marks-entry screen. NOT a live
                                        -- link: once stamped onto a scores row it's a
                                        -- frozen copy, so editing this later never
                                        -- rewrites initials already printed on past
                                        -- report cards.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Safe to re-run against a database created before this column existed.
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS initials TEXT;

-- -------------------------------------------------------------
-- ai_toolbox_items — AI Teacher Toolbox (Lesson Plan / Scheme of
-- Work / Activity of Integration & CAI / Record of Work).
-- One shared table for all four tools: rigid columns for what
-- teachers actually filter/sort by, JSONB for the tool-specific
-- body, since each tool's output shape genuinely differs.
-- See lcs-backend/config/aiTools/ for what each tool_type's
-- input_params/content actually contain.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_toolbox_items (
  id            BIGSERIAL PRIMARY KEY,
  teacher_id    TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,

  tool_type     TEXT NOT NULL CHECK (tool_type IN (
                  'lesson_plan',
                  'scheme_of_work',
                  'activity_of_integration',
                  'record_of_work'
                )),

  title         TEXT NOT NULL,
  class         TEXT,
  subject       TEXT,
  term          TEXT,
  year          INTEGER,
  topic         TEXT,

  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'final', 'archived')),

  input_params  JSONB NOT NULL DEFAULT '{}'::jsonb,
  content       JSONB NOT NULL,

  model_used    TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_toolbox_teacher
  ON ai_toolbox_items (teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_toolbox_teacher_tool
  ON ai_toolbox_items (teacher_id, tool_type);
CREATE INDEX IF NOT EXISTS idx_ai_toolbox_class_subject_term_year
  ON ai_toolbox_items (class, subject, term, year);
CREATE INDEX IF NOT EXISTS idx_ai_toolbox_content_gin
  ON ai_toolbox_items USING GIN (content);

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
  record_key   TEXT NOT NULL UNIQUE,        -- e.g. "MATHEMATICS_LCS/001_Term 1_2026"
  subject      TEXT NOT NULL,
  student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_level  TEXT,                        -- class at time of entry, e.g. "S.4"
  term         TEXT,                        -- e.g. "Term 1" — see migration block below
  year         INTEGER,                     -- e.g. 2026
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
-- MIGRATION: scope scores to (student, subject, term, year)
-- -------------------------------------------------------------
-- Originally `scores` had one row per (subject, student), globally —
-- entering Term 2 marks silently overwrote Term 1's marks in place
-- because record_key = "${subject}_${studentId}" was UNIQUE with no
-- term/year in it at all. This block adds term/year to any database
-- created before this existed, backfills existing rows with the best
-- available guess (the term/year on file in term_settings — the only
-- historical signal available, since the old rows never recorded which
-- term they belonged to), then moves uniqueness onto the composite key
-- so a new term's marks can never again overwrite an old term's marks.
-- Idempotent / safe to re-run.
ALTER TABLE scores ADD COLUMN IF NOT EXISTS term TEXT;
ALTER TABLE scores ADD COLUMN IF NOT EXISTS year INTEGER;

DO $$
DECLARE
  fallback_term TEXT;
  fallback_year INTEGER;
BEGIN
  -- Only touch rows that predate this migration (term IS NULL). Rows
  -- created after the backend routes below were deployed already carry
  -- a real term/year, so they are never touched here.
  IF EXISTS (SELECT 1 FROM scores WHERE term IS NULL) THEN
    SELECT ts.term, ts.year INTO fallback_term, fallback_year
      FROM term_settings ts WHERE ts.id = 1;

    IF fallback_term IS NULL THEN
      fallback_term := 'Term 1';
      fallback_year := EXTRACT(YEAR FROM now())::INTEGER;
    END IF;

    UPDATE scores
      SET term = fallback_term, year = fallback_year,
          record_key = subject || '_' || student_id || '_' || fallback_term || '_' || fallback_year
      WHERE term IS NULL;
  END IF;
END $$;

ALTER TABLE scores ALTER COLUMN term SET NOT NULL;
ALTER TABLE scores ALTER COLUMN year SET NOT NULL;

-- Replace the old single-column uniqueness with the composite key that
-- actually reflects "one mark set per student, per subject, per term,
-- per year" — this is what makes term-switching DB-enforced rather than
-- convention-enforced. record_key itself stays UNIQUE too (it's derived
-- 1:1 from the same four columns, so this is a redundant-but-harmless
-- extra guard, and keeps existing lookups by record_key working as-is).
DO $$
BEGIN
  ALTER TABLE scores ADD CONSTRAINT scores_student_subject_term_year_key
    UNIQUE (student_id, subject, term, year);
EXCEPTION
  WHEN duplicate_table THEN NULL; -- constraint already exists, re-run is a no-op
END $$;

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
  term         TEXT,                        -- which term this date fell in, for term-scoped views
  year         INTEGER,
  status       TEXT NOT NULL DEFAULT 'Present',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- MIGRATION: tag attendance with term/year too.
-- Unlike `scores`, attendance was never at overwrite risk (each date is
-- already its own row, so record_key = "${date}_${studentId}" can't
-- collide across terms). This just adds term/year so "show me Term 1's
-- attendance" can be a plain WHERE clause instead of the caller having
-- to know Term 1's exact date range. Existing rows are backfilled with
-- term_settings' current value, same best-effort reasoning as scores —
-- new rows going forward are tagged accurately by the route itself.
-- Idempotent / safe to re-run.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS term TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS year INTEGER;

DO $$
DECLARE
  fallback_term TEXT;
  fallback_year INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM attendance WHERE term IS NULL) THEN
    SELECT ts.term, ts.year INTO fallback_term, fallback_year
      FROM term_settings ts WHERE ts.id = 1;
    IF fallback_term IS NULL THEN
      fallback_term := 'Term 1';
      fallback_year := EXTRACT(YEAR FROM now())::INTEGER;
    END IF;
    UPDATE attendance SET term = fallback_term, year = fallback_year WHERE term IS NULL;
  END IF;
END $$;

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

-- -------------------------------------------------------------
-- notices — Administrative Notice Board / school bulletin shown
-- on the Dashboard widget. Previously this list lived only in the
-- browser's localStorage (see script.js), which meant deletes
-- didn't survive a reload (an empty array fell back to hardcoded
-- demo notices) and never synced across devices/users. Now the
-- backend is the single source of truth: posting/deleting a
-- notice goes through routes/notices.routes.js and this table.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notices (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  message      TEXT NOT NULL,
  author       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- report_card_remarks — Class Teacher's / Headteacher's comment
-- fields shown on the report card footer, one row per
-- (student, term, year). Previously these lived ONLY in each
-- browser's localStorage (see script.js's old reportRemarksStorage),
-- which meant a comment typed on one phone/device was invisible
-- everywhere else. Now the backend is the single source of truth.
--
-- Deliberately its OWN table rather than columns on `scores`:
-- a comment is per (student, term, year), not per subject, and
-- `scores` has no term/year column at all (one row per
-- subject+student, overwritten term to term) — putting the
-- comment there would mean picking one arbitrary subject row to
-- carry it, and losing it the moment that subject is unlinked via
-- DELETE /api/scores/:recordKey. This table survives subject
-- changes and keeps every term's comment distinct.
--
-- record_key mirrors the frontend's existing localStorage key
-- exactly: `${studentId}_${term}_${year}` — same convention as
-- scores.record_key / attendance.record_key.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_card_remarks (
  id                     SERIAL PRIMARY KEY,
  record_key             TEXT NOT NULL UNIQUE,
  student_id             TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  year                   INTEGER NOT NULL,
  class_teacher_comment  TEXT,
  headteacher_comment    TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scores_student      ON scores(student_id);
CREATE INDEX IF NOT EXISTS idx_scores_subject      ON scores(subject);
CREATE INDEX IF NOT EXISTS idx_scores_class        ON scores(class_level);
CREATE INDEX IF NOT EXISTS idx_scores_term_year    ON scores(term, year);
CREATE INDEX IF NOT EXISTS idx_attendance_date     ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_attendance_student  ON attendance(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_class    ON attendance(class_level);
CREATE INDEX IF NOT EXISTS idx_attendance_term_year ON attendance(term, year);
CREATE INDEX IF NOT EXISTS idx_students_class      ON students(class);
CREATE INDEX IF NOT EXISTS idx_users_student       ON users(student_id);
CREATE INDEX IF NOT EXISTS idx_users_teacher       ON users(teacher_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notices_created       ON notices(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_remarks_student ON report_card_remarks(student_id);
