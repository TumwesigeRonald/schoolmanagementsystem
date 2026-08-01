/* =========================================================
   API.JS — Backend Integration Layer
   -----------------------------------------------------------
   This file is the ONLY place that talks to the network. Every
   other script (script.js) calls the functions exported here
   instead of touching fetch() or localStorage directly. That
   keeps the UI code backend-agnostic and means wiring up the
   real Node.js/Express API later is a matter of pointing
   API_CONFIG.BASE_URL at the server — no UI code changes.

   CURRENT BEHAVIOUR (no backend deployed yet):
   Every apiRequest() call is attempted against BASE_URL first.
   If the request fails (network error, 404, backend not yet
   built) it transparently falls back to an in-memory/localStorage
   store so the app keeps working for demos, QA and offline use.
   Once the real API is live, responses will simply be used and
   the fallback path stops being exercised — no code changes
   required on this file or in script.js.
   ========================================================= */

/* ---------------------------------------------------------
   1. CONFIGURATION
   --------------------------------------------------------- */
const API_CONFIG = {
    // TODO (backend team): point this at the deployed Node.js API.
    //
    // IMPORTANT — two common local dev setups need different values here:
    //
    // 1) Express serves BOTH the frontend files and the /api routes
    //    (e.g. app.use(express.static('public')) in the same server
    //    that has app.post('/api/auth/login', ...)). In that case a
    //    relative path like "/api" is correct, because the page and
    //    the API share the same origin/port.
    //
    // 2) The frontend is opened with a separate static dev server —
    //    e.g. the VS Code "Live Server" extension (usually
    //    http://127.0.0.1:5500) — while Express runs on its own port
    //    (e.g. http://localhost:5000). These are two different
    //    origins, so a relative "/api" resolves against the Live
    //    Server origin (which has no /api route and will reply with
    //    404/405, not run your Express code). Point BASE_URL at the
    //    Express server explicitly instead, e.g.:
    //        BASE_URL: "http://localhost:5000/api"
    //    and make sure the backend has CORS enabled (see server
    //    example in the project README) so the browser allows it.
    BASE_URL: "https://lcs-backend.vercel.app/api",
    TIMEOUT_MS: 12000,
    TOKEN_STORAGE_KEY: "lcs_auth_token",
    USER_STORAGE_KEY: "lcs_auth_user"
};

// Full REST surface the frontend expects from the backend.
// Keeping this centralised means every endpoint the backend
// needs to implement is documented in one place.
const ENDPOINTS = {
    // --- Auth ---
    LOGIN: "/auth/login",
    LOGOUT: "/auth/logout",
    ME: "/auth/me",
    CHANGE_PASSWORD: "/auth/change-password",

    // --- Students ---
    STUDENTS: "/students",
    STUDENT_BY_ID: (id) => `/students/${encodeURIComponent(id)}`,

    // --- Teachers / Users ---
    TEACHERS: "/teachers",
    TEACHER_BY_ID: (id) => `/teachers/${encodeURIComponent(id)}`,
    TEACHER_RESET_PASSWORD: (id) => `/teachers/${encodeURIComponent(id)}/reset-password`,

    // --- Scores / Marks ---
    SCORES: "/scores",
    SCORES_BY_CLASS_SUBJECT: (cls, subject) => `/scores?class=${encodeURIComponent(cls)}&subject=${encodeURIComponent(subject)}`,

    // --- Attendance ---
    ATTENDANCE: "/attendance",
    ATTENDANCE_BY_CLASS_DATE: (cls, date) => `/attendance?class=${encodeURIComponent(cls)}&date=${encodeURIComponent(date)}`,
    ATTENDANCE_SINCE: (sinceDate) => `/attendance?since=${encodeURIComponent(sinceDate)}`,
    ATTENDANCE_BY_STUDENT: (studentId) => `/attendance?studentId=${encodeURIComponent(studentId)}`,

    // --- Resources ---
    RESOURCES: "/resources",
    RESOURCE_BY_ID: (id) => `/resources/${encodeURIComponent(id)}`,
    RESOURCE_UPLOAD: "/resources/upload",

    // --- Term / academic calendar settings ---
    TERM_SETTINGS: "/settings/term",

    // --- Report cards (optional server-side PDF generation) ---
    REPORT_CARD: (studentId) => `/reports/${encodeURIComponent(studentId)}`
};

/* ---------------------------------------------------------
   2. TOKEN / SESSION STORAGE
   --------------------------------------------------------- */
