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
    USER_STORAGE_KEY: "lcs_auth_user",
    // Separate from the main login token — this is only ever sent to
    // /api/finance-auth/* and (later) whatever real Finance data routes
    // get built, never to the regular endpoints above.
    FINANCE_TOKEN_STORAGE_KEY: "lcs_finance_token"
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
    // term/year are appended (when provided) by SCORES_QUERY / ScoresAPI
    // below rather than baked into these builders, so every scores read
    // is explicitly scoped to the term the caller is looking at instead
    // of silently falling back to "whatever the server thinks is current".
    SCORES: "/scores",
    SCORES_QUERY: (params = {}) => {
        const qs = new URLSearchParams();
        if (params.class) qs.set('class', params.class);
        if (params.subject) qs.set('subject', params.subject);
        if (params.term) qs.set('term', params.term);
        if (params.year) qs.set('year', params.year);
        const s = qs.toString();
        return s ? `/scores?${s}` : '/scores';
    },
    SCORE_BY_RECORD_KEY: (recordKey) => `/scores/${encodeURIComponent(recordKey)}`,
    SCORES_BULK_INITIALS: "/scores/bulk-initials",
    // Student-only: this student's term-by-term average score history,
    // used by the "My Performance Trend" chart on the student dashboard.
    SCORES_TREND: "/scores/trend",

    // --- Attendance ---
    ATTENDANCE: "/attendance",
    ATTENDANCE_BY_CLASS_DATE: (cls, date) => `/attendance?class=${encodeURIComponent(cls)}&date=${encodeURIComponent(date)}`,
    ATTENDANCE_SINCE: (sinceDate) => `/attendance?since=${encodeURIComponent(sinceDate)}`,
    ATTENDANCE_BY_STUDENT: (studentId) => `/attendance?studentId=${encodeURIComponent(studentId)}`,
    ATTENDANCE_BY_TERM: (term, year) => `/attendance?term=${encodeURIComponent(term)}&year=${encodeURIComponent(year)}`,

    // --- Resources ---
    RESOURCES: "/resources",
    RESOURCE_BY_ID: (id) => `/resources/${encodeURIComponent(id)}`,
    RESOURCE_UPLOAD: "/resources/upload",

    // --- Term / academic calendar settings ---
    TERM_SETTINGS: "/settings/term",
    TERM_HISTORY: "/settings/term/history",

    // --- Report cards (optional server-side PDF generation) ---
    REPORT_CARD: (studentId) => `/reports/${encodeURIComponent(studentId)}`,

    // --- Admin: login/user activity log ---
    ACTIVITY_LOG: "/activity-log",

    // --- Admin Notice Board / school bulletin ---
    NOTICES: "/notices",

    // --- Report card remarks (Class Teacher's / Headteacher's comments) ---
    REMARKS: "/remarks",
    REMARKS_BY_STUDENT: (studentId) => `/remarks?studentId=${encodeURIComponent(studentId)}`,

    // --- AI Teacher Toolbox (Lesson Plan / Scheme of Work / Activity of
    // Integration & CAI / Record of Work) — see teacher-toolbox.js ---
    AI_GENERATE: "/ai/generate",
    AI_ITEMS: "/ai/items",
    AI_ITEM_BY_ID: (id) => `/ai/items/${encodeURIComponent(id)}`,

    // --- Admin: Bursar/Human Resource/Director account management
    // (Administrator only, separate from the Finance password gate —
    // see routes/admin-staff.routes.js) ---
    ADMIN_STAFF_LIST: "/admin/staff",
    ADMIN_STAFF_CREATE: "/admin/create-staff",
    ADMIN_STAFF_BY_USERNAME: (username) => `/admin/staff/${encodeURIComponent(username)}`,
    ADMIN_STAFF_RESET_PASSWORD: (username) => `/admin/staff/${encodeURIComponent(username)}/reset-password`,

    // --- School Finance access gate (second password, see
    // routes/finance-auth.routes.js on the backend) ---
    FINANCE_AUTH_STATUS: "/finance-auth/status",
    FINANCE_AUTH_VERIFY: "/finance-auth/verify-password",
    FINANCE_AUTH_SET_PASSWORD: "/finance-auth/set-password",
    // --- Finance data (behind the gate above) ---
    FINANCE_FEE_STRUCTURE: "/finance/fee-structure",
    FINANCE_FEE_OVERRIDE: "/finance/fee-override",
    FINANCE_PAYMENTS: "/finance/payments",
    FINANCE_SUMMARY: "/finance/summary",
    FINANCE_EXPENSES: "/finance/expenses",
    FINANCE_REVENUES: "/finance/revenues",
    FINANCE_FLOW: "/finance/finance-flow",

    // --- Staff Payroll, Allowances & Salary Advances (also behind the
    // Finance gate above; Admin + Bursar only, no Teacher access at all —
    // see routes/payroll.routes.js) ---
    PAYROLL_STAFF: "/finance/payroll/staff",
    PAYROLL_STAFF_BY_ID: (id) => `/finance/payroll/staff/${encodeURIComponent(id)}`,
    PAYROLL_ALLOWANCES: (staffId) => `/finance/payroll/staff/${encodeURIComponent(staffId)}/allowances`,
    PAYROLL_ALLOWANCE_BY_ID: (id) => `/finance/payroll/allowances/${encodeURIComponent(id)}`,
    PAYROLL_ADVANCES: (staffId) => `/finance/payroll/staff/${encodeURIComponent(staffId)}/advances`,
    // Lightweight staff picker for Salary Advances (id/name/roleType only —
    // never salary/payment data). Available to Bursar too, unlike every
    // other PAYROLL_* endpoint above/below — see routes/payroll.routes.js.
    PAYROLL_ADVANCE_LOOKUP: "/finance/payroll/advance-lookup",

    // --- Part-Time Weekly Payroll (separate track — see
    // routes/part-time-payroll.routes.js. Bursar has full access here,
    // unlike every PAYROLL_* endpoint above, which is Admin/HR/Director
    // only.) ---
    PART_TIME_PAYROLL_STAFF: "/finance/part-time-payroll/staff",
    PART_TIME_PAYROLL_RECORDS: "/finance/part-time-payroll/records",
    PART_TIME_PAYROLL_RECORD_BY_ID: (id) => `/finance/part-time-payroll/records/${encodeURIComponent(id)}`,
    PART_TIME_PAYROLL_MARK_PAID: (id) => `/finance/part-time-payroll/records/${encodeURIComponent(id)}/mark-paid`,
    PAYROLL_RECORDS: "/finance/payroll/records",
    PAYROLL_GENERATE: "/finance/payroll/generate",
    PAYROLL_MARK_PAID: (recordId) => `/finance/payroll/records/${encodeURIComponent(recordId)}/mark-paid`,
    PAYROLL_BULK_SALARY_UPDATE: "/finance/payroll/staff/bulk-salary-update"
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

