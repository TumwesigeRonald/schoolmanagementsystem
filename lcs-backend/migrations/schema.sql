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

-- "Bursar" — new role added for the School Finance feature. Can record
-- fee payments and set fee structures (Teachers get view-only access to
-- the same data; see FINANCE_ROLES / EDIT_ROLES in the finance routes).
-- ADD VALUE IF NOT EXISTS is its own idempotent form (no DO/EXCEPTION
-- wrapper needed) and is safe outside a transaction on PG 12+.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Bursar';

-- "Human Resource" and "Director" — multi-tier Finance roles (see
-- routes/admin-staff.routes.js, finance.routes.js, payroll.routes.js,
-- finance-auth.routes.js). Both get the same School Finance (fees)
-- access as Bursar, PLUS Staff Payroll access that Bursar is
-- deliberately excluded from — see EDIT_ROLES in payroll.routes.js.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Human Resource';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Director';

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

-- -------------------------------------------------------------
-- School Finance access gate — a second, independent password
-- (bcrypt-hashed, per-user) that Admin/Teacher accounts must enter
-- to unlock the "School Finance" section, on top of their normal
-- login. NULL means the user hasn't set one yet (see
-- routes/finance-auth.routes.js). Safe to re-run against a
-- database created before this column existed.
-- -------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_password_hash TEXT;

-- -------------------------------------------------------------
-- School Finance data — fee billing, payments, balances.
-- fee_structures: the expected fee amount per class/term/year, set
--   by Admin/Bursar. Billed amount for a student = whatever row
--   matches their class + the term/year being viewed.
-- fee_payments: one row per individual payment received. A
--   student's balance = billed amount − SUM(their payments).
-- Both tables sit behind requireFinanceScope (the same Finance-
-- password gate as finance-auth.routes.js) on every route in
-- routes/finance.routes.js, on top of the normal login.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_structures (
  id          SERIAL PRIMARY KEY,
  class       TEXT NOT NULL,
  term        TEXT NOT NULL,
  year        INTEGER NOT NULL,
  amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (class, term, year)
);

CREATE TABLE IF NOT EXISTS fee_payments (
  id            SERIAL PRIMARY KEY,
  student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  term          TEXT NOT NULL,
  year          INTEGER NOT NULL,
  amount        NUMERIC(12,2) NOT NULL,
  method        TEXT,
  reference     TEXT,
  note          TEXT,
  recorded_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- student_fee_overrides: per-student expected fee for a term/year,
-- taking priority over that student's class-wide fee_structures row
-- (e.g. a scholarship, sibling discount, or an extra one-off charge).
-- No row here for a student = they're billed the normal class amount.
CREATE TABLE IF NOT EXISTS student_fee_overrides (
  id          SERIAL PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  term        TEXT NOT NULL,
  year        INTEGER NOT NULL,
  amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  reason      TEXT,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, term, year)
);
CREATE INDEX IF NOT EXISTS idx_fee_overrides_term_year ON student_fee_overrides(term, year);

CREATE INDEX IF NOT EXISTS idx_fee_structures_term_year ON fee_structures(term, year);
CREATE INDEX IF NOT EXISTS idx_fee_payments_student     ON fee_payments(student_id, term, year);
CREATE INDEX IF NOT EXISTS idx_fee_payments_term_year   ON fee_payments(term, year);

-- -------------------------------------------------------------
-- Expenses & (non-fee) Revenues — the other two sides of the school's
-- money, alongside student fee collections above. Both are dated
-- (calendar date, not term/year) so they can be charted month-by-month
-- on the "Finance Flow" chart regardless of which term is being viewed
-- elsewhere. category is free text (the frontend offers a suggestions
-- list of common categories via <datalist>, but doesn't restrict input,
-- same pattern as fee_payments.method). Behind the same Finance-password
-- gate + EDIT_ROLES (Admin/Bursar) as everything else in finance.routes.js.
-- "revenues" here means income OTHER than student fees (donations,
-- grants, rent, fundraising) — student fee income is already tracked
-- in fee_payments and both are combined for the Finance Flow chart.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id            SERIAL PRIMARY KEY,
  category      TEXT NOT NULL,
  amount        NUMERIC(12,2) NOT NULL,
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  note          TEXT,
  recorded_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);