// NOTE: sessionStorage (not localStorage) is used deliberately here so that
// the auth token/user are wiped automatically when the browser tab/window
// is closed, requiring a fresh login next time — sessionStorage is scoped
// per-tab and cleared by the browser on a clean exit, unlike localStorage
// which persists indefinitely.
const TokenStore = {
    get() {
        try { return sessionStorage.getItem(API_CONFIG.TOKEN_STORAGE_KEY); }
        catch (e) { return null; }
    },
    set(token) {
        try { sessionStorage.setItem(API_CONFIG.TOKEN_STORAGE_KEY, token); }
        catch (e) { /* storage unavailable, ignore */ }
    },
    clear() {
        try {
            sessionStorage.removeItem(API_CONFIG.TOKEN_STORAGE_KEY);
            sessionStorage.removeItem(API_CONFIG.USER_STORAGE_KEY);
        } catch (e) { /* ignore */ }
    },
    getUser() {
        try {
            const raw = sessionStorage.getItem(API_CONFIG.USER_STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    },
    setUser(user) {
        try { sessionStorage.setItem(API_CONFIG.USER_STORAGE_KEY, JSON.stringify(user)); }
        catch (e) { /* ignore */ }
    }
};

/* ---------------------------------------------------------
   3. CORE FETCH WRAPPER
   Every real network call funnels through here so auth headers,
   timeouts, and JSON/error handling are handled once, consistently.
   --------------------------------------------------------- */
async function apiRequest(path, { method = "GET", body = null, isFormData = false } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_CONFIG.TIMEOUT_MS);
    const headers = {};
    const token = TokenStore.get();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (!isFormData) headers["Content-Type"] = "application/json";

    try {
        const response = await fetch(`${API_CONFIG.BASE_URL}${path}`, {
            method,
            headers,
            body: body ? (isFormData ? body : JSON.stringify(body)) : null,
            signal: controller.signal
        });
        clearTimeout(timeout);

        let data = null;
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            data = await response.json().catch(() => null);
        }

        if (!response.ok) {
            const message = (data && (data.message || data.error)) || `Request failed with status ${response.status}`;
            const err = new Error(message);
            err.status = response.status;
            err.payload = data;
            // A static/dev file server (VS Code "Live Server", `http-server`,
            // nginx serving only static assets, etc.) has no route for this
            // path and will reject any non-GET method with 404/405, or an
            // Express app will 404 if the route hasn't been registered yet.
            // 501 covers "Not Implemented". None of these mean "the backend
            // rejected your request" — they mean "there is no backend route
            // here yet" — so they should fall back just like a network error,
            // rather than surfacing a raw HTTP status to the user.
            err.isNetworkFailure = [404, 405, 501].includes(response.status) || !contentType.includes("application/json");
            throw err;
        }
        return data;
    } catch (err) {
        clearTimeout(timeout);
        // Network error, timeout, CORS failure, or backend not deployed yet.
        // Callers use isNetworkFailure to decide whether to use local
        // fallback data instead of showing the error to the user.
        if (err.isNetworkFailure === undefined) {
            err.isNetworkFailure = err.name === "AbortError" || err instanceof TypeError;
        }
        if (err.isNetworkFailure) {
            console.warn(`[api.js] "${path}" isn't reachable yet (backend not deployed or route not wired up) — using local fallback data. Server said: ${err.message}`);
        }
        throw err;
    }
}

/* ---------------------------------------------------------
   4. ROLE-BASED ACCESS CONTROL (RBAC)
   Single source of truth for what each role can see and do.
   Enforced here on the frontend for UX (hiding buttons/tabs);
   the backend MUST enforce the same rules server-side on every
   endpoint, since frontend checks can always be bypassed.
   --------------------------------------------------------- */
const ROLES = {
    ADMIN: "Administrator",
    TEACHER: "Teacher",
    STUDENT: "Student"
};

const ROLE_PERMISSIONS = {
    [ROLES.ADMIN]: {
        tabs: ["students", "scores", "reports", "analytics", "attendance", "resources", "teachers"],
        defaultTab: "students",
        canManageStudents: true,
        canManageScores: true,
        canManageAttendance: true,
        canManageResources: true,
        canDeleteAnyResource: true,
        canManageTeachers: true,
        canManageTerm: true,
        canViewAllReports: true
    },
    [ROLES.TEACHER]: {
        tabs: ["students", "scores", "reports", "analytics", "attendance", "resources", "teachers"],
        defaultTab: "students",
        canManageStudents: false,   // view-only: cannot add/delete learners
        canManageScores: true,      // core duty: add/update learner scores
        canManageAttendance: true,  // daily register marking
        canManageResources: true,   // can upload/manage own materials
        canDeleteAnyResource: false,
        canManageTeachers: false,   // can only edit their own profile
        canManageTerm: false,       // calendar/term dates are admin-only
        canViewAllReports: true
    },
    [ROLES.STUDENT]: {
        tabs: ["reports", "resources"],
        defaultTab: "reports",
        canManageStudents: false,
        canManageScores: false,
        canManageAttendance: false,
        canManageResources: false,  // view/download only
        canDeleteAnyResource: false,
        canManageTeachers: false,
        canManageTerm: false,
        canViewAllReports: false    // can only ever see their own report card
    }
};