// Same sessionStorage-per-tab reasoning as TokenStore above, kept as a
// fully separate key so clearing/expiring the Finance unlock never
// touches the user's actual login session, and vice versa (e.g.
// TokenStore.clear() on logout wipes the login token but a stale
// finance token would otherwise survive — handleLogout() in script.js
// clears this one explicitly too).
const FinanceTokenStore = {
    get() {
        try { return sessionStorage.getItem(API_CONFIG.FINANCE_TOKEN_STORAGE_KEY); }
        catch (e) { return null; }
    },
    set(token) {
        try { sessionStorage.setItem(API_CONFIG.FINANCE_TOKEN_STORAGE_KEY, token); }
        catch (e) { /* storage unavailable, ignore */ }
    },
    clear() {
        try { sessionStorage.removeItem(API_CONFIG.FINANCE_TOKEN_STORAGE_KEY); }
        catch (e) { /* ignore */ }
    },
    has() {
        return !!this.get();
    }
};

/* ---------------------------------------------------------
   3. CORE FETCH WRAPPER
   Every real network call funnels through here so auth headers,
   timeouts, and JSON/error handling are handled once, consistently.
   --------------------------------------------------------- */
async function apiRequest(path, { method = "GET", body = null, isFormData = false, timeoutMs = API_CONFIG.TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {};
    const token = TokenStore.get();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (!isFormData) headers["Content-Type"] = "application/json";
    // Real Finance data routes (never finance-auth itself) additionally
    // need the short-lived Finance-scoped token — see requireFinanceScope
    // in the backend and FinanceTokenStore above.
    if (path.startsWith("/finance/")) {
        const financeToken = FinanceTokenStore.get();
        if (financeToken) headers["x-finance-token"] = financeToken;
    }

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
    STUDENT: "Student",
    BURSAR: "Bursar",
    HR: "Human Resource",
    DIRECTOR: "Director"
};

const ROLE_PERMISSIONS = {
    [ROLES.ADMIN]: {
        // "classsummaries" and "aitoolbox" appended here — tab ids for the
        // Class Score Summaries (class-summaries.js) and AI Teacher Toolbox
        // (teacher-toolbox.js) features. No other id in this array was
        // touched. Without "aitoolbox" here, renderSidebarNav()'s RBAC
        // filter (`allowedTabs.includes(item.id)`) drops the Teacher Toolbox
        // nav item entirely, which is why it never picked up the same
        // active/hover styling as the rest of the menu.
        tabs: ["dashboard", "students", "scores", "reports", "analytics", "performers", "attendance", "resources", "teachers", "subjectmarksstatus", "activitylog", "classsummaries", "aitoolbox", "staffmanagement"],
        defaultTab: "dashboard",
        canManageStudents: true,
        canManageScores: true,
        canManageAttendance: true,
        canManageResources: true,
        canDeleteAnyResource: true,
        canManageTeachers: true,
        canManageTerm: true,
        canViewAllReports: true,
        canSwitchTerm: true,        // can browse a past term/year instead of only the live one
        canManageNotices: true,     // post/delete school bulletin notices
        canPrintWholeClass: true,   // bulk "Print / Save PDF (Whole Class)" report-card export
        canManageStaff: true,        // Administrator-only: create/edit/reset Bursar/HR/Director accounts (staff-management.js)
        canAccessExpensesRevenues: true,
        canAccessSalaryAdvances: true,
        canAccessPartTimePayroll: true
    },
    [ROLES.TEACHER]: {
        // "classsummaries" and "aitoolbox" appended here — same tab ids as above.
        tabs: ["dashboard", "students", "scores", "reports", "analytics", "performers", "attendance", "resources", "teachers", "subjectmarksstatus", "classsummaries", "aitoolbox"],
        defaultTab: "dashboard",
        canManageStudents: false,   // view-only: cannot add/delete learners
        canManageScores: true,      // core duty: add/update learner scores
        canManageAttendance: true,  // daily register marking
        canManageResources: true,   // can upload/manage own materials
        canDeleteAnyResource: false,
        canManageTeachers: false,   // can only edit their own profile
        canManageTerm: false,       // calendar/term dates are admin-only
        canViewAllReports: true,
        canSwitchTerm: true,        // can browse a past term/year instead of only the live one
        canManageNotices: false,    // can read the bulletin, not post to it
        canPrintWholeClass: false,  // whole-class bulk PDF export is Administrator-only
        canManageStaff: false
    },
    [ROLES.BURSAR]: {
        // No academic tabs — Bursar's whole job lives behind the "School
        // Finance" gate (renderFinanceNavItem), which isn't part of this
        // tabs array (same as how Admin/Teacher/HR/Director reach it).
        // Bursar gets the General Finance / Student Fees section of that
        // gated module, and Salary Advances specifically, but NOT the
        // general Payroll tab and NOT Expenses/Revenues at all (view or
        // edit) — see payrollCanAccess()/financeCanViewExpensesRevenues()
        // in finance.js/payroll.js and the matching role lists in
        // payroll.routes.js/finance.routes.js (enforced server-side;
        // these frontend flags just keep the UI honest).
        // gated module, and Salary Advances specifically, but NOT the
        // general Payroll tab and NOT Expenses/Revenues at all (view or
        // edit) — see payrollCanAccess()/financeCanViewExpensesRevenues()
        // in finance.js/payroll.js and the matching role lists in
        // payroll.routes.js/finance.routes.js (enforced server-side;
        // these frontend flags just keep the UI honest).
        tabs: ["dashboard"],
        defaultTab: "dashboard",
        canManageStudents: false,
        canManageScores: false,
        canManageAttendance: false,
        canManageResources: false,
        canDeleteAnyResource: false,
        canManageTeachers: false,
        canManageTerm: false,
        canViewAllReports: false,
        canSwitchTerm: false,
        canManageNotices: false,
        canPrintWholeClass: false,
        canManageStaff: false,
        canAccessPayroll: false,
        canAccessExpensesRevenues: false,
        canAccessSalaryAdvances: true,
        canAccessPartTimePayroll: true
    },
    [ROLES.HR]: {
        // Same shape as Bursar — whole job lives behind the Finance gate
        // — but Human Resource gets full Payroll + Expenses/Revenues
        // access that Bursar does not, on top of the same General
        // Finance access (and Salary Advances, same as Bursar).
        // — but Human Resource gets full Payroll + Expenses/Revenues
        // access that Bursar does not, on top of the same General
        // Finance access (and Salary Advances, same as Bursar).
        tabs: ["dashboard"],
        defaultTab: "dashboard",
        canManageStudents: false,
        canManageScores: false,
        canManageAttendance: false,
        canManageResources: false,
        canDeleteAnyResource: false,
        canManageTeachers: false,
        canManageTerm: false,
        canViewAllReports: false,
        canSwitchTerm: false,
        canManageNotices: false,
        canPrintWholeClass: false,
        canManageStaff: false,
        canAccessPayroll: true,
        canAccessExpensesRevenues: true,
        canAccessSalaryAdvances: true,
        canAccessPartTimePayroll: true
    },
    [ROLES.DIRECTOR]: {
        // Same shape as Human Resource: General Finance + Payroll +
        // Expenses/Revenues + Salary Advances behind the Finance gate,
        // no academic tabs, no staff-account management (that stays
        // Administrator-only).
        tabs: ["dashboard"],
        defaultTab: "dashboard",
        canManageStudents: false,
        canManageScores: false,
        canManageAttendance: false,
        canManageResources: false,
        canDeleteAnyResource: false,
        canManageTeachers: false,
        canManageTerm: false,
        canViewAllReports: false,
        canSwitchTerm: false,
        canManageNotices: false,
        canPrintWholeClass: false,
        canManageStaff: false,
        canAccessPayroll: true,
        canAccessExpensesRevenues: true,
        canAccessSalaryAdvances: true,
        canAccessPartTimePayroll: true
    },
    [ROLES.STUDENT]: {
        tabs: ["dashboard", "reports", "resources"],
        defaultTab: "dashboard",
        canManageStudents: false,
        canManageScores: false,
        canManageAttendance: false,
        canManageResources: false,  // view/download only
        canDeleteAnyResource: false,
        canManageTeachers: false,
        canManageTerm: false,
        canViewAllReports: false,   // can only ever see their own report card
        // Can still browse a past term/year of their OWN dashboard/report
        // card/attendance — the backend already scopes every scores/
        // attendance/remarks read to req.user.studentId regardless of which
        // term/year is requested, so this only changes what the student can
        // *view*, never whose data they can see.
        canSwitchTerm: true,
        canManageNotices: false,
        canPrintWholeClass: false,
        canManageStaff: false,
        canAccessPayroll: false,
        canAccessExpensesRevenues: false,
        canAccessSalaryAdvances: false,
        canAccessPartTimePayroll: false
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
   5b. FINANCE ACCESS GATE
   Deliberately has NO local-fallback path like AuthAPI/remoteFirst
   below — a password gate that silently "succeeds" whenever the
   backend is unreachable would defeat the entire point of it. If
   the backend can't be reached, every method here fails closed
   (ok: false) instead of granting access.
   --------------------------------------------------------- */
const FinanceAuthAPI = {
    // Whether the current user has ever set a Finance password —
    // lets the modal show "create a password" vs "enter password".
    async status() {
        try {
            const data = await apiRequest(ENDPOINTS.FINANCE_AUTH_STATUS);
            return { ok: true, hasPassword: !!(data && data.hasPassword) };
        } catch (err) {
            return { ok: false, message: err.message || "Couldn't reach the server." };
        }
    },

    async verifyPassword(password) {
        try {
            const data = await apiRequest(ENDPOINTS.FINANCE_AUTH_VERIFY, {
                method: "POST",
                body: { password }
            });
            if (data && data.financeToken) {
                FinanceTokenStore.set(data.financeToken);
                return { ok: true };
            }
            return { ok: false, message: "Unexpected response from server." };
        } catch (err) {
            return { ok: false, message: err.message || "Incorrect password.", notSet: err.payload && err.payload.code === 'NOT_SET' };
        }
    },

    async setPassword(newPassword, currentPassword) {
        try {
            await apiRequest(ENDPOINTS.FINANCE_AUTH_SET_PASSWORD, {
                method: "POST",
                body: { newPassword, currentPassword }
            });
            return { ok: true };
        } catch (err) {
            return { ok: false, message: err.message || "Couldn't set the password." };
        }
    },

    isUnlocked() {
        return FinanceTokenStore.has();
    },

    lock() {
        FinanceTokenStore.clear();
    }
};

/* ---------------------------------------------------------
   5c. FINANCE DATA — fee structures, payments/balances, summary.
   Every call here requires an unlocked Finance session
   (FinanceAuthAPI.isUnlocked()) — apiRequest() attaches the token
   automatically for any "/finance/" path. No local-fallback path,
   same reasoning as FinanceAuthAPI: financial data failing closed
   when the backend is unreachable is correct, not a bug.
   --------------------------------------------------------- */
const FinanceAPI = {
    async getFeeStructure(term, year) {
        return apiRequest(`${ENDPOINTS.FINANCE_FEE_STRUCTURE}?term=${encodeURIComponent(term)}&year=${encodeURIComponent(year)}`);
    },

    async setFeeStructure(className, term, year, amount) {
        return apiRequest(ENDPOINTS.FINANCE_FEE_STRUCTURE, {
            method: "PUT",
            body: { class: className, term, year, amount }
        });
    },

    // Per-student override — takes priority over the class's fee for that
    // one student (scholarship, discount, extra charge, etc).
    async setFeeOverride(studentId, term, year, amount, reason) {
        return apiRequest(ENDPOINTS.FINANCE_FEE_OVERRIDE, {
            method: "PUT",
            body: { studentId, term, year, amount, reason }
        });
    },

    async clearFeeOverride(studentId, term, year) {
        const params = new URLSearchParams({ studentId, term, year });
        return apiRequest(`${ENDPOINTS.FINANCE_FEE_OVERRIDE}?${params.toString()}`, { method: "DELETE" });
    },

    // Omit studentId for a class/term list of balances; pass it for one
    // student's balance + full payment history.
    async getPayments({ term, year, class: className, studentId } = {}) {
        const params = new URLSearchParams({ term, year });
        if (studentId) params.set("studentId", studentId);
        else if (className) params.set("class", className);
        return apiRequest(`${ENDPOINTS.FINANCE_PAYMENTS}?${params.toString()}`);
    },

    async recordPayment({ studentId, term, year, amount, method, reference, note }) {
        return apiRequest(ENDPOINTS.FINANCE_PAYMENTS, {
            method: "POST",
            body: { studentId, term, year, amount, method, reference, note }
        });
    },

    async deletePayment(paymentId) {
        return apiRequest(`${ENDPOINTS.FINANCE_PAYMENTS}/${paymentId}`, { method: "DELETE" });
    },

    async getSummary(term, year) {
        return apiRequest(`${ENDPOINTS.FINANCE_SUMMARY}?term=${encodeURIComponent(term)}&year=${encodeURIComponent(year)}`);
    },

    // --- Expenses (money spent — salaries, utilities, maintenance, etc.) ---
    async listExpenses(year, month) {
        const params = new URLSearchParams({ year });
        if (month) params.set("month", month);
        return apiRequest(`${ENDPOINTS.FINANCE_EXPENSES}?${params.toString()}`);
    },
    async addExpense({ category, amount, date, note }) {
        return apiRequest(ENDPOINTS.FINANCE_EXPENSES, { method: "POST", body: { category, amount, date, note } });
    },
    async deleteExpense(id) {
        return apiRequest(`${ENDPOINTS.FINANCE_EXPENSES}/${id}`, { method: "DELETE" });
    },

    // --- Revenues (non-fee income — donations, grants, rent, fundraising) ---
    async listRevenues(year, month) {
        const params = new URLSearchParams({ year });
        if (month) params.set("month", month);
        return apiRequest(`${ENDPOINTS.FINANCE_REVENUES}?${params.toString()}`);
    },
    async addRevenue({ category, amount, date, note }) {
        return apiRequest(ENDPOINTS.FINANCE_REVENUES, { method: "POST", body: { category, amount, date, note } });
    },
    async deleteRevenue(id) {
        return apiRequest(`${ENDPOINTS.FINANCE_REVENUES}/${id}`, { method: "DELETE" });
    },

    // --- Finance Flow (Jan-Dec revenue vs expenses for a calendar year) ---
    async getFinanceFlow(year) {
        return apiRequest(`${ENDPOINTS.FINANCE_FLOW}?year=${encodeURIComponent(year)}`);
    }
};

/* ---------------------------------------------------------
   5b. STAFF PAYROLL, ALLOWANCES & SALARY ADVANCES
   Talks to routes/payroll.routes.js, mounted under /api/finance/payroll —
   every call here already carries the Finance-scoped token automatically,
   the same way FinanceAPI's calls do (see apiRequest()'s "/finance/"
   check above), since these paths start with "/finance/" too.
   --------------------------------------------------------- */
const PayrollAPI = {
    // --- Staff profiles ---
    // No page -> old behavior: full plain array. Pass page/pageSize for
    // { data, total, page, pageSize, totalPages } — used by the Staff
    // Profiles table only.
    async listStaff({ status, roleType, search, page, pageSize } = {}) {
        const params = new URLSearchParams();
        if (status) params.set("status", status);
        if (roleType) params.set("roleType", roleType);
        if (search) params.set("search", search);
        if (page) params.set("page", page);
        if (pageSize) params.set("pageSize", pageSize);
        const qs = params.toString();
        return apiRequest(qs ? `${ENDPOINTS.PAYROLL_STAFF}?${qs}` : ENDPOINTS.PAYROLL_STAFF);
    },
    // Returns { ...profile, allowances: [...], advances: [...] } — the
    // staff detail screen's single data source.
    async getStaff(id) {
        return apiRequest(ENDPOINTS.PAYROLL_STAFF_BY_ID(id));
    },
    async createStaff({ name, roleType, employmentType, baseSalary, phone, paymentDetails, status }) {
        return apiRequest(ENDPOINTS.PAYROLL_STAFF, {
            method: "POST",
            body: { name, roleType, employmentType, baseSalary, phone, paymentDetails, status }
        });
    },
    async updateStaff(id, patch) {
        return apiRequest(ENDPOINTS.PAYROLL_STAFF_BY_ID(id), { method: "PUT", body: patch });
    },
    async deleteStaff(id) {
        return apiRequest(ENDPOINTS.PAYROLL_STAFF_BY_ID(id), { method: "DELETE" });
    },

    // --- Allowances ---
    async addAllowance(staffId, { title, amount, type, dateAdded }) {
        return apiRequest(ENDPOINTS.PAYROLL_ALLOWANCES(staffId), {
            method: "POST",
            body: { title, amount, type, dateAdded }
        });
    },
    async deleteAllowance(id) {
        return apiRequest(ENDPOINTS.PAYROLL_ALLOWANCE_BY_ID(id), { method: "DELETE" });
    },

    // --- Salary advances ---
    // Issuing immediately creates the tracking balance server-side —
    // there's no separate "approve" step (see routes/payroll.routes.js).
    async issueAdvance(staffId, { requestedAmount, repaymentAmountPerMonth, requestDate }) {
        return apiRequest(ENDPOINTS.PAYROLL_ADVANCES(staffId), {
            method: "POST",
            body: { requestedAmount, repaymentAmountPerMonth, requestDate }
        });
    },
    // Standalone advances list for one staff member — used by the Bursar's
    // dedicated Salary Advances screen, which (unlike the Admin/HR/Director
    // Staff Detail modal) never calls getStaff()/PAYROLL_STAFF_BY_ID, since
    // that endpoint is Admin/HR/Director only and returns base salary too.
    async getAdvances(staffId) {
        return apiRequest(ENDPOINTS.PAYROLL_ADVANCES(staffId));
    },
    // Bursar-safe staff picker for Salary Advances — id/name/roleType only.
    async lookupAdvanceStaff(search) {
        const qs = search ? `?search=${encodeURIComponent(search)}` : "";
        return apiRequest(`${ENDPOINTS.PAYROLL_ADVANCE_LOOKUP}${qs}`);
    },

    // --- Payroll runs ---
    async listRecords({ month, year, staffId } = {}) {
        const params = new URLSearchParams({ month, year });
        if (staffId) params.set("staffId", staffId);
        return apiRequest(`${ENDPOINTS.PAYROLL_RECORDS}?${params.toString()}`);
    },
    // Omit staffIds to run payroll for every active staff member.
    async generate(month, year, staffIds) {
        return apiRequest(ENDPOINTS.PAYROLL_GENERATE, {
            method: "POST",
            body: { month, year, ...(staffIds ? { staffIds } : {}) }
        });
    },
    async markPaid(recordId) {
        return apiRequest(ENDPOINTS.PAYROLL_MARK_PAID(recordId), { method: "PUT" });
    },

    // --- Bulk salary update ---
    // Target EITHER an explicit staffIds array OR a { roleType, status }
    // filter (server-side default status is "active" when neither
    // staffIds nor status is given) — never both; staffIds wins if present.
    // mode is "percent" or "flat"; value can be negative (a pay cut) but
    // never 0. Returns { updated: [...], skipped: [...] } — skipped staff
    // are the ones a change would have pushed negative, not an error.
    async bulkUpdateSalary({ staffIds, roleType, status, mode, value, reason }) {
        return apiRequest(ENDPOINTS.PAYROLL_BULK_SALARY_UPDATE, {
            method: "POST",
            body: { staffIds, roleType, status, mode, value, reason }
        });
    }
};

/* ---------------------------------------------------------
   5b-2. PART-TIME WEEKLY PAYROLL — separate track from PayrollAPI above.
   Talks to routes/part-time-payroll.routes.js, mounted under
   /api/finance/part-time-payroll — carries the Finance-scoped token
   automatically, same as PayrollAPI (paths start with "/finance/" too).
   Bursar has full read/write access here (see EDIT_ROLES in that route
   file); Human Resource/Director get read-only oversight; Bursar gets
   NO access to PayrollAPI above at all — the two role sets are
   deliberately inverted between these two API objects.
   --------------------------------------------------------- */
const PartTimePayrollAPI = {
    // Minimal id/name list of active Part-Time staff — never salary/
    // phone/payment data (same principle as PayrollAPI.lookupAdvanceStaff).
    async lookupStaff(search) {
        const qs = search ? `?search=${encodeURIComponent(search)}` : "";
        return apiRequest(`${ENDPOINTS.PART_TIME_PAYROLL_STAFF}${qs}`);
    },
    // At least one of weekStart/staffId is required by the backend.
    async getRecords({ weekStart, staffId } = {}) {
        const params = new URLSearchParams();
        if (weekStart) params.set("weekStart", weekStart);
        if (staffId) params.set("staffId", staffId);
        return apiRequest(`${ENDPOINTS.PART_TIME_PAYROLL_RECORDS}?${params.toString()}`);
    },
    async addRecord({ staffId, weekStartDate, amount, note }) {
        return apiRequest(ENDPOINTS.PART_TIME_PAYROLL_RECORDS, {
            method: "POST",
            body: { staffId, weekStartDate, amount, note }
        });
    },
    async deleteRecord(id) {
        return apiRequest(ENDPOINTS.PART_TIME_PAYROLL_RECORD_BY_ID(id), { method: "DELETE" });
    },
    async markPaid(id) {
        return apiRequest(ENDPOINTS.PART_TIME_PAYROLL_MARK_PAID(id), { method: "PUT" });
    }
};

/* ---------------------------------------------------------
   5c. DEBOUNCE — shared utility for search/filter inputs.
   Delays calling `fn` until `wait` ms have passed with no further
   calls, so typing in a search box fires ONE request after the user
   pauses instead of one request per keystroke. Defined here (api.js
   loads first, before script.js/payroll.js) so every module can use
   it without its own copy.

   Usage:
     const debouncedSearch = debounce(() => loadStudentData(), 350);
     // wire an input's oninput/addEventListener to debouncedSearch
   --------------------------------------------------------- */
function debounce(fn, wait = 300) {
    let timer = null;
    return function debounced(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), wait);
    };
}

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
    // No args -> old behavior: full plain array (used by dropdowns, the
    // Scores/Attendance student pickers, refreshStudentsList(), etc).
    // Pass { class, search, page, pageSize } for the paginated shape:
    // { data, total, page, pageSize, totalPages } — used by the Student
    // Records admin table only.
    async list(params = {}) {
        const qs = new URLSearchParams();
        if (params.class && params.class !== 'ALL') qs.set('class', params.class);
        if (params.search) qs.set('search', params.search);
        if (params.page) qs.set('page', params.page);
        if (params.pageSize) qs.set('pageSize', params.pageSize);
        const query = qs.toString();
        return remoteFirst(
            () => apiRequest(query ? `${ENDPOINTS.STUDENTS}?${query}` : ENDPOINTS.STUDENTS),
            () => {
                // Best-effort local fallback so the admin table still works
                // in offline/local-demo mode: filter + slice studentsList
                // the same way the server would.
                if (!params.page) return studentsList;
                let filtered = studentsList;
                if (params.class && params.class !== 'ALL') filtered = filtered.filter(s => s.class === params.class);
                if (params.search) {
                    const term = params.search.toLowerCase();
                    filtered = filtered.filter(s =>
                        (s.id && s.id.toLowerCase().includes(term)) ||
                        (s.name && s.name.toLowerCase().includes(term))
                    );
                }
                const pageSize = params.pageSize || 25;
                const page = params.page || 1;
                const start = (page - 1) * pageSize;
                return {
                    data: filtered.slice(start, start + pageSize),
                    total: filtered.length,
                    page,
                    pageSize,
                    totalPages: Math.max(1, Math.ceil(filtered.length / pageSize))
                };
            }
        );
    },
    async create(student) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.STUDENTS, { method: "POST", body: student }),
            () => { studentsList.push(student); return student; }
        );
    },
    async update(studentId, updates) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.STUDENT_BY_ID(studentId), { method: "PUT", body: updates }),
            () => {
                const s = studentsList.find(s => s.id === studentId);
                if (s) Object.assign(s, updates);
                return s;
            }
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
   6b. ADMIN STAFF MANAGEMENT DATA-ACCESS LAYER (Bursar / Human
   Resource / Director accounts). Administrator-only — see
   routes/admin-staff.routes.js. This is a distinct concern from
   TeachersAPI (Teacher accounts) and StudentsAPI (Student accounts):
   those two provision their own login as a side effect of creating a
   domain record (a teacher profile / a student record); a staff
   account here has no such domain record — it's the account itself.

   No local-fallback "demo" list is offered beyond an in-memory mirror
   of whatever the server last returned, since there's no meaningful
   offline stand-in for real Administrator-managed credentials.
   --------------------------------------------------------- */