CREATE TABLE IF NOT EXISTS revenues (
  id            SERIAL PRIMARY KEY,
  category      TEXT NOT NULL,
  amount        NUMERIC(12,2) NOT NULL,
  revenue_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  note          TEXT,
  recorded_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_revenues_date ON revenues(revenue_date);

-- -------------------------------------------------------------
-- Staff Payroll, Allowances & Salary Advances
-- Mounted at /api/finance/payroll (routes/payroll.routes.js), behind the
-- same Finance-password gate as the rest of finance.routes.js, but with
-- NO view-only tier — every route there is Admin + Bursar only.
-- -------------------------------------------------------------

-- staff_profiles — one row per staff member on payroll (teaching or
-- non-teaching). Deliberately separate from `teachers`: not every staff
-- member on payroll has a teaching/login account, and salary data has no
-- reason to live next to the lesson-planning/scores side of the system.
CREATE TABLE IF NOT EXISTS staff_profiles (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  role_type       TEXT NOT NULL CHECK (role_type IN ('teaching', 'non-teaching')),
  base_salary     NUMERIC(12,2) NOT NULL CHECK (base_salary >= 0),
  phone           TEXT,
  payment_details JSONB NOT NULL DEFAULT '{}'::jsonb,  -- bank/mobile-money details; shape is frontend's to define
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_profiles_status ON staff_profiles(status);

-- allowances — recurring allowances apply to every payroll run until
-- removed; one-time allowances apply once, then applied_payroll_id is
-- stamped by the run that consumed them so they're never paid twice and
-- stay part of that run's audit trail (see DELETE /allowances/:id).
CREATE TABLE IF NOT EXISTS allowances (
  id                 SERIAL PRIMARY KEY,
  staff_id           INTEGER NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  type               TEXT NOT NULL CHECK (type IN ('recurring', 'one-time')),
  date_added         DATE NOT NULL DEFAULT CURRENT_DATE,
  applied_payroll_id INTEGER,  -- FK added below, after payroll_records exists
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_allowances_staff ON allowances(staff_id);

-- salary_advances — issuing (not just requesting) immediately creates the
-- tracking balance and sets status = 'active', so the next payroll run(s)
-- start deducting repayment_amount_per_month until balance_remaining hits
-- 0, at which point a run flips status to 'cleared'. There's no separate
-- 'pending' approval step enforced here — see routes/payroll.routes.js.
CREATE TABLE IF NOT EXISTS salary_advances (
  id                         SERIAL PRIMARY KEY,
  staff_id                   INTEGER NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  requested_amount           NUMERIC(12,2) NOT NULL CHECK (requested_amount > 0),
  repayment_amount_per_month NUMERIC(12,2) NOT NULL CHECK (repayment_amount_per_month > 0),
  balance_remaining          NUMERIC(12,2) NOT NULL CHECK (balance_remaining >= 0),
  status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'cleared')),
  request_date               DATE NOT NULL DEFAULT CURRENT_DATE,
  issued_by                  TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_salary_advances_staff ON salary_advances(staff_id);
CREATE INDEX IF NOT EXISTS idx_salary_advances_status ON salary_advances(status);

-- payroll_records — one row per staff member per month/year, produced by
-- POST /api/finance/payroll/generate. UNIQUE(staff_id, month, year) is the
-- real idempotency guard (the route's dupe-check query is just there for a
-- friendly message instead of a raw 23505). expense_id/paid_by/paid_at are
-- filled in by the "Financial Integration" step: marking a record "paid"
-- writes a matching entry to `expenses` and stamps the link back here.
CREATE TABLE IF NOT EXISTS payroll_records (
  id                SERIAL PRIMARY KEY,
  staff_id          INTEGER NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  month             INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year              INTEGER NOT NULL,
  base_salary       NUMERIC(12,2) NOT NULL,
  total_allowances  NUMERIC(12,2) NOT NULL DEFAULT 0,
  advance_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_pay           NUMERIC(12,2) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  generated_by      TEXT,
  paid_by           TEXT,
  paid_at           TIMESTAMPTZ,
  expense_id        INTEGER REFERENCES expenses(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (staff_id, month, year)
);
CREATE INDEX IF NOT EXISTS idx_payroll_records_month_year ON payroll_records(month, year);
CREATE INDEX IF NOT EXISTS idx_payroll_records_staff ON payroll_records(staff_id);

-- Deferred FK: allowances.applied_payroll_id -> payroll_records.id.
-- Added after payroll_records exists (it's forward-referenced above).
DO $$
BEGIN
  ALTER TABLE allowances
    ADD CONSTRAINT allowances_applied_payroll_id_fkey
    FOREIGN KEY (applied_payroll_id) REFERENCES payroll_records(id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- staff_salary_history — one row per base_salary change (single edits via
-- PUT /staff/:id, and every row touched by POST /staff/bulk-salary-update).
-- Append-only audit trail: nothing here is ever updated or deleted, and a
-- change is only ever recorded when old_salary actually differs from
-- new_salary, so re-saving a profile with an unchanged salary logs nothing.
CREATE TABLE IF NOT EXISTS staff_salary_history (
  id         SERIAL PRIMARY KEY,
  staff_id   INTEGER NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  old_salary NUMERIC(12,2) NOT NULL,
  new_salary NUMERIC(12,2) NOT NULL,
  changed_by TEXT NOT NULL,
  reason     TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_salary_history_staff ON staff_salary_history(staff_id);

-- -------------------------------------------------------------
-- Part-Time Weekly Payroll — a SEPARATE track from payroll_records
-- above, by design. Full-Time staff are paid monthly, processed and
-- disbursed by Administrator/Human Resource/Director only
-- (payroll.routes.js, PAYROLL_EDIT_ROLES — completely unchanged by
-- this addition). Part-Time staff are paid weekly and collect/sign for
-- their pay directly at the Bursar's office, with no HR/Director
-- approval step — see routes/part-time-payroll.routes.js.
--
-- employment_type is the field that decides which track a staff member
-- is on. Defaulted to 'full-time' so every existing staff_profiles row
-- keeps behaving exactly as it did before this column existed.
--
-- part_time_payroll_records is intentionally its own table rather than
-- a `frequency` column on payroll_records: it has no allowances/salary-
-- advance deduction logic (those stay full-time-only concepts) and its
-- `amount` is entered fresh each week (hours worked vary for part-time
-- staff) rather than derived from a fixed base_salary.
-- -------------------------------------------------------------
ALTER TABLE staff_profiles
  ADD COLUMN IF NOT EXISTS employment_type TEXT NOT NULL DEFAULT 'full-time'
    CHECK (employment_type IN ('full-time', 'part-time'));
CREATE INDEX IF NOT EXISTS idx_staff_profiles_employment_type ON staff_profiles(employment_type);

CREATE TABLE IF NOT EXISTS part_time_payroll_records (
  id               SERIAL PRIMARY KEY,
  staff_id         INTEGER NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  week_start_date  DATE NOT NULL,
  amount           NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  note             TEXT,
  recorded_by      TEXT,
  paid_by          TEXT,
  paid_at          TIMESTAMPTZ,
  expense_id       INTEGER REFERENCES expenses(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (staff_id, week_start_date)
);
CREATE INDEX IF NOT EXISTS idx_part_time_payroll_week ON part_time_payroll_records(week_start_date);
CREATE INDEX IF NOT EXISTS idx_part_time_payroll_staff ON part_time_payroll_records(staff_id);

-- =============================================================
-- MIGRATION: performance indexes (composite/partial), added after
-- the original schema — see routes/scores.routes.js, attendance
-- queries, and routes/payroll.routes.js's POST /generate for the
-- exact WHERE clauses these were sized for.
-- NOTE: this was originally handed out as a standalone
-- 002_add_performance_indexes.sql file, but scripts/migrate.js only
-- ever reads THIS file (migrations/schema.sql) — a separate file was
-- never actually wired up to run. Moved in here so `npm run migrate`
-- actually applies it. Idempotent / safe to re-run, same as
-- everything else in this file.
-- =============================================================
CREATE INDEX IF NOT EXISTS idx_scores_student_term_year
  ON scores (student_id, term, year);
CREATE INDEX IF NOT EXISTS idx_scores_term_year_class_subject
  ON scores (term, year, class_level, subject);
CREATE INDEX IF NOT EXISTS idx_attendance_student_term_year
  ON attendance (student_id, term, year);
CREATE INDEX IF NOT EXISTS idx_attendance_term_year_class
  ON attendance (term, year, class_level);
CREATE INDEX IF NOT EXISTS idx_allowances_staff_type
  ON allowances (staff_id, type);
CREATE INDEX IF NOT EXISTS idx_allowances_onetime_unapplied
  ON allowances (staff_id)
  WHERE type = 'one-time' AND applied_payroll_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_salary_advances_staff_active
  ON salary_advances (staff_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_report_remarks_term_year
  ON report_card_remarks (term, year);

-- =============================================================
-- MIGRATION: clear any Finance password already set on Teacher
-- accounts. Teachers can no longer set OR verify a Finance password
-- at all (see FINANCE_ROLES in routes/finance-auth.routes.js) — the
-- gate rejects them before the handler even runs, so a leftover hash
-- here is inert either way, but there's no reason to keep it sitting
-- in the database once the role can never use it again. Naturally
-- idempotent: after the first run no Teacher row has a non-null
-- finance_password_hash left to clear, so re-running this is a no-op.
-- =============================================================
UPDATE users SET finance_password_hash = NULL
  WHERE role = 'Teacher' AND finance_password_hash IS NOT NULL;