function getPermissions(role) {
    return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS[ROLES.STUDENT];
}

/* ---------------------------------------------------------
   5. AUTH API
   --------------------------------------------------------- */
const AuthAPI = {
    // Local fallback accounts used only while the Node.js backend
    // isn't deployed yet. Remove FALLBACK_ACCOUNTS entirely once
    // ENDPOINTS.LOGIN is live — real credentials must never live
    // in frontend code.
    FALLBACK_ACCOUNTS: [
        { username: "admin", password: "admin123", role: ROLES.ADMIN, name: "System Administrator" }
    ],

    async login(username, password) {
        try {
            const data = await apiRequest(ENDPOINTS.LOGIN, {
                method: "POST",
                body: { username, password }
            });
            if (data && data.token) {
                TokenStore.set(data.token);
                TokenStore.setUser(data.user);
                return { ok: true, user: data.user };
            }
            return { ok: false, message: "Unexpected response from server." };
        } catch (err) {
            if (!err.isNetworkFailure) {
                return { ok: false, message: err.message || "Invalid username or password." };
            }
            // Backend not reachable yet — fall back to local demo/dev auth
            // so the frontend remains fully testable in isolation.
            return AuthAPI._localLoginFallback(username, password);
        }
    },

    _localLoginFallback(username, password) {
        const admin = AuthAPI.FALLBACK_ACCOUNTS.find(
            a => a.username.toLowerCase() === username.toLowerCase() && a.password === password
        );
        if (admin) {
            const user = { username: admin.username, role: admin.role, name: admin.name };
            TokenStore.set("local-dev-token");
            TokenStore.setUser(user);
            return { ok: true, user };
        }
        const teacher = teachersList.find(
            t => t.username.toLowerCase() === username.toLowerCase() && t.password === password
        );
        if (teacher) {
            const user = { username: teacher.username, role: ROLES.TEACHER, name: teacher.name, teacherId: teacher.id };
            TokenStore.set("local-dev-token");
            TokenStore.setUser(user);
            return { ok: true, user };
        }
        const student = studentsList.find(
            s => s.id.toLowerCase() === username.toLowerCase()
        );
        if (student && password) {
            // Demo mode only: any non-empty password is accepted for a
            // recognised Student ID. Real credential verification must
            // happen on the backend once ENDPOINTS.LOGIN is implemented.
            const user = { username: student.id, role: ROLES.STUDENT, name: student.name, studentId: student.id };
            TokenStore.set("local-dev-token");
            TokenStore.setUser(user);
            return { ok: true, user };
        }
        return { ok: false, message: "Invalid username or password." };
    },

    async logout() {
        try { await apiRequest(ENDPOINTS.LOGOUT, { method: "POST" }); }
        catch (e) { /* best-effort — clear local session regardless */ }
        TokenStore.clear();
    },

    getSession() {
        return TokenStore.getUser();
    }
};

/* ---------------------------------------------------------
   6. GENERIC "REMOTE-FIRST, LOCAL-FALLBACK" CRUD HELPER
   Wraps a REST call; on network failure it runs localFn() instead
   so every module keeps working without the backend deployed.
   --------------------------------------------------------- */
async function remoteFirst(requestFn, localFn) {
    try {
        return await requestFn();
    } catch (err) {
        if (err.isNetworkFailure) return localFn();
        throw err; // real backend error (validation, 401, 403…) should surface to the UI
    }
}

/* ---------------------------------------------------------
   7. STUDENTS DATA-ACCESS LAYER
   --------------------------------------------------------- */
const StudentsAPI = {
    async list() {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.STUDENTS),
            () => studentsList
        );
    },
    async create(student) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.STUDENTS, { method: "POST", body: student }),
            () => { studentsList.push(student); return student; }
        );
    },
    async remove(studentId) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.STUDENT_BY_ID(studentId), { method: "DELETE" }),
            () => { studentsList = studentsList.filter(s => s.id !== studentId); return true; }
        );
    }
};

/* ---------------------------------------------------------
   8. TEACHERS DATA-ACCESS LAYER
   --------------------------------------------------------- */