let staffAccountsList = []; // in-memory mirror of the last-fetched staff list, so the table can re-render without refetching after a local list() call

const StaffAPI = {
    // { username, name, role, createdAt }[]
    async list() {
        const remote = await apiRequest(ENDPOINTS.ADMIN_STAFF_LIST);
        if (Array.isArray(remote)) staffAccountsList = remote;
        return staffAccountsList;
    },
    // { username, password, fullName, role } -> role must be one of
    // ROLES.BURSAR / ROLES.HR / ROLES.DIRECTOR.
    async create({ username, password, fullName, role }) {
        const created = await apiRequest(ENDPOINTS.ADMIN_STAFF_CREATE, {
            method: "POST",
            body: { username, password, fullName, role }
        });
        staffAccountsList.push(created);
        return created;
    },
    // Partial update — pass only the fields changing, e.g. { fullName } or { role }.
    async update(username, updates) {
        const updated = await apiRequest(ENDPOINTS.ADMIN_STAFF_BY_USERNAME(username), {
            method: "PUT",
            body: updates
        });
        const idx = staffAccountsList.findIndex(s => s.username.toLowerCase() === username.toLowerCase());
        if (idx !== -1) staffAccountsList[idx] = updated;
        return updated;
    },
    async resetPassword(username, newPassword) {
        return apiRequest(ENDPOINTS.ADMIN_STAFF_RESET_PASSWORD(username), {
            method: "POST",
            body: { newPassword }
        });
    },
    async remove(username) {
        const result = await apiRequest(ENDPOINTS.ADMIN_STAFF_BY_USERNAME(username), { method: "DELETE" });
        staffAccountsList = staffAccountsList.filter(s => s.username.toLowerCase() !== username.toLowerCase());
        return result;
    }
};

