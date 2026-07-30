# Luweero Community SS Portal — Backend API

Node.js + Express + PostgreSQL backend for the Portal Dashboard frontend
(`index.html` / `api.js` / `script.js`). Built to be deployed free on
**Vercel** with a **Neon** Postgres database, matching every endpoint your
`api.js` already expects — no frontend changes needed beyond one config line.

## 1. Folder structure

```
lcs-backend/
├── api/
│   └── index.js          # Vercel serverless entry (exports the Express app)
├── middleware/
│   ├── auth.js            # JWT verification + role guards
│   └── asyncHandler.js    # try/catch wrapper for async routes
├── migrations/
│   └── schema.sql         # full DB schema (idempotent, safe to re-run)
├── routes/
│   ├── auth.routes.js
│   ├── students.routes.js
│   ├── teachers.routes.js
│   ├── scores.routes.js
│   ├── attendance.routes.js
│   ├── term.routes.js
│   └── resources.routes.js
├── scripts/
│   ├── migrate.js          # applies migrations/schema.sql
│   └── seed.js             # inserts default admin/teacher/student logins
├── app.js                  # Express app (routes + middleware, no listen())
├── server.js               # local dev entry point (`npm start`)
├── db.js                    # pg Pool, Neon-ready
├── package.json
├── vercel.json
└── .env.example
```

## 2. Set up the Neon database (5 minutes)

1. In your Neon dashboard, open (or create) a project and a database —
   e.g. `lcs_portal`.
2. Go to **Connection Details** and copy the **pooled** connection string
   (the one with `-pooler` in the hostname). Use this, not the direct one —
   Vercel functions open a new connection per invocation, and the free tier's
   direct-connection limit is small; Neon's pooler absorbs that.
3. Paste it into `.env` (copy from `.env.example` first) as `DATABASE_URL`.

Then, from your machine (with `DATABASE_URL` set locally so migrate/seed can
reach Neon over the internet):

```bash
npm install
npm run migrate   # creates all tables from migrations/schema.sql
npm run seed       # inserts default admin/teacher/student logins
```

Default logins after seeding (**change all of these before going live**):

| Role  | Username | Password  |
|-------|----------|-----------|
| Admin | `admin`  | `admin123` |
| Teacher | `gnamuli` | `teach123` |
| Teacher | `pokello` | `teach123` |
| Student | `LCS/001` (etc.) | same as the ID, e.g. `LCS/001` |

## 3. Deploy to Vercel

```bash
npm i -g vercel      # if you don't have it
cd lcs-backend
vercel               # first deploy — follow the prompts
vercel --prod        # promote to production
```

In the Vercel dashboard, under **Project Settings → Environment Variables**,
add (for both Preview and Production):

- `DATABASE_URL` — the Neon pooled connection string
- `JWT_SECRET` — generate one with:
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `JWT_EXPIRES_IN` — e.g. `12h`
- `CORS_ORIGIN` — the exact origin your frontend is served from, e.g.
  `https://your-frontend.vercel.app` (comma-separate multiple origins if
  needed; avoid `*` once this is public)

Redeploy after adding env vars (`vercel --prod`) so the function picks them up.

## 4. Point the frontend at it

In `api.js`, change:

```js
BASE_URL: "/api",
```

to your deployed backend's URL, e.g.:

```js
BASE_URL: "https://lcs-backend.vercel.app/api",
```

That's the only frontend change required — `remoteFirst()` in `api.js`
already tries the real API first and only falls back to local storage on a
genuine network/404 failure, so once this points at a live backend, every
`StudentsAPI` / `ScoresAPI` / `AttendanceAPI` / `TermAPI` call starts hitting
Postgres automatically.

If your frontend is served from a different origin than the API (e.g.
GitHub Pages, Netlify, or opened via a local static server), double-check
`CORS_ORIGIN` on the backend matches that origin exactly, or the browser
will block the requests.

## 5. Local development

```bash
cp .env.example .env   # fill in DATABASE_URL and JWT_SECRET
npm install
npm run migrate
npm run seed
npm run dev             # http://localhost:5000, auto-restarts on file changes
```

Serve `index.html` with any static server (e.g. VS Code Live Server) and set
`API_CONFIG.BASE_URL` in `api.js` to `http://localhost:5000/api` for local
testing — see the comment already in that file explaining the two setups.

## 6. API reference

All routes are prefixed with `/api`. Protected routes require
`Authorization: Bearer <token>` (the token returned by `/auth/login`).

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/login` | — | `{ username, password }` → `{ token, user }` |
| POST | `/auth/logout` | — | stateless no-op (client discards token) |
| GET | `/auth/me` | any | returns the decoded token payload |
| POST | `/auth/change-password` | any | `{ currentPassword, newPassword }` |
| GET | `/students` | any | Admin/Teacher: all; Student: only self |
| POST | `/students` | Admin | creates student **and** their login |
| DELETE | `/students/:id` | Admin | cascades to login, scores, attendance |
| GET | `/teachers` | Admin, Teacher | |
| POST | `/teachers` | Admin | creates teacher **and** their login |
| PUT | `/teachers/:id` | Admin, or self | teacher can edit only their own row |
| DELETE | `/teachers/:id` | Admin | |
| POST | `/teachers/:id/reset-password` | Admin | |
| GET | `/scores?class=&subject=` | any | Student is forced to their own ID |
| POST | `/scores` | Admin, Teacher | upsert by `subject_studentId` |
| GET | `/attendance?class=&date=` | any | Student is forced to their own ID |
| POST | `/attendance` | Admin, Teacher | set one student's status |
| PUT | `/attendance` | Admin, Teacher | bulk-save a day's register |
| GET | `/settings/term` | any | |
| PUT | `/settings/term` | Admin | |
| GET | `/resources` | any | |
| POST | `/resources/upload` | Admin, Teacher | multipart `file` + `title` |
| DELETE | `/resources/:id` | Admin, or uploader | |

## 7. Design notes / deviations from the original spec

A couple of deliberate choices worth flagging:

- **Passwords live only in `users`, not duplicated in `teachers`.** Your
  spec listed a `password` column on `teachers` too, but keeping a single
  password per teacher (in `users`, linked by `teacher_id`) avoids two
  copies of a credential silently drifting out of sync. `teachers.username`
  is kept for display/reference and is synced automatically when changed
  via `PUT /teachers/:id`.
- **`scores` holds both O-Level and A-Level fields in one table** (`ao1`,
  `ao2`, `eot` alongside `p1`, `p2`) rather than two schemas, mirroring how
  `marksStorage[recordKey]` already works on the frontend — a given
  deployment only ever populates one set.
- **Resources are stored as base64 in Postgres**, capped at 4MB per file.
  Fine for a handful of PDFs/docs; if you start hosting larger files,
  swap `file_data` for a URL into Supabase Storage/Cloudinary/S3 instead —
  the route only needs a one-line change to do that.
- **CORS defaults to `*`** in `.env.example` for easy first deploy — lock
  this down to your actual frontend origin before going live.

## 8. Security checklist before going live

- [ ] Set a strong, random `JWT_SECRET` (never the example value)
- [ ] Change the default admin/teacher/student passwords from `npm run seed`
- [ ] Set `CORS_ORIGIN` to your exact frontend origin (not `*`)
- [ ] Confirm `DATABASE_URL` uses `sslmode=require` (Neon's default)
- [ ] Consider rate-limiting `/auth/login` if this becomes internet-facing
      (e.g. `express-rate-limit`) to slow down credential-guessing attempts