const TeachersAPI = {
    async list() {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.TEACHERS),
            () => teachersList
        );
    },
    async create(teacher) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.TEACHERS, { method: "POST", body: teacher }),
            () => { teachersList.push(teacher); return teacher; }
        );
    },
    async update(teacherId, updates) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.TEACHER_BY_ID(teacherId), { method: "PUT", body: updates }),
            () => {
                const t = teachersList.find(t => t.id === teacherId);
                if (t) Object.assign(t, updates);
                return t;
            }
        );
    },
    async remove(teacherId) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.TEACHER_BY_ID(teacherId), { method: "DELETE" }),
            () => { teachersList = teachersList.filter(t => t.id !== teacherId); return true; }
        );
    },
    async resetPassword(teacherId, newPassword) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.TEACHER_RESET_PASSWORD(teacherId), { method: "POST", body: { password: newPassword } }),
            () => {
                const t = teachersList.find(t => t.id === teacherId);
                if (t) t.password = newPassword;
                return true;
            }
        );
    }
};

/* ---------------------------------------------------------
   9. SCORES / MARKS DATA-ACCESS LAYER
   --------------------------------------------------------- */
const ScoresAPI = {
    async list() {
        // No local-storage fallback here on purpose: marksStorage already *is*
        // the local store, so there's nothing useful to fall back to — if the
        // backend can't be reached, refreshScoresList() in script.js just
        // leaves the existing in-memory marksStorage untouched.
        return remoteFirst(
            () => apiRequest(ENDPOINTS.SCORES),
            () => null
        );
    },
    async save(recordKey, marksRecord, classLevel) {
        const [subject, studentId] = [recordKey.split("_").slice(0, -1).join("_"), recordKey.split("_").pop()];
        // NOTE: deliberately NOT using remoteFirst's silent local-fallback here.
        // marksStorage lives only in this tab's memory (nothing backs it with
        // localStorage), so a network failure "succeeding" via local fallback
        // would mean the mark quietly vanishes on refresh with zero indication
        // anything was wrong — which is exactly the bug this used to cause.
        // Every failure, network or server-side, must reach the caller.
        try {
            return await apiRequest(ENDPOINTS.SCORES, { method: "POST", body: { subject, studentId, classLevel, ...marksRecord } });
        } catch (err) {
            marksStorage[recordKey] = marksRecord; // keep it visible in this tab, but the caller must be told it isn't actually persisted
            throw err;
        }
    }
};

/* ---------------------------------------------------------
   10. ATTENDANCE DATA-ACCESS LAYER
   --------------------------------------------------------- */
const AttendanceAPI = {
    async list() {
        // No local-storage fallback here on purpose, same reasoning as
        // ScoresAPI.list(): attendanceStorage already *is* the local store,
        // so refreshAttendanceList() in script.js just leaves it untouched
        // if the backend can't be reached.
        return remoteFirst(
            () => apiRequest(ENDPOINTS.ATTENDANCE),
            () => null
        );
    },
    // Bounded to a recent rolling window (default ~6 months) instead of the
    // entire attendance history — every day is a new row, so at 300+
    // students this table only grows; the day-to-day register never needs
    // to look further back than this. Used for the login-time hydration.
    async listRecent(sinceDate) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.ATTENDANCE_SINCE(sinceDate)),
            () => null
        );
    },
    // One student's full history — used only when actually computing that
    // student's report-card attendance summary, so we pull just their rows
    // instead of everyone's.
    async listForStudent(studentId) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.ATTENDANCE_BY_STUDENT(studentId)),
            () => null
        );
    },
    async setStatus(date, studentId, status) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.ATTENDANCE, { method: "POST", body: { date, studentId, status } }),
            () => { attendanceStorage[`${date}_${studentId}`] = status; return status; }
        );
    },
    async saveRegistry(date, classLevel) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.ATTENDANCE, {
                method: "PUT",
                body: { date, classLevel, records: attendanceStorage }
            }),
            () => true
        );
    }
};

/* ---------------------------------------------------------
   11. RESOURCES DATA-ACCESS LAYER
   --------------------------------------------------------- */
const ResourcesAPI = {
    async list() {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.RESOURCES),
            () => resourcesList
        );
    },
    async upload(formData) {
        // formData is a real FormData instance carrying the file + metadata,
        // ready for multer (or similar) on the Node.js side.
        return remoteFirst(
            () => apiRequest(ENDPOINTS.RESOURCE_UPLOAD, { method: "POST", body: formData, isFormData: true }),
            () => null // caller keeps its own local FileReader fallback
        );
    },
    async remove(resourceId) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.RESOURCE_BY_ID(resourceId), { method: "DELETE" }),
            () => { resourcesList = resourcesList.filter(r => r.id !== resourceId); return true; }
        );
    }
};

/* ---------------------------------------------------------
   12. TERM / ACADEMIC CALENDAR SETTINGS
   --------------------------------------------------------- */
const TermAPI = {
    async get() {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.TERM_SETTINGS),
            () => termSettings
        );
    },
    async save(settings) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.TERM_SETTINGS, { method: "PUT", body: settings }),
            () => { Object.assign(termSettings, settings); return termSettings; }
        );
    }
};