/* ---------------------------------------------------------
   9. SCORES / MARKS DATA-ACCESS LAYER
   --------------------------------------------------------- */
const ScoresAPI = {
    // termYear: { term, year } — the term currently being viewed. Every
    // caller should pass the app's selectedTerm (see script.js), not
    // termSettings — those are two different things: termSettings is the
    // school's "current active term", selectedTerm is "what this user is
    // looking at right now", and they diverge whenever someone opens a
    // past term's records while the school has already moved on.
    async list(classLevel, subject, termYear) {
        // No local-storage fallback here on purpose: marksStorage already *is*
        // the local store, so there's nothing useful to fall back to — if the
        // backend can't be reached, refreshScoresList() in script.js just
        // leaves the existing in-memory marksStorage untouched.
        return remoteFirst(
            () => apiRequest(ENDPOINTS.SCORES_QUERY({ class: classLevel, subject, term: termYear && termYear.term, year: termYear && termYear.year })),
            () => null
        );
    },
    async save(recordKey, marksRecord, classLevel, termYear) {
        const parsed = parseScoreRecordKey(recordKey);
        // NOTE: deliberately NOT using remoteFirst's silent local-fallback here.
        // marksStorage lives only in this tab's memory (nothing backs it with
        // localStorage), so a network failure "succeeding" via local fallback
        // would mean the mark quietly vanishes on refresh with zero indication
        // anything was wrong — which is exactly the bug this used to cause.
        // Every failure, network or server-side, must reach the caller.
        const body = {
            subject: parsed.subject, studentId: parsed.studentId, classLevel,
            term: (termYear && termYear.term) || parsed.term,
            year: (termYear && termYear.year) || parsed.year,
            ...marksRecord
        };
        // A cleared score field is kept as '' in local state (see
        // updateMarks/updateALevelMarks) so it renders as a clean blank
        // instead of any stale value. The scores table's mark columns are
        // NUMERIC and can't store '', so only in this outgoing request body,
        // translate that empty marker to a real SQL NULL for those columns.
        ['ao1', 'ao2', 'eot', 'p1', 'p2'].forEach(field => {
            if (body[field] === '') body[field] = null;
        });
        try {
            return await apiRequest(ENDPOINTS.SCORES, { method: "POST", body });
        } catch (err) {
            marksStorage[recordKey] = marksRecord; // keep it visible in this tab, but the caller must be told it isn't actually persisted
            throw err;
        }
    },
    // Fully unlinks a subject from one student for one term: deletes the
    // scores row outright (not a save() with cleared values, which would
    // just re-trigger the sticky touched-flag OR'ing on the backend). Same
    // no-silent-fallback reasoning as save() — the caller must know if this
    // didn't persist. recordKey must be the full 4-segment key (subject,
    // studentId, term, year) so this can never touch a different term's row.
    async remove(recordKey) {
        return apiRequest(ENDPOINTS.SCORE_BY_RECORD_KEY(recordKey), { method: "DELETE" });
    },
    // Stamps one initials value onto every existing scores row for a
    // class+subject+term+year in a single request, instead of one save()
    // call per student. Same no-silent-fallback reasoning as save() above.
    async applyBulkInitials(classLevel, subject, initials, termYear) {
        return apiRequest(ENDPOINTS.SCORES_BULK_INITIALS, {
            method: "POST",
            body: { classLevel, subject, initials, term: termYear && termYear.term, year: termYear && termYear.year }
        });
    },
    // Student-only self-service call — the backend scopes this to
    // req.user.studentId regardless of who's asking, same as list()'s
    // Student branch. No local-storage fallback (same reasoning as
    // list()): there's nothing meaningful to fall back to, so a network
    // failure just resolves to null and the chart shows its empty state.
    async trend() {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.SCORES_TREND),
            () => null
        );
    }
};

// recordKey convention for scores is "SUBJECT_studentId_Term X_YYYY" (four
// segments; the subject itself may contain underscores, so parsing walks in
// from both ends rather than assuming a fixed split). Centralised here so
// every call site builds/reads the key the same way instead of hand-rolling
// string splits that break the moment the format changes again.
function buildScoreRecordKey(subject, studentId, term, year) {
    return `${subject}_${studentId}_${term}_${year}`;
}
function parseScoreRecordKey(recordKey) {
    const parts = recordKey.split('_');
    const year = parts.pop();
    const term = parts.pop();
    const studentId = parts.pop();
    const subject = parts.join('_');
    return { subject, studentId, term, year: Number(year) };
}

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
    // One term's register — used by the term-switcher to show a past
    // term's attendance without the caller having to know its date range.
    async listForTerm(term, year) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.ATTENDANCE_BY_TERM(term, year)),
            () => null
        );
    },
    async setStatus(date, studentId, status, termYear) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.ATTENDANCE, {
                method: "POST",
                body: { date, studentId, status, term: termYear && termYear.term, year: termYear && termYear.year }
            }),
            () => { attendanceStorage[`${date}_${studentId}`] = status; return status; }
        );
    },
    async saveRegistry(date, classLevel, termYear) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.ATTENDANCE, {
                method: "PUT",
                body: { date, classLevel, records: attendanceStorage, term: termYear && termYear.term, year: termYear && termYear.year }
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
    },
    // Every distinct { term, year } that has data on file, newest first —
    // used to populate the term-switcher dropdown so a user can only ever
    // pick a term that actually has something to show. Falls back to just
    // the current termSettings value when the backend isn't reachable, so
    // the switcher still shows at least one option offline.
    async history() {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.TERM_HISTORY),
            () => [{ term: termSettings.term, year: termSettings.year }]
        );
    }
};

/* ---------------------------------------------------------
   12. ADMIN ACTIVITY LOG DATA-ACCESS LAYER
   Login-event history lives entirely server-side (activity_log
   table) — there's no local/offline demo data for it, so the
   fallback below just returns an empty list rather than fake rows.
   --------------------------------------------------------- */
const ActivityLogAPI = {
    async list() {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.ACTIVITY_LOG),
            () => []
        );
    },
    // No local-fallback here on purpose, same reasoning as ScoresAPI.save:
    // the activity log lives entirely server-side, so a network failure
    // must reach the caller rather than silently "succeeding" locally.
    async clear() {
        return apiRequest(ENDPOINTS.ACTIVITY_LOG, { method: "DELETE" });
    }
};

/* ---------------------------------------------------------
   13. ADMIN NOTICE BOARD DATA-ACCESS LAYER
   Notices live server-side in the `notices` table (see
   lcs-backend/routes/notices.routes.js) so deletes/posts persist
   across reloads and devices instead of only in one browser's
   localStorage. The offline/local fallback below (used only when
   the backend truly isn't reachable) operates on the in-memory
   noticesList directly — there is no hardcoded/demo seed data to
   fall back to, so a deleted notice can never "come back".
   --------------------------------------------------------- */
const NoticesAPI = {
    async list() {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.NOTICES),
            () => noticesList
        );
    },
    async create(notice) {
        return remoteFirst(
            () => apiRequest(ENDPOINTS.NOTICES, { method: "POST", body: notice }),
            () => {
                const created = { id: noticeIdCounter++, ...notice };
                noticesList.push(created);
                return created;
            }
        );
    },
    async remove(noticeId) {
        return remoteFirst(
            () => apiRequest(`${ENDPOINTS.NOTICES}?id=${encodeURIComponent(noticeId)}`, { method: "DELETE" }),
            () => { noticesList = noticesList.filter(n => n.id !== noticeId); return true; }
        );
    }
};

/* ---------------------------------------------------------
   14. REPORT CARD REMARKS DATA-ACCESS LAYER
   Class Teacher's / Headteacher's comment fields. No local-storage
   fallback here on purpose (same reasoning as ScoresAPI.save): a
   comment failing to reach the server must be visible to the caller,
   not silently "succeed" via a local store that only this tab/device
   can see — that's the exact bug this migration exists to fix.
   --------------------------------------------------------- */
const RemarksAPI = {
    // Every remark row on file for one student (used by the login-time
    // rescue migration and by report-card rendering to hydrate every
    // term/year at once, mirroring how AttendanceAPI.listForStudent works).
    async listForStudent(studentId) {
        return apiRequest(ENDPOINTS.REMARKS_BY_STUDENT(studentId));
    },
    async save(studentId, term, year, fields) {
        return apiRequest(ENDPOINTS.REMARKS, {
            method: "POST",
            body: { studentId, term, year, ...fields }
        });
    }
};

const AIToolboxAPI = {
    // save=true (the default) persists the generated item server-side in
    // the same call and returns the saved row; save=false only returns a
    // preview (used by a future "regenerate before saving" flow).
    async generate(toolType, params, save = true) {
        // Gemini generation routinely takes longer than the default
        // API_CONFIG.TIMEOUT_MS (12s), which was aborting the request
        // mid-flight. 60s here only — every other endpoint keeps the
        // fast default timeout.
        return apiRequest(ENDPOINTS.AI_GENERATE, {
            method: "POST",
            body: { toolType, params, save },
            timeoutMs: 60000
        });
    },
    async list(filters = {}) {
        const qs = new URLSearchParams(filters).toString();
        return apiRequest(qs ? `${ENDPOINTS.AI_ITEMS}?${qs}` : ENDPOINTS.AI_ITEMS);
    },
    async get(id) {
        return apiRequest(ENDPOINTS.AI_ITEM_BY_ID(id));
    },
    async update(id, fields) {
        return apiRequest(ENDPOINTS.AI_ITEM_BY_ID(id), { method: "PUT", body: fields });
    },
    async remove(id) {
        return apiRequest(ENDPOINTS.AI_ITEM_BY_ID(id), { method: "DELETE" });
    }
};
