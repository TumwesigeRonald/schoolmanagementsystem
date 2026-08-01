/* =========================================================
   SCHOOL MANAGEMENT SYSTEM - script.js
   Theme: Professional Clean Light Design with Analytics Graph
   ========================================================= */
/* ---------------------------------------------------------
   0. MOBILE SIDEBAR TOGGLE LOGIC
   --------------------------------------------------------- */
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) sidebar.classList.toggle('-translate-x-full');
    if (backdrop) backdrop.classList.toggle('hidden');
}
// Auto-close the drawer after a menu/nav-link click (mobile only — the
// docked desktop sidebar ignores this class via CSS, so this is a no-op
// visually on desktop while still being harmless to call there).
function closeMobileSidebar() {
    if (window.innerWidth >= 768) return;
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) sidebar.classList.add('-translate-x-full');
    if (backdrop) backdrop.classList.add('hidden');
}
/* ---------------------------------------------------------
   1. GLOBAL STATE & DATA
   --------------------------------------------------------- */
let studentsList = [
    { id: "LCS/001", name: "Namubiru Grace", class: "S.4", gender: "Female" },
    { id: "LCS/002", name: "Kigozi John", class: "S.4", gender: "Male" },
    { id: "LCS/003", name: "Akwero Patricia", class: "S.3", gender: "Female" },
    { id: "LCS/004", name: "TUMWESIGE RONALD", class: "S.1", gender: "Male" }
];
let marksStorage = {}; 
let attendanceStorage = {};
let resourcesList = [];
let resourceIdCounter = 1;
let teachersList = [
    { id: "T001", name: "Namuli Grace", username: "gnamuli", password: "teach123", subject: "MATHEMATICS" },
    { id: "T002", name: "Okello Peter", username: "pokello", password: "teach123", subject: "ENGLISH" }
];
let currentUser = { username: "", role: "", name: "", studentId: null, teacherId: null };
const oLevelSubjects = [
    "ENGLISH", "MATHEMATICS", "PHYSICS", "CHEMISTRY", "BIOLOGY", 
    "GEOGRAPHY", "HIST & POL EDU", "AGRICULTURE", "CRE", 
    "FINE ART", "ICT", "ENTREPRENEURSHIP", "PHYSICAL EDUCATION", 
    "KISWAHILI", "LUGANDA"
];
const aLevelSubjects = [
    "GENERAL PAPER", "SUBSIDIARY MATHEMATICS", "ICT (SUBSIDIARY)", 
    "MATHEMATICS", "PHYSICS", "CHEMISTRY", "BIOLOGY", "AGRICULTURE", 
    "ECONOMICS", "ENTREPRENEURSHIP", "GEOGRAPHY", "HISTORY", 
    "LITERATURE IN ENGLISH", "CRE", "ART", "FRENCH", "LUGANDA"
];
const subsidiarySubjects = ["GENERAL PAPER", "SUBSIDIARY MATHEMATICS", "ICT (SUBSIDIARY)"];
let performanceChartInstance = null;
let gradeDistributionChartInstance = null;
/* ---------------------------------------------------------
   1c. TERM / CALENDAR SETTINGS (persisted in memory)
   Holds the currently selected term, year, and the upcoming
   term's start/end dates so they survive switching tabs and
   are reliably pulled into every generated report card.
   --------------------------------------------------------- */
let termSettings = {
    term: 'Term 1',
    year: new Date().getFullYear(),
    nextBegins: '',
    nextEnds: ''
};
/* ---------------------------------------------------------
   1c2. REPORT CARD REMARKS (Class Teacher's / Headteacher's
   comments) — client-side only, keyed by student+term+year.
   Kept separate from marksStorage/backend on purpose: this is a
   pure productivity add-on and must never touch the existing
   scores schema, calculations, or API routes. Persisted to
   localStorage only, so it survives a refresh but is NOT synced
   across devices — best-effort, never blocks report generation.
   --------------------------------------------------------- */
let reportRemarksStorage = {};
try {
    const storedReportRemarks = localStorage.getItem('lcs_report_remarks');
    if (storedReportRemarks) reportRemarksStorage = JSON.parse(storedReportRemarks);
} catch (e) { /* localStorage unavailable — remarks simply won't persist across reloads */ }
/* ---------------------------------------------------------
   1b. AO (ACTIVITY OF INTEGRATION) AVERAGE HELPER
   Rule: only average AO1 + AO2 together when BOTH have a valid,
   non-zero score entered. If only one AO score is present, the
   "Av. Score" equals that single score directly (no /2 penalty).
   --------------------------------------------------------- */
function calculateAOAverage(ao1Raw, ao2Raw) {
    const ao1 = Number(ao1Raw) || 0;
    const ao2 = Number(ao2Raw) || 0;
    if (ao1 > 0 && ao2 > 0) return (ao1 + ao2) / 2;
    if (ao1 > 0) return ao1;
    if (ao2 > 0) return ao2;
    return 0;
}
/* ---------------------------------------------------------
   1b-i. SCORE DISPLAY FORMATTER
   Purely cosmetic helper: the backend's NUMERIC(5,2) columns
   come back as strings like "0.00" / "2.50". This normalizes
   any AO-style float score to exactly one decimal place for
   display only — it never touches the underlying stored value
   or any calculation, which continue to use the raw number.
   --------------------------------------------------------- */
function formatAOScoreDisplay(raw, emptyValue) {
    if (raw === null || raw === undefined || raw === '') return emptyValue;
    const n = Number(raw);
    if (isNaN(n)) return emptyValue;
    if (n === 0) return emptyValue;
    return n.toFixed(1);
}
/* ---------------------------------------------------------
   1b-ii. WHOLE-NUMBER SCORE DISPLAY FORMATTER
   Same reasoning as formatAOScoreDisplay above, but for EOT-style
   marks that are meant to be plain whole numbers (e.g. "80", "0")
   rather than decimals — the backend's NUMERIC(5,2) column still
   returns strings like "80.00", so this strips the decimal part
   for display only. No calculation uses this value.
   --------------------------------------------------------- */
function formatWholeScoreDisplay(raw, emptyValue) {
    if (raw === null || raw === undefined || raw === '') return emptyValue;
    const n = Number(raw);
    if (isNaN(n)) return emptyValue;
    if (n === 0) return emptyValue;
    return String(Math.round(n));
}
/* ---------------------------------------------------------
   1b-iii. HTML ESCAPE HELPER (for any free-text user input we
   render back into the DOM, e.g. report card remarks)
   --------------------------------------------------------- */
function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
/* ---------------------------------------------------------
   1b-iv. REPORT CARD REMARKS HELPERS
   Class Teacher's / Headteacher's comment fields on the report
   card footer. Purely additive productivity feature — does not
   touch marksStorage, grading, or any backend route.
   --------------------------------------------------------- */
function getReportRemarkKey(studentId, term, year) {
    return `${studentId}_${term}_${year}`;
}
function getReportRemark(studentId, term, year, field) {
    const key = getReportRemarkKey(studentId, term, year);
    return (reportRemarksStorage[key] && reportRemarksStorage[key][field]) || '';
}
function persistReportRemarks() {
    try { localStorage.setItem('lcs_report_remarks', JSON.stringify(reportRemarksStorage)); }
    catch (e) { /* best-effort only */ }
}
function saveReportRemark(el) {
    if (!getPermissions(currentUser.role).canViewAllReports) return; // RBAC guard
    const key = el.dataset.remarkKey;
    const field = el.dataset.remarkField;
    if (!key || !field) return;
    if (!reportRemarksStorage[key]) reportRemarksStorage[key] = {};
    reportRemarksStorage[key][field] = el.innerText.trim();
    persistReportRemarks();
}
// Builds one "LABEL: ______" footer row. When editable, the line is a
// contenteditable div the admin/teacher can type straight into before
// printing; when read-only (the Student's own report view) it's a plain
// span, exactly as before.
function buildCommentRow(label, studentId, term, year, field, editable) {
    const key = getReportRemarkKey(studentId, term, year);
    const value = getReportRemark(studentId, term, year, field);
    if (editable) {
        return `
                <div class="rc-comment-row">
                    <span class="rc-comment-label">${label}:</span>
                    <div class="rc-comment-line rc-comment-editable" contenteditable="true" data-remark-key="${key}" data-remark-field="${field}" oninput="saveReportRemark(this)" data-placeholder="Click to type a comment&hellip;">${value ? escapeHTML(value) : ''}</div>
                </div>`;
    }
    return `
                <div class="rc-comment-row">
                    <span class="rc-comment-label">${label}:</span>
                    <span class="rc-comment-line">${value ? escapeHTML(value) : '&nbsp;'}</span>
                </div>`;
}
/* ---------------------------------------------------------
   1d. REMOTE DATA SYNC
   studentsList/teachersList/resourcesList/termSettings start out
   as hardcoded demo data (above) purely so the UI has something
   to render before the first successful API call. Once the
   backend is reachable, these helpers pull the real Neon-backed
   state and keep the in-memory copies in sync with it — every
   create/update/delete below re-syncs from the server afterwards
   rather than only mutating the local array, so a page refresh
   (or a second device) sees the same data the database has.
   Each is best-effort: if the backend call fails (offline/local
   demo mode) the existing in-memory list is left untouched.
   --------------------------------------------------------- */
async function refreshStudentsList() {
    try {
        const remote = await StudentsAPI.list();
        if (Array.isArray(remote)) studentsList = remote;
    } catch (e) { /* keep existing local list */ }
}
async function refreshTeachersList() {
    try {
        const remote = await TeachersAPI.list();
        if (Array.isArray(remote)) teachersList = remote;
    } catch (e) { /* keep existing local list */ }
}
async function refreshResourcesList() {
    try {
        const remote = await ResourcesAPI.list();
        if (Array.isArray(remote)) resourcesList = remote;
    } catch (e) { /* keep existing local list */ }
}
async function refreshTermSettings() {
    try {
        const remote = await TermAPI.get();
        if (remote) termSettings = remote;
    } catch (e) { /* keep existing local settings */ }
}
async function refreshScoresList() {
    // marksStorage is keyed by recordKey ("SUBJECT_studentId"), same
    // convention the backend uses for scores.record_key — just re-key the
    // rows the API returns into that shape. Grading/report-card logic
    // (section 6 below) reads marksStorage the same way either way, so
    // nothing about how marks are calculated or displayed changes.
    try {
        const remote = await ScoresAPI.list();
        if (Array.isArray(remote)) {
            const rehydrated = {};
            remote.forEach(row => {
                rehydrated[row.recordKey] = {
                    ao1: row.ao1, ao2: row.ao2, eot: row.eot,
                    p1: row.p1, p2: row.p2,
                    remarks: row.remarks, touched: row.touched
                };
            });
            marksStorage = rehydrated;
        }
    } catch (e) { /* keep existing local marksStorage */ }
}
async function refreshAttendanceList() {
    // attendanceStorage is keyed by recordKey ("date_studentId"), same
    // convention the backend uses for attendance.record_key — the rows the
    // API returns map onto it directly (just recordKey -> status).
    // Scoped to the last ~6 months: the register only ever looks at one
    // date at a time, and this table gains a new row per student per day,
    // so at 300+ students an unbounded fetch here grows every term. A
    // student's full history (needed for their report-card attendance %)
    // is fetched separately and on demand — see refreshAttendanceForStudent.
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const sinceDate = sixMonthsAgo.toISOString().slice(0, 10);
    try {
        const remote = await AttendanceAPI.listRecent(sinceDate);
        if (Array.isArray(remote)) {
            const rehydrated = {};
            remote.forEach(row => { rehydrated[row.recordKey] = row.status; });
            attendanceStorage = rehydrated;
        }
    } catch (e) { /* keep existing local attendanceStorage */ }
}
// Pulls one student's full attendance history on demand (report cards need
// an accurate lifetime %, but there's no need to fetch it for every student
// until their report is actually being generated). Merges into the existing
// attendanceStorage rather than replacing it, so the recent-window data
// loaded at login isn't lost for other students.
async function refreshAttendanceForStudent(studentId) {
    try {
        const remote = await AttendanceAPI.listForStudent(studentId);
        if (Array.isArray(remote)) {
            remote.forEach(row => { attendanceStorage[row.recordKey] = row.status; });
        }
    } catch (e) { /* keep existing local attendanceStorage for this student */ }
}
async function syncAllRemoteData() {
    // Run in parallel — independent endpoints, no ordering dependency.
    await Promise.all([
        refreshStudentsList(),
        refreshTeachersList(),
        refreshResourcesList(),
        refreshTermSettings(),
        refreshScoresList(),
        refreshAttendanceList()
    ]);
}
/* ---------------------------------------------------------
   2. AUTHENTICATION & NAVIGATION
   --------------------------------------------------------- */
async function handleLogin(event) {
    event.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorBox = document.getElementById('login-error');
    const submitBtn = event.target.querySelector('button[type="submit"]');

    if (username === "" || password.trim() === "") {
        if (errorBox) {
            errorBox.innerText = "Please enter both a username and password.";
            errorBox.classList.remove('hidden');
        }
        return;
    }

    if (errorBox) errorBox.classList.add('hidden');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = "Signing in..."; }

    // AuthAPI (see api.js) tries the real Node.js backend first
    // (POST /api/auth/login) and only falls back to local demo
    // accounts if the backend is unreachable — no code here changes
    // once the backend is deployed.
    const result = await AuthAPI.login(username, password);

    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Login'; }

    if (!result.ok) {
        if (errorBox) {
            errorBox.innerText = result.message || "Invalid username or password.";
            errorBox.classList.remove('hidden');
        }
        return;
    }

    await applySessionUser(result.user);
}
async function applySessionUser(user) {
    currentUser.username = user.username;
    currentUser.role = user.role;
    currentUser.name = user.name || user.username;
    currentUser.studentId = user.studentId || null;
    currentUser.teacherId = user.teacherId || null;

    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('dashboard-section').classList.remove('hidden');

    // Pull the current, authoritative state from the backend/Neon before
    // rendering anything below, so the dashboard reflects real data
    // instead of the hardcoded demo lists.
    await syncAllRemoteData();

    const userBadge = document.getElementById('user-badge');
    if (userBadge) userBadge.innerText = `Logged in: ${currentUser.username}`;

    const roleTag = document.getElementById('user-role-tag');
    if (roleTag) roleTag.innerText = currentUser.role;

    const termBadge = document.getElementById('term-badge');
    if (termBadge) termBadge.innerText = `${termSettings.term}, ${termSettings.year}`;

    const banner = document.getElementById('welcome-banner');
    if (banner) {
        const greetings = {
            [ROLES.ADMIN]: `Full administrative access &mdash; classes, students, subjects, term dates, user roles, and system-wide records.`,
            [ROLES.TEACHER]: `You have view access across the system, with permission to add and update learner scores.`,
            [ROLES.STUDENT]: `This view is limited to your own report card and shared learning resources.`
        };
        banner.innerHTML = `Welcome back, ${currentUser.name || currentUser.username}<span>${greetings[currentUser.role] || ''}</span>`;
        banner.classList.add('visible');
    }

    renderSidebarNav();
    switchTab(getPermissions(currentUser.role).defaultTab);
    updateDashboardStats();
}
function handleLogout() {
    AuthAPI.logout();
    currentUser.username = "";
    currentUser.role = "";
    currentUser.name = "";
    currentUser.studentId = null;
    currentUser.teacherId = null;
    document.getElementById('dashboard-section').classList.add('hidden');
    document.getElementById('login-section').classList.remove('hidden');
    document.getElementById('login-username').value = "";
    document.getElementById('login-password').value = "";
}
function renderSidebarNav() {
    const nav = document.getElementById('sidebar-nav');
    if (!nav) return;
    const allowedTabs = getPermissions(currentUser.role).tabs;
    const items = [
        { id: 'students', label: 'Students', icon: 'fa-user-graduate' },
        { id: 'scores', label: 'Scores', icon: 'fa-pen-to-square' },
        { id: 'reports', label: currentUser.role === 'Student' ? 'My Report Card' : 'Report Cards', icon: 'fa-file-lines' },
        { id: 'analytics', label: 'Analytics', icon: 'fa-chart-column' },
        { id: 'attendance', label: 'Attendance', icon: 'fa-calendar-check' },
        { id: 'resources', label: currentUser.role === 'Student' ? 'Learning Resources' : 'Resources', icon: 'fa-folder-open' },
        { id: 'teachers', label: currentUser.role === 'Teacher' ? 'My Profile' : 'Teachers', icon: 'fa-chalkboard-user' }
    ].filter(item => allowedTabs.includes(item.id));
    nav.innerHTML = items.map(item => `
        <button id="nav-${item.id}" onclick="switchTab('${item.id}'); closeMobileSidebar();" class="block w-full text-left py-2.5 px-4 rounded-lg text-xs font-extrabold uppercase tracking-wider text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors mb-1">
            <i class="fa-solid ${item.icon} mr-2"></i>${item.label}
        </button>
    `).join('');
}
function switchTab(tabName) {
    // RBAC gate: never render a tab this role isn't permitted to access,
    // even if switchTab() is called directly (e.g. from the console).
    const permissions = getPermissions(currentUser.role);
    if (!permissions.tabs.includes(tabName)) {
        tabName = permissions.defaultTab;
    }
    const tabs = ['students', 'scores', 'reports', 'analytics', 'attendance', 'resources', 'teachers'];
    tabs.forEach(tab => {
        const navItem = document.getElementById(`nav-${tab}`);
        if (!navItem) return;
        if (tab === tabName) {
            navItem.className = "block py-2.5 px-4 rounded-lg text-xs font-extrabold uppercase tracking-wider bg-teal-600 text-white shadow-sm";
        } else {
            navItem.className = "block py-2.5 px-4 rounded-lg text-xs font-extrabold uppercase tracking-wider text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors";
        }
    });
    const titleElem = document.getElementById('page-title');
    let titleText = "";
    switch (tabName) {
        case 'students': titleText = "Student Records Management"; break;
        case 'scores': titleText = "Academic Score Sheets"; break;
        case 'reports': titleText = "Report Cards & Transcripts"; break;
        case 'analytics': titleText = "Learner Performance Analytics"; break;
        case 'attendance': titleText = "Attendance Registry"; break;
        case 'resources': titleText = "Educational Resources"; break;
        case 'teachers': titleText = currentUser.role === 'Teacher' ? "My Teacher Profile" : "Teacher Accounts & Credentials"; break;
    }
    if (titleElem) titleElem.innerText = titleText;
    const contentElem = document.getElementById('tab-content');
    if (!contentElem) return;
    
    if (performanceChartInstance) {
        performanceChartInstance.destroy();
        performanceChartInstance = null;
    }
    if (gradeDistributionChartInstance) {
        gradeDistributionChartInstance.destroy();
        gradeDistributionChartInstance = null;
    }
    switch (tabName) {
        case 'students':
            contentElem.innerHTML = renderStudentsModule();
            loadStudentData();
            break;
        case 'scores':
            contentElem.innerHTML = renderScoresModule();
            updateSubjectDropdown();
            loadScoreSheetData();
            break;
        case 'reports':
            contentElem.innerHTML = renderReportsModule();
            break;
        case 'analytics':
            contentElem.innerHTML = renderAnalyticsModule();
            initPerformanceChart();
            break;
        case 'attendance':
            contentElem.innerHTML = renderAttendanceModule();
            loadAttendanceData();
            break;
        case 'resources':
            contentElem.innerHTML = renderResourcesModule();
            loadResourcesData();
            break;
        case 'teachers':
            contentElem.innerHTML = renderTeachersModule();
            loadTeacherData();
            break;
    }
    updateDashboardStats();
}
/* ---------------------------------------------------------
   3. DASHBOARD STATISTICS CALCULATION
   --------------------------------------------------------- */
function updateDashboardStats() {
    const metricsGrid = document.querySelector('.metrics-grid');
    if (metricsGrid) {
        // School-wide counts are administrative overview data — not part of
        // a Student's restricted, self-only view.
        metricsGrid.classList.toggle('hidden', currentUser.role === 'Student');
    }
    const totalStudents = studentsList.length;
    const uniqueClasses = [...new Set(studentsList.map(s => s.class))].length;
    const totalMarksRecorded = Object.values(marksStorage).filter(m => m && m.touched).length;
    const totalSubjects = oLevelSubjects.length + aLevelSubjects.length;
    
    const elStudents = document.getElementById('stat-students-count');
    const elClasses = document.getElementById('stat-classes-count');
    const elSubjects = document.getElementById('stat-subjects-count');
    const elMarks = document.getElementById('stat-marks-count');
    
    if (elStudents) elStudents.innerText = totalStudents;
    if (elClasses) elClasses.innerText = uniqueClasses;
    if (elSubjects) elSubjects.innerText = totalSubjects;
    if (elMarks) elMarks.innerText = totalMarksRecorded;
}
/* ---------------------------------------------------------
   4. STUDENT RECORDS MODULE (Light Theme)
   --------------------------------------------------------- */
function renderStudentsModule() {
    const canManage = getPermissions(currentUser.role).canManageStudents;
    return `
        <div class="space-y-6">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                <div class="w-full md:w-auto">
                    <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Filter by Class</label>
                    <select id="class-filter" onchange="loadStudentData()" class="w-full md:w-64 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700 focus:outline-none focus:ring-1 focus:ring-teal-500">
                        <option value="ALL">All Classes (S.1 - S.6)</option>
                        <option value="S.1">S.1</option>
                        <option value="S.2">S.2</option>
                        <option value="S.3">S.3</option>
                        <option value="S.4">S.4</option>
                        <option value="S.5">S.5</option>
                        <option value="S.6">S.6</option>
                    </select>
                </div>
                ${canManage ? `
                <div class="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
                    <button onclick="openBulkImportModal()" class="w-full sm:w-auto bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition">
                        <i class="fa-solid fa-file-csv mr-2"></i>Bulk Import (CSV)
                    </button>
                    <button onclick="toggleStudentForm()" class="w-full sm:w-auto bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs">
                        <i class="fa-solid fa-user-plus mr-2"></i>Add New Student
                    </button>
                </div>` : `
                <span class="text-[11px] font-extrabold text-slate-400 uppercase tracking-wider bg-slate-100 px-3 py-2 rounded-lg">View Only</span>`}
            </div>
            ${canManage ? `
            <div id="student-form-container" class="hidden bg-white border border-slate-200 p-5 rounded-2xl shadow-xs transition-all duration-300 ease-in-out">
                <h4 class="text-xs font-extrabold text-teal-700 uppercase tracking-wider mb-3"><i class="fa-solid fa-user-plus mr-2"></i>Register New Student</h4>
                <form onsubmit="handleAddStudent(event)" class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Student ID</label>
                        <input type="text" id="stud-id" placeholder="e.g. LCS/005" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Full Name</label>
                        <input type="text" id="stud-name" placeholder="Full name" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Class Level</label>
                        <select id="stud-class" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                            <option value="S.1">S.1</option>
                            <option value="S.2">S.2</option>
                            <option value="S.3">S.3</option>
                            <option value="S.4">S.4</option>
                            <option value="S.5">S.5</option>
                            <option value="S.6">S.6</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Gender</label>
                        <select id="stud-gender" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                            <option value="Male">Male</option>
                            <option value="Female">Female</option>
                        </select>
                    </div>
                    <div class="sm:col-span-2 md:col-span-4 flex justify-end space-x-2 pt-2">
                        <button type="button" onclick="toggleStudentForm()" class="bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-extrabold uppercase py-2 px-4 rounded-xl"><i class="fa-solid fa-xmark mr-1.5"></i>Cancel</button>
                        <button type="submit" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase py-2 px-4 rounded-xl transition"><i class="fa-solid fa-floppy-disk mr-1.5"></i>Save Student</button>
                    </div>
                </form>
            </div>` : ''}
            <div class="overflow-x-auto bg-white border border-slate-200 rounded-2xl shadow-xs">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider border-b border-slate-200">
                            <th class="p-4">Student ID</th>
                            <th class="p-4">Full Name</th>
                            <th class="p-4">Class</th>
                            <th class="p-4">Gender</th>
                            <th class="p-4 text-center">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="student-table-body" class="divide-y divide-slate-100 text-xs text-slate-700"></tbody>
                </table>
            </div>
        </div>
    `;
}
function loadStudentData() {
    const tbody = document.getElementById('student-table-body');
    const filterSelect = document.getElementById('class-filter');
    if (!tbody) return;
    const canManage = getPermissions(currentUser.role).canManageStudents;
    const selectedClass = filterSelect ? filterSelect.value : 'ALL';
    tbody.innerHTML = "";
    const filteredStudents = (selectedClass === 'ALL') ? studentsList : studentsList.filter(s => s.class === selectedClass);
    
    updateDashboardStats();
    if (filteredStudents.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-6 text-center text-slate-400 text-xs font-medium">No student records found for ${selectedClass}.</td></tr>`;
        return;
    }
    filteredStudents.forEach((student) => {
        tbody.innerHTML += `
            <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-4 font-mono text-xs font-bold text-teal-700">${student.id}</td>
                <td class="p-4 font-bold text-slate-900">${student.name}</td>
                <td class="p-4"><span class="bg-teal-50 text-teal-800 font-extrabold px-2.5 py-1 rounded-lg text-[11px] border border-teal-200">${student.class}</span></td>
                <td class="p-4 text-slate-600 font-semibold">${student.gender}</td>
                <td class="p-4 text-center space-x-2 whitespace-nowrap">
                    <button onclick="openStudentProfileModal('${student.id}')" class="text-teal-700 hover:text-teal-800 text-[11px] font-extrabold uppercase tracking-wider bg-teal-50 hover:bg-teal-100 px-3 py-1.5 rounded-lg border border-teal-200 transition-colors"><i class="fa-solid fa-id-card mr-1"></i>View</button>
                    ${canManage ? `<button onclick="deleteStudent('${student.id}')" class="text-rose-600 hover:text-rose-700 text-[11px] font-extrabold uppercase tracking-wider bg-rose-50 hover:bg-rose-100 px-3 py-1.5 rounded-lg border border-rose-200 transition-colors"><i class="fa-solid fa-trash mr-1"></i>Delete</button>` : ''}
                </td>
            </tr>
        `;
    });
}
/* ---------------------------------------------------------
   4b. STUDENT PROFILE MODAL
   Read-only view of one learner's historical attendance and
   performance summary. Reuses getAttendanceSummary(),
   getOLevelSubjectRecords()/getALevelSubjectRecords() and
   buildPerformanceRemark() exactly as report cards already do —
   no grading or attendance calculation is duplicated or altered.
   --------------------------------------------------------- */
function closeModal() {
    const root = document.getElementById('modal-root');
    if (root) root.innerHTML = '';
}
async function openStudentProfileModal(studentId) {
    const root = document.getElementById('modal-root');
    if (!root) return;
    const student = studentsList.find(s => s.id === studentId);
    if (!student) return;
    root.innerHTML = `
        <div class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4" onclick="if(event.target===this) closeModal()">
            <div class="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto">
                <div class="flex items-center justify-between p-5 border-b border-slate-200 sticky top-0 bg-white rounded-t-2xl">
                    <div>
                        <h3 class="text-sm font-extrabold text-slate-900">${student.name}</h3>
                        <p class="text-[11px] font-bold text-slate-500 uppercase tracking-wider">${student.id} &middot; ${student.class} &middot; ${student.gender}</p>
                    </div>
                    <button onclick="closeModal()" class="text-slate-400 hover:text-slate-600 text-lg px-2">&#10005;</button>
                </div>
                <div id="student-profile-body" class="p-5 space-y-5 text-center text-slate-400 text-xs font-semibold py-10">
                    <i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Loading attendance &amp; performance history&hellip;
                </div>
            </div>
        </div>
    `;
    // Attendance history needs this student's full record, not just the
    // recent rolling window already loaded — same on-demand fetch the
    // report card engine already uses (refreshAttendanceForStudent).
    await refreshAttendanceForStudent(student.id);
    const body = document.getElementById('student-profile-body');
    if (!body) return; // modal was closed while loading
    const isALevel = (student.class === 'S.5' || student.class === 'S.6');
    const subjectRecords = isALevel ? getALevelSubjectRecords(student) : getOLevelSubjectRecords(student);
    const attendance = getAttendanceSummary(student);
    const performanceRemark = buildPerformanceRemark(subjectRecords, isALevel);

    const subjectRowsHtml = subjectRecords.length > 0 ? subjectRecords.map(r => {
        const score = isALevel ? r.avgMark : r.finalTotal;
        const grade = isALevel ? r.gradeInfo.grade : r.gradeData.grade;
        return `<tr class="border-b border-slate-100"><td class="p-2 font-semibold">${r.subj}</td><td class="p-2 text-center">${score}</td><td class="p-2 text-center font-extrabold" style="color:${getPerformanceColor(score, isALevel)};">${grade}</td></tr>`;
    }).join('') : `<tr><td colspan="3" class="p-4 text-center text-slate-400">No subject scores recorded yet.</td></tr>`;

    body.innerHTML = `
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div class="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">
                <p class="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider">Attendance</p>
                <p class="text-lg font-extrabold text-slate-900">${attendance.total > 0 ? `${attendance.pct}%` : 'N/A'}</p>
                <p class="text-[10px] text-slate-500">${attendance.total > 0 ? `${attendance.present} present / ${attendance.total} recorded` : 'No records yet'}</p>
            </div>
            <div class="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">
                <p class="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider">Absences</p>
                <p class="text-lg font-extrabold text-rose-600">${attendance.absent}</p>
                <p class="text-[10px] text-slate-500">${attendance.excused} excused</p>
            </div>
            <div class="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">
                <p class="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider">Subjects Recorded</p>
                <p class="text-lg font-extrabold text-slate-900">${subjectRecords.length}</p>
                <p class="text-[10px] text-slate-500">${isALevel ? 'A-Level' : 'O-Level'} scale</p>
            </div>
        </div>
        <div>
            <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">Performance Summary</h4>
            <table class="w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
                <thead><tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold"><th class="p-2 text-left">Subject</th><th class="p-2 text-center">Score</th><th class="p-2 text-center">Grade</th></tr></thead>
                <tbody>${subjectRowsHtml}</tbody>
            </table>
        </div>
        <div class="bg-teal-50 border border-teal-200 rounded-xl p-3">
            <h4 class="text-[11px] font-extrabold text-teal-700 uppercase tracking-wider mb-1">System Summary</h4>
            <p class="text-xs text-teal-900">${performanceRemark}</p>
        </div>
    `;
}
function toggleStudentForm() {
    const formContainer = document.getElementById('student-form-container');
    if (formContainer) formContainer.classList.toggle('hidden');
}
/* ---------------------------------------------------------
   4c. BULK STUDENT IMPORT (CSV)
   Parses a CSV of an entire class and registers every valid row
   by calling StudentsAPI.create() once per student — the exact
   same create path (and duplicate-ID / required-field rules) as
   adding one student by hand via the form above. No new backend
   route, no bypass of existing validation.
   Expected header row: id,name,class,gender
   --------------------------------------------------------- */
const BULK_IMPORT_VALID_CLASSES = ['S.1', 'S.2', 'S.3', 'S.4', 'S.5', 'S.6'];
let bulkImportParsedRows = [];
function openBulkImportModal() {
    if (!getPermissions(currentUser.role).canManageStudents) return; // RBAC guard
    const root = document.getElementById('modal-root');
    if (!root) return;
    bulkImportParsedRows = [];
    root.innerHTML = `
        <div class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4" onclick="if(event.target===this) closeModal()">
            <div class="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto">
                <div class="flex items-center justify-between p-5 border-b border-slate-200 sticky top-0 bg-white rounded-t-2xl">
                    <h3 class="text-sm font-extrabold text-slate-900"><i class="fa-solid fa-file-csv mr-2 text-teal-600"></i>Bulk Import Students</h3>
                    <button onclick="closeModal()" class="text-slate-400 hover:text-slate-600 text-lg px-2">&#10005;</button>
                </div>
                <div class="p-5 space-y-4">
                    <p class="text-xs text-slate-600">Upload a CSV to register an entire class at once. First row must be a header: <code class="bg-slate-100 px-1.5 py-0.5 rounded font-mono">id,name,class,gender</code></p>
                    <button type="button" onclick="downloadBulkImportTemplate()" class="text-[11px] font-extrabold uppercase tracking-wider text-teal-700 hover:text-teal-800"><i class="fa-solid fa-download mr-1"></i>Download Sample CSV Template</button>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">CSV File</label>
                        <input type="file" id="bulk-import-file" accept=".csv,text/csv" onchange="handleBulkImportFile(event)" class="w-full text-xs font-semibold text-slate-700 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-teal-600 file:text-white file:text-xs file:font-extrabold file:uppercase file:cursor-pointer">
                    </div>
                    <div id="bulk-import-preview"></div>
                </div>
            </div>
        </div>
    `;
}
function downloadBulkImportTemplate() {
    const csv = "id,name,class,gender\nLCS/101,Nakato Sarah,S.1,Female\nLCS/102,Mugisha Brian,S.1,Male\n";
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'student_import_template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
function handleBulkImportFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => parseAndPreviewCSV(String(e.target.result || ''));
    reader.onerror = () => {
        const preview = document.getElementById('bulk-import-preview');
        if (preview) preview.innerHTML = `<p class="text-xs font-bold text-rose-600">Could not read that file. Please try again.</p>`;
    };
    reader.readAsText(file);
}
// Minimal CSV line splitter — handles simple quoted fields (",") which
// covers names/values that might contain a comma; not a full RFC4180
// parser, but sufficient for the plain id/name/class/gender template.
function splitCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') { inQuotes = !inQuotes; continue; }
        if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
        current += char;
    }
    result.push(current.trim());
    return result;
}
function parseAndPreviewCSV(text) {
    const preview = document.getElementById('bulk-import-preview');
    if (!preview) return;
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length < 2) {
        preview.innerHTML = `<p class="text-xs font-bold text-rose-600">No data rows found. Make sure the file has a header row followed by student rows.</p>`;
        return;
    }
    const header = splitCSVLine(lines[0]).map(h => h.toLowerCase());
    const idIdx = header.indexOf('id');
    const nameIdx = header.indexOf('name');
    const classIdx = header.indexOf('class');
    const genderIdx = header.indexOf('gender');
    if (idIdx === -1 || nameIdx === -1 || classIdx === -1 || genderIdx === -1) {
        preview.innerHTML = `<p class="text-xs font-bold text-rose-600">Header row must contain: id, name, class, gender</p>`;
        return;
    }

    const seenIds = new Set(studentsList.map(s => s.id.toUpperCase()));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = splitCSVLine(lines[i]);
        const id = (cols[idIdx] || '').toUpperCase();
        const name = cols[nameIdx] || '';
        const cls = (cols[classIdx] || '').toUpperCase();
        const genderRaw = (cols[genderIdx] || '').toLowerCase();
        const gender = genderRaw.startsWith('f') ? 'Female' : (genderRaw.startsWith('m') ? 'Male' : '');

        let error = '';
        if (!id) error = 'Missing Student ID';
        else if (!name) error = 'Missing Name';
        else if (!BULK_IMPORT_VALID_CLASSES.includes(cls)) error = `Invalid class "${cols[classIdx] || ''}"`;
        else if (!gender) error = `Invalid gender "${cols[genderIdx] || ''}"`;
        else if (seenIds.has(id)) error = 'Duplicate / already registered ID';

        if (!error) seenIds.add(id); // guards against duplicates within the file itself too
        rows.push({ id, name, class: cls, gender, error });
    }

    bulkImportParsedRows = rows;
    const validCount = rows.filter(r => !r.error).length;
    const invalidCount = rows.length - validCount;

    preview.innerHTML = `
        <div class="flex items-center justify-between">
            <p class="text-xs font-bold text-slate-700">${validCount} ready to import${invalidCount > 0 ? `, ${invalidCount} with errors (skipped)` : ''}.</p>
            <button ${validCount === 0 ? 'disabled' : ''} onclick="confirmBulkImport()" class="bg-teal-600 hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-extrabold uppercase tracking-wider py-2 px-4 rounded-xl transition"><i class="fa-solid fa-upload mr-1.5"></i>Import ${validCount} Student(s)</button>
        </div>
        <div class="mt-3 max-h-64 overflow-y-auto border border-slate-200 rounded-xl">
            <table class="w-full text-xs">
                <thead class="sticky top-0"><tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold"><th class="p-2 text-left">ID</th><th class="p-2 text-left">Name</th><th class="p-2 text-left">Class</th><th class="p-2 text-left">Gender</th><th class="p-2 text-left">Status</th></tr></thead>
                <tbody class="divide-y divide-slate-100">
                    ${rows.map(r => `
                        <tr class="${r.error ? 'bg-rose-50' : ''}">
                            <td class="p-2 font-mono">${escapeHTML(r.id) || '&mdash;'}</td>
                            <td class="p-2">${escapeHTML(r.name) || '&mdash;'}</td>
                            <td class="p-2">${escapeHTML(r.class) || '&mdash;'}</td>
                            <td class="p-2">${escapeHTML(r.gender) || '&mdash;'}</td>
                            <td class="p-2 font-bold ${r.error ? 'text-rose-600' : 'text-emerald-600'}">${r.error ? r.error : 'Ready'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}
async function confirmBulkImport() {
    if (!getPermissions(currentUser.role).canManageStudents) return; // RBAC guard
    const preview = document.getElementById('bulk-import-preview');
    const validRows = bulkImportParsedRows.filter(r => !r.error);
    if (validRows.length === 0) return;
    if (preview) preview.innerHTML = `<p class="text-xs font-bold text-slate-500"><i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Importing ${validRows.length} student(s)&hellip;</p>`;

    let successCount = 0;
    const failures = [];
    // Sequential (not parallel) on purpose: each create() must see the
    // previous one already registered so duplicate-ID checks against a
    // real backend stay accurate, exactly like adding students one by one.
    for (const row of validRows) {
        try {
            await StudentsAPI.create({ id: row.id, name: row.name, class: row.class, gender: row.gender });
            successCount++;
        } catch (err) {
            failures.push(`${row.id}: ${err.message || 'failed to save'}`);
        }
    }

    await refreshStudentsList();
    loadStudentData();
    updateDashboardStats();

    if (preview) {
        preview.innerHTML = `
            <div class="text-xs font-bold ${failures.length === 0 ? 'text-emerald-700' : 'text-amber-700'}">
                Imported ${successCount} of ${validRows.length} student(s) successfully.
            </div>
            ${failures.length > 0 ? `<ul class="mt-2 text-[11px] text-rose-600 list-disc list-inside space-y-0.5">${failures.map(f => `<li>${escapeHTML(f)}</li>`).join('')}</ul>` : ''}
            <button onclick="closeModal()" class="mt-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-extrabold uppercase py-2 px-4 rounded-xl transition">Close</button>
        `;
    }
}
async function handleAddStudent(event) {
    event.preventDefault();
    if (!getPermissions(currentUser.role).canManageStudents) return; // RBAC guard
    const newStudent = {
        id: document.getElementById('stud-id').value.trim().toUpperCase(),
        name: document.getElementById('stud-name').value.trim(),
        class: document.getElementById('stud-class').value,
        gender: document.getElementById('stud-gender').value
    };
    if (newStudent.id === '' || newStudent.name === '') {
        alert('Please provide both a Student ID and a Full Name.');
        return;
    }
    if (studentsList.some(s => s.id.toUpperCase() === newStudent.id)) {
        alert(`Student ID "${newStudent.id}" is already registered. Please use a unique ID.`);
        return;
    }
    try {
        await StudentsAPI.create(newStudent);
    } catch (err) {
        alert(err.message || 'Could not save this student. Please try again.');
        return;
    }
    await refreshStudentsList();
    loadStudentData();
    toggleStudentForm();
    document.getElementById('stud-id').value = "";
    document.getElementById('stud-name').value = "";
    updateDashboardStats();
}
async function deleteStudent(studentId) {
    if (!getPermissions(currentUser.role).canManageStudents) return; // RBAC guard
    if (!confirm("Are you sure you want to remove this student record?")) return;
    try {
        await StudentsAPI.remove(studentId);
    } catch (err) {
        alert(err.message || 'Could not delete this student. Please try again.');
        return;
    }
    await refreshStudentsList();
    loadStudentData();
    updateDashboardStats();
}
/* ---------------------------------------------------------
   5. SCORE SHEETS MODULE (Light Theme)
   --------------------------------------------------------- */
function renderScoresModule() {
    return `
        <div class="space-y-6">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                <div class="flex flex-wrap items-center gap-4">
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Select Class Level</label>
                        <select id="score-class-select" onchange="onClassLevelChange()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-extrabold text-slate-700 focus:ring-1 focus:ring-teal-500">
                            <optgroup label="O-Level (S.1 - S.4)">
                                <option value="S.1">S.1</option>
                                <option value="S.2">S.2</option>
                                <option value="S.3">S.3</option>
                                <option value="S.4">S.4</option>
                            </optgroup>
                            <optgroup label="A-Level (S.5 - S.6)">
                                <option value="S.5">S.5</option>
                                <option value="S.6">S.6</option>
                            </optgroup>
                        </select>
                    </div>
                    <div class="flex items-end gap-2">
                        <div>
                            <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Subject</label>
                            <select id="score-subject-select" onchange="loadScoreSheetData()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700"></select>
                        </div>
                        <button onclick="loadNextSubject()" class="bg-slate-100 hover:bg-slate-200 text-teal-700 text-xs font-extrabold uppercase py-2.5 px-3 rounded-xl border border-slate-300 transition"><i class="fa-solid fa-forward mr-1.5"></i>Next Subject</button>
                    </div>
                </div>
                <button onclick="saveMarksEntry(this)" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-floppy-disk mr-1.5"></i>Save Marks Entry</button>
            </div>
            <div class="overflow-x-auto bg-white border border-slate-200 rounded-2xl shadow-xs">
                <table class="w-full text-left border-collapse">
                    <thead id="score-table-head"></thead>
                    <tbody id="score-table-body" class="divide-y divide-slate-100 text-xs text-slate-700"></tbody>
                </table>
            </div>
        </div>
    `;
}
function onClassLevelChange() {
    updateSubjectDropdown();
    loadScoreSheetData();
}
function updateSubjectDropdown() {
    const classSelect = document.getElementById('score-class-select');
    const subjectSelect = document.getElementById('score-subject-select');
    if (!classSelect || !subjectSelect) return;
    const selectedClass = classSelect.value;
    const isALevel = (selectedClass === 'S.5' || selectedClass === 'S.6');
    const activeSubjects = isALevel ? aLevelSubjects : oLevelSubjects;
    subjectSelect.innerHTML = activeSubjects.map(sub => `<option value="${sub}">${sub}</option>`).join('');
}
function loadNextSubject() {
    const subjectSelect = document.getElementById('score-subject-select');
    if (!subjectSelect || subjectSelect.options.length === 0) return;
    subjectSelect.selectedIndex = (subjectSelect.selectedIndex + 1) % subjectSelect.options.length;
    loadScoreSheetData();
}
function loadScoreSheetData() {
    const thead = document.getElementById('score-table-head');
    const tbody = document.getElementById('score-table-body');
    const classSelect = document.getElementById('score-class-select');
    const subjectSelect = document.getElementById('score-subject-select');
    
    if (!thead || !tbody || !classSelect) return;
    const selectedClass = classSelect.value;
    const isALevel = (selectedClass === 'S.5' || selectedClass === 'S.6');
    
    if (subjectSelect && subjectSelect.options.length === 0) {
        updateSubjectDropdown();
    }
    
    const selectedSubject = subjectSelect ? subjectSelect.value : (isALevel ? aLevelSubjects[0] : oLevelSubjects[0]);
    const isSubsidiary = subsidiarySubjects.includes(selectedSubject.toUpperCase());
    
    tbody.innerHTML = "";
    thead.innerHTML = isALevel ? buildALevelHeader() : buildOLevelHeader();
    
    const classStudents = studentsList.filter(s => s.class === selectedClass);
    updateDashboardStats();
    
    if (classStudents.length === 0) {
        const colSpan = isALevel ? 9 : 11;
        tbody.innerHTML = `<tr><td colspan="${colSpan}" class="p-8 text-center text-slate-400 text-xs font-medium">No students registered in ${selectedClass} yet. Add them in the Students tab first.</td></tr>`;
        return;
    }
    
    classStudents.forEach(student => {
        const recordKey = `${selectedSubject}_${student.id}`;
        tbody.innerHTML += isALevel ? buildALevelRow(student, recordKey, isSubsidiary) : buildOLevelRow(student, recordKey);
    });
}
function buildALevelHeader() {
    return `
        <tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider border-b border-slate-200">
            <th class="p-4 score-sticky-col-1">Student ID</th>
            <th class="p-4 score-sticky-col-2">Student Name</th>
            <th class="p-4 text-center">Paper 1 (100)</th>
            <th class="p-4 text-center">Paper 2 (100)</th>
            <th class="p-4 text-center">Average</th>
            <th class="p-4 text-center">Grade</th>
            <th class="p-4 text-center">Descriptor</th>
            <th class="p-4 text-center">Points</th>
            <th class="p-4">Remarks</th>
        </tr>
    `;
}
function buildOLevelHeader() {
    return `
        <tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider border-b border-slate-200">
            <th class="p-4 score-sticky-col-1">Student ID</th>
            <th class="p-4 score-sticky-col-2">Full Name</th>
            <th class="p-4 text-center">AO1 (3.0)</th>
            <th class="p-4 text-center">AO2 (3.0)</th>
            <th class="p-4 text-center">Av. Score</th>
            <th class="p-4 text-center">F.A (20)</th>
            <th class="p-4 text-center">E.O.T (80)</th>
            <th class="p-4 text-center">Final (100)</th>
            <th class="p-4 text-center">Grade</th>
            <th class="p-4 text-center">Descriptor</th>
            <th class="p-4">TR's Initial</th>
        </tr>
    `;
}
function buildALevelRow(student, recordKey, isSubsidiary) {
    // IMPORTANT: do NOT persist a default record just because this row was rendered.
    // A subject must only be considered "recorded" once the teacher actually types a mark
    // (see updateALevelMarks, which sets `touched: true`). Otherwise merely opening a
    // subject in the dropdown would make it falsely appear on every student's report card.
    const marks = marksStorage[recordKey] || { p1: 0, p2: 0 };
    const attemptedPapers = [Number(marks.p1), Number(marks.p2)].filter(p => p > 0);
    const avgMark = attemptedPapers.length > 0 ? Math.round(attemptedPapers.reduce((sum, p) => sum + p, 0) / attemptedPapers.length) : 0;
    const gradeInfo = computeALevelGrade(avgMark, isSubsidiary);
    
    return `
        <tr class="hover:bg-slate-50 transition${unsavedScoreRows.has(recordKey) ? ' score-save-error' : ''}" data-student-id="${student.id}">
            <td class="p-4 font-mono text-xs font-bold text-teal-700 score-sticky-col-1">${student.id}</td>
            <td class="p-4 font-bold text-slate-900 score-sticky-col-2">${student.name}</td>
            <td class="p-4 text-center"><input type="number" min="0" max="100" value="${marks.p1 || ''}" placeholder="0" onchange="updateALevelMarks('${student.id}', 'p1', this.value, this)" class="w-16 p-1.5 text-center bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800"></td>
            <td class="p-4 text-center"><input type="number" min="0" max="100" value="${marks.p2 || ''}" placeholder="0" onchange="updateALevelMarks('${student.id}', 'p2', this.value, this)" class="w-16 p-1.5 text-center bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800"></td>
            <td id="total-${student.id}" class="p-4 text-center font-extrabold text-slate-800">${avgMark}</td>
            <td id="grade-${student.id}" class="p-4 text-center font-extrabold text-teal-700">${gradeInfo.grade}</td>
            <td id="descriptor-${student.id}" class="p-4 text-center text-xs font-bold text-slate-500">${gradeInfo.descriptor}</td>
            <td id="points-${student.id}" class="p-4 text-center text-xs font-extrabold text-slate-500">${gradeInfo.points}</td>
            <td class="p-4"><input type="text" value="${marks.remarks || ''}" placeholder="Teacher's remark" onchange="updateALevelRemarks('${student.id}', this.value)" class="w-40 p-1.5 bg-slate-50 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700"></td>
        </tr>
    `;
}
function buildOLevelRow(student, recordKey) {
    // Same principle as buildALevelRow: rendering a row must never write a phantom
    // zero-mark record into storage. Only an actual teacher edit (updateMarks) does that.
    const marks = marksStorage[recordKey] || { ao1: 0, ao2: 0, eot: 0 };
    const avScore = calculateAOAverage(marks.ao1, marks.ao2).toFixed(1);
    const faScore = ((avScore / 3.0) * 20).toFixed(1);
    const finalTotal = Math.round(Number(faScore) + Number(marks.eot));
    const gradeData = computeOfficialGrade(finalTotal);
    
    return `
        <tr class="hover:bg-slate-50 transition${unsavedScoreRows.has(recordKey) ? ' score-save-error' : ''}" data-student-id="${student.id}">
            <td class="p-4 font-mono text-xs font-bold text-teal-700 score-sticky-col-1">${student.id}</td>
            <td class="p-4 font-bold text-slate-900 score-sticky-col-2">${student.name}</td>
            <td class="p-4 text-center"><input type="number" step="0.1" min="0" max="3" value="${formatAOScoreDisplay(marks.ao1, '')}" placeholder="0" onchange="updateMarks('${student.id}', 'ao1', this.value, this)" class="w-16 p-1.5 text-center bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800"></td>
            <td class="p-4 text-center"><input type="number" step="0.1" min="0" max="3" value="${formatAOScoreDisplay(marks.ao2, '')}" placeholder="0" onchange="updateMarks('${student.id}', 'ao2', this.value, this)" class="w-16 p-1.5 text-center bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800"></td>
            <td id="av-${student.id}" class="p-4 text-center text-xs font-bold text-slate-500">${avScore}</td>
            <td id="fa-${student.id}" class="p-4 text-center text-xs font-bold text-slate-500">${faScore}</td>
            <td class="p-4 text-center"><input type="number" min="0" max="80" value="${formatWholeScoreDisplay(marks.eot, '')}" placeholder="0" onchange="updateMarks('${student.id}', 'eot', this.value, this)" class="w-16 p-1.5 text-center bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800"></td>
            <td id="total-${student.id}" class="p-4 text-center font-extrabold text-slate-800">${finalTotal}</td>
            <td id="grade-${student.id}" class="p-4 text-center font-extrabold text-teal-700">${gradeData.grade}</td>
            <td id="descriptor-${student.id}" class="p-4 text-center text-xs font-bold text-slate-500">${gradeData.descriptor}</td>
            <td class="p-4"><input type="text" maxlength="4" value="${marks.remarks || ''}" placeholder="e.g. AR" onchange="updateOLevelRemarks('${student.id}', this.value)" class="w-16 p-1.5 text-center bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold uppercase text-slate-800"></td>
        </tr>
    `;
}
const O_LEVEL_FIELD_LIMITS = { ao1: [0, 3], ao2: [0, 3], eot: [0, 80] };
function clampValue(rawValue, min, max) {
    let val = Number(rawValue);
    if (isNaN(val)) val = min;
    return Math.min(max, Math.max(min, val));
}
/* ---------------------------------------------------------
   5b. SCORE SAVE-STATUS TRACKING
   ScoresAPI.save() used to be fired with `.catch(() => {})`, so a
   rejected save (expired session, 403, 404 student-not-found,
   network blip) was invisible: the UI already showed the typed
   value optimistically, and the failed record just wasn't in the
   database — so it vanished the moment the page reloaded and
   marksStorage was rebuilt purely from GET /api/scores.
   These helpers make that failure visible and stop a refresh from
   silently discarding a mark that hasn't actually saved yet.
   --------------------------------------------------------- */
const unsavedScoreRows = new Set(); // recordKeys ("SUBJECT_studentId") with a pending or failed save
let sessionExpiredNoticeShown = false;
function showToast(message, type = 'error', duration = 7000) {
    let container = document.getElementById('app-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'app-toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `app-toast app-toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}
// recordKey is "SUBJECT_studentId"; the student id is always the segment
// after the last underscore (mirrors the parsing ScoresAPI.save uses).
function studentIdFromRecordKey(recordKey) {
    return recordKey.split('_').pop();
}
function markRowSaveState(recordKey, ok) {
    const studId = studentIdFromRecordKey(recordKey);
    const row = document.querySelector(`tr[data-student-id="${CSS.escape(studId)}"]`);
    if (ok) {
        unsavedScoreRows.delete(recordKey);
        if (row) { row.classList.remove('score-save-error'); row.removeAttribute('title'); }
    } else {
        unsavedScoreRows.add(recordKey);
        if (row) { row.classList.add('score-save-error'); row.title = 'This row failed to save to the server. It will be lost if you refresh or close the tab before it saves successfully.'; }
    }
}
let backendUnreachableNoticeShown = false;
function handleScoreSaveError(err, recordKey) {
    const studId = studentIdFromRecordKey(recordKey);
    markRowSaveState(recordKey, false);
    if (err && err.isNetworkFailure) {
        // The backend itself couldn't be reached at all (not deployed, wrong
        // API_CONFIG.BASE_URL, CORS not enabled for this origin, no internet).
        // Every save will fail the same way until that's fixed, so warn once
        // instead of once per keystroke.
        if (!backendUnreachableNoticeShown) {
            backendUnreachableNoticeShown = true;
            showToast("Can't reach the school server at all. Marks are only staying in this browser tab and WILL be lost on refresh — check your internet connection, or ask whoever manages the system to confirm the backend is deployed and reachable.", 'error', 12000);
        }
        return;
    }
    if (err && err.status === 401) {
        // Session is dead — every subsequent save will fail the same way,
        // so warn once (not per keystroke) and offer to log back in rather
        // than let the teacher keep typing marks that can never be saved.
        if (!sessionExpiredNoticeShown) {
            sessionExpiredNoticeShown = true;
            showToast('Your session has expired. Marks entered from now on will NOT be saved until you log in again.', 'error', 10000);
            setTimeout(() => {
                if (confirm('Your session has expired, so new marks cannot be saved to the server. Log in again now? (Any unsaved rows are highlighted in red.)')) {
                    handleLogout();
                }
            }, 200);
        }
        return;
    }
    if (err && err.status === 404) {
        showToast(`Could not save marks for ${studId}: this student wasn't found on the server (they may only exist locally). Re-check them in the Students tab.`, 'error');
        return;
    }
    if (err && err.status === 403) {
        showToast(`Could not save marks for ${studId}: you don't have permission to edit scores.`, 'error');
        return;
    }
    const detail = err && err.message ? ` (${err.message})` : '';
    showToast(`Could not save marks for ${studId} to the server${detail}. It's highlighted in red and will be lost if you refresh before it saves.`, 'error');
}
// Re-attempts every currently-failed/pending save, across every subject —
// not just whichever subject happens to be on screen right now. Used by
// the "Save Marks Entry" button so it reports what's actually true instead
// of an unconditional success message.
async function retryUnsavedScores() {
    const classLevel = document.getElementById('score-class-select')?.value;
    const keysToRetry = Array.from(unsavedScoreRows);
    await Promise.allSettled(keysToRetry.map(recordKey => {
        const marks = marksStorage[recordKey];
        if (!marks) { unsavedScoreRows.delete(recordKey); return Promise.resolve(); }
        return ScoresAPI.save(recordKey, marks, classLevel)
            .then(() => markRowSaveState(recordKey, true))
            .catch(err => handleScoreSaveError(err, recordKey));
    }));
    return unsavedScoreRows.size;
}
// Handler for the "Save Marks Entry" button. Marks already save per-cell
// as you type (see updateMarks etc.) — this button's only real job is to
// report the truth about whether everything actually made it to the
// server, and to give failed rows one more chance before you leave.
async function saveMarksEntry(buttonEl) {
    if (buttonEl) { buttonEl.disabled = true; buttonEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Checking...'; }
    const remaining = await retryUnsavedScores();
    if (buttonEl) { buttonEl.disabled = false; buttonEl.innerHTML = '<i class="fa-solid fa-floppy-disk mr-1.5"></i>Save Marks Entry'; }
    if (remaining === 0) {
        alert('Marks successfully saved to system register!');
    } else {
        alert(`${remaining} row(s) could NOT be saved to the server — they're highlighted in red. Check your connection/session and try again before leaving this page.`);
    }
    updateDashboardStats();
}
// or refresh while a save is still pending or has failed outright.
window.addEventListener('beforeunload', (e) => {
    if (unsavedScoreRows.size > 0) {
        e.preventDefault();
        e.returnValue = '';
        return '';
    }
});
function updateMarks(studId, type, value, inputEl) {
    if (!getPermissions(currentUser.role).canManageScores) return; // RBAC guard
    const subjectSelect = document.getElementById('score-subject-select');
    const selectedSubject = subjectSelect ? subjectSelect.value : "GENERAL";
    const recordKey = `${selectedSubject}_${studId}`;
    if (!marksStorage[recordKey]) marksStorage[recordKey] = { ao1: 0, ao2: 0, eot: 0 };
    const [min, max] = O_LEVEL_FIELD_LIMITS[type] || [0, 100];
    const cleanValue = clampValue(value, min, max);
    marksStorage[recordKey][type] = cleanValue;
    marksStorage[recordKey].touched = true;
    if (inputEl) inputEl.value = cleanValue;
    
    const marks = marksStorage[recordKey];
    const avScore = calculateAOAverage(marks.ao1, marks.ao2).toFixed(1);
    const faScore = ((avScore / 3.0) * 20).toFixed(1);
    const finalTotal = Math.round(Number(faScore) + marks.eot);
    const gradeData = computeOfficialGrade(finalTotal);
    
    document.getElementById(`av-${studId}`).innerText = avScore;
    document.getElementById(`fa-${studId}`).innerText = faScore;
    document.getElementById(`total-${studId}`).innerText = finalTotal;
    document.getElementById(`grade-${studId}`).innerText = gradeData.grade;
    document.getElementById(`descriptor-${studId}`).innerText = gradeData.descriptor;
    unsavedScoreRows.add(recordKey); // pending until the save below resolves — guards against a refresh mid-flight
    ScoresAPI.save(recordKey, marks, document.getElementById('score-class-select')?.value)
        .then(() => markRowSaveState(recordKey, true))
        .catch(err => handleScoreSaveError(err, recordKey)); // UI already updated optimistically above; this surfaces real save failures instead of hiding them
    updateDashboardStats();
}
function updateALevelMarks(studId, type, value, inputEl) {
    if (!getPermissions(currentUser.role).canManageScores) return; // RBAC guard
    const subjectSelect = document.getElementById('score-subject-select');
    const selectedSubject = subjectSelect ? subjectSelect.value : "GENERAL";
    const recordKey = `${selectedSubject}_${studId}`;
    if (!marksStorage[recordKey]) marksStorage[recordKey] = { p1: 0, p2: 0 };
    const cleanValue = clampValue(value, 0, 100);
    marksStorage[recordKey][type] = cleanValue;
    marksStorage[recordKey].touched = true;
    if (inputEl) inputEl.value = cleanValue;
    
    const marks = marksStorage[recordKey];
    const attemptedPapers = [Number(marks.p1), Number(marks.p2)].filter(p => p > 0);
    const avgMark = attemptedPapers.length > 0 ? Math.round(attemptedPapers.reduce((sum, p) => sum + p, 0) / attemptedPapers.length) : 0;
    const isSubsidiary = subsidiarySubjects.includes(selectedSubject.toUpperCase());
    const gradeInfo = computeALevelGrade(avgMark, isSubsidiary);
    
    document.getElementById(`total-${studId}`).innerText = avgMark;
    document.getElementById(`grade-${studId}`).innerText = gradeInfo.grade;
    document.getElementById(`descriptor-${studId}`).innerText = gradeInfo.descriptor;
    document.getElementById(`points-${studId}`).innerText = gradeInfo.points;
    unsavedScoreRows.add(recordKey); // pending until the save below resolves — guards against a refresh mid-flight
    ScoresAPI.save(recordKey, marks, document.getElementById('score-class-select')?.value)
        .then(() => markRowSaveState(recordKey, true))
        .catch(err => handleScoreSaveError(err, recordKey)); // UI already updated optimistically above; this surfaces real save failures instead of hiding them
    updateDashboardStats();
}
function updateOLevelRemarks(studId, value) {
    if (!getPermissions(currentUser.role).canManageScores) return; // RBAC guard
    const subjectSelect = document.getElementById('score-subject-select');
    const selectedSubject = subjectSelect ? subjectSelect.value : "GENERAL";
    const recordKey = `${selectedSubject}_${studId}`;
    if (!marksStorage[recordKey]) marksStorage[recordKey] = { ao1: 0, ao2: 0, eot: 0 };
    marksStorage[recordKey].remarks = value.trim();
    if (marksStorage[recordKey].remarks !== '') marksStorage[recordKey].touched = true;
    unsavedScoreRows.add(recordKey);
    ScoresAPI.save(recordKey, marksStorage[recordKey], document.getElementById('score-class-select')?.value)
        .then(() => markRowSaveState(recordKey, true))
        .catch(err => handleScoreSaveError(err, recordKey));
}
function updateALevelRemarks(studId, value) {
    if (!getPermissions(currentUser.role).canManageScores) return; // RBAC guard
    const subjectSelect = document.getElementById('score-subject-select');
    const selectedSubject = subjectSelect ? subjectSelect.value : "GENERAL";
    const recordKey = `${selectedSubject}_${studId}`;
    if (!marksStorage[recordKey]) marksStorage[recordKey] = { p1: 0, p2: 0 };
    marksStorage[recordKey].remarks = value.trim();
    if (marksStorage[recordKey].remarks !== '') marksStorage[recordKey].touched = true;
    unsavedScoreRows.add(recordKey);
    ScoresAPI.save(recordKey, marksStorage[recordKey], document.getElementById('score-class-select')?.value)
        .then(() => markRowSaveState(recordKey, true))
        .catch(err => handleScoreSaveError(err, recordKey));
}
/* ---------------------------------------------------------
   6. GRADING LOGIC
   --------------------------------------------------------- */
function computeOfficialGrade(score) {
    if (score >= 75) return { grade: 'A', descriptor: 'EXCEPTIONAL' };
    if (score >= 65) return { grade: 'B', descriptor: 'OUTSTANDING' };
    if (score >= 55) return { grade: 'C', descriptor: 'SATISFACTORY' };
    if (score >= 45) return { grade: 'D', descriptor: 'BASIC' };
    return { grade: 'E', descriptor: 'ELEMENTARY' };
}
function computeALevelGrade(score, isSubsidiary) {
    let grade, descriptor, points;
    if (score >= 80) { grade = "A"; descriptor = "EXCEPTIONAL"; points = isSubsidiary ? 1 : 5; }
    else if (score >= 70) { grade = "B"; descriptor = "OUTSTANDING"; points = isSubsidiary ? 1 : 4; }
    else if (score >= 60) { grade = "C"; descriptor = "SATISFACTORY"; points = isSubsidiary ? 1 : 3; }
    else if (score >= 50) { grade = "D"; descriptor = "BASIC"; points = isSubsidiary ? 1 : 2; }
    else { grade = "E"; descriptor = "ELEMENTARY"; points = isSubsidiary ? 0 : 1; }
    return { grade, descriptor, points };
}
/* ---------------------------------------------------------
   6b. REPORT CARD ENGINE (A-Level)
   --------------------------------------------------------- */
function renderReportsModule() {
    if (currentUser.role === 'Student') return renderOwnReportModule();
    // Pull defaults from the persisted term settings (not a fresh blank state)
    // so the upcoming term dates the school already set are always shown,
    // even after switching tabs or regenerating report cards.
    const t = termSettings;
    const canEditTerm = getPermissions(currentUser.role).canManageTerm;
    const termLock = canEditTerm ? '' : 'disabled';
    return `
        <div class="space-y-6">
            <div class="bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                ${!canEditTerm ? `<p class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3">Academic calendar dates are managed by the Administrator &middot; view only</p>` : ''}
                <div class="flex flex-wrap items-end gap-4">
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Class Level</label>
                        <select id="report-class-select" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-extrabold text-slate-700">
                            <optgroup label="O-Level (S.1 - S.4)">
                                <option value="S.1">S.1</option>
                                <option value="S.2">S.2</option>
                                <option value="S.3">S.3</option>
                                <option value="S.4">S.4</option>
                            </optgroup>
                            <optgroup label="A-Level (S.5 - S.6)">
                                <option value="S.5" selected>S.5</option>
                                <option value="S.6">S.6</option>
                            </optgroup>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Term</label>
                        <select id="report-term-select" ${termLock} onchange="updateTermSetting('term', this.value)" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                            <option value="Term 1" ${t.term === 'Term 1' ? 'selected' : ''}>Term 1</option>
                            <option value="Term 2" ${t.term === 'Term 2' ? 'selected' : ''}>Term 2</option>
                            <option value="Term 3" ${t.term === 'Term 3' ? 'selected' : ''}>Term 3</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Year</label>
                        <input type="number" id="report-year-input" ${termLock} value="${t.year}" onchange="updateTermSetting('year', this.value)" class="w-24 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Next Term Begins</label>
                        <input type="date" id="report-next-begins" ${termLock} value="${t.nextBegins}" onchange="updateTermSetting('nextBegins', this.value)" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Ends On</label>
                        <input type="date" id="report-next-ends" ${termLock} value="${t.nextEnds}" onchange="updateTermSetting('nextEnds', this.value)" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                    </div>
                    <div class="flex gap-2 ml-auto">
                        <button onclick="toggleGradingLegendPreview()" class="bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition"><i class="fa-solid fa-table-list mr-1.5"></i>Grading Scale</button>
                        <button onclick="generateReportCards()" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-file-circle-plus mr-1.5"></i>Generate Report Cards</button>
                        <button onclick="printReportCards()" style="background:var(--navy-900);" class="hover:opacity-90 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-print mr-1.5"></i>Print / Save PDF (Whole Class)</button>
                    </div>
                </div>
                <div id="grading-legend-preview" class="hidden mt-4 pt-4 border-t border-slate-200"></div>
            </div>
            <div id="report-cards-preview" class="space-y-4"></div>
        </div>
    `;
}
// Read-only preview of the grading scale used on every report card — lets
// an admin/teacher check the scale up front without generating a full
// class of report cards first. Mirrors (does not recompute) the thresholds
// already used by computeOfficialGrade() and computeALevelGrade().
function toggleGradingLegendPreview() {
    const panel = document.getElementById('grading-legend-preview');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    if (isHidden) {
        panel.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">O-Level Grading Scale (S.1&ndash;S.4)</h4>
                    <table class="w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
                        <thead><tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold"><th class="p-2 text-left">Score</th><th class="p-2 text-left">Grade</th><th class="p-2 text-left">Descriptor</th></tr></thead>
                        <tbody class="divide-y divide-slate-100">
                            <tr><td class="p-2">75&ndash;100</td><td class="p-2 font-bold">A</td><td class="p-2">Exceptional</td></tr>
                            <tr><td class="p-2">65&ndash;74</td><td class="p-2 font-bold">B</td><td class="p-2">Outstanding</td></tr>
                            <tr><td class="p-2">55&ndash;64</td><td class="p-2 font-bold">C</td><td class="p-2">Satisfactory</td></tr>
                            <tr><td class="p-2">45&ndash;54</td><td class="p-2 font-bold">D</td><td class="p-2">Basic</td></tr>
                            <tr><td class="p-2">0&ndash;44</td><td class="p-2 font-bold">E</td><td class="p-2">Elementary</td></tr>
                        </tbody>
                    </table>
                </div>
                <div>
                    <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">A-Level Grading Scale (S.5&ndash;S.6)</h4>
                    <table class="w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
                        <thead><tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold"><th class="p-2 text-left">Score</th><th class="p-2 text-left">Grade</th><th class="p-2 text-left">Principal Pts</th><th class="p-2 text-left">Subsidiary Pts</th></tr></thead>
                        <tbody class="divide-y divide-slate-100">
                            <tr><td class="p-2">80+</td><td class="p-2 font-bold">A</td><td class="p-2">5</td><td class="p-2">1</td></tr>
                            <tr><td class="p-2">70&ndash;79</td><td class="p-2 font-bold">B</td><td class="p-2">4</td><td class="p-2">1</td></tr>
                            <tr><td class="p-2">60&ndash;69</td><td class="p-2 font-bold">C</td><td class="p-2">3</td><td class="p-2">1</td></tr>
                            <tr><td class="p-2">50&ndash;59</td><td class="p-2 font-bold">D</td><td class="p-2">2</td><td class="p-2">1</td></tr>
                            <tr><td class="p-2">0&ndash;49</td><td class="p-2 font-bold">E</td><td class="p-2">1</td><td class="p-2">0</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }
    panel.classList.toggle('hidden');
}
function updateTermSetting(key, value) {
    if (!getPermissions(currentUser.role).canManageTerm) return; // RBAC guard: Administrator only
    termSettings[key] = value;
    TermAPI.save(termSettings).catch(() => {});
}
/* ---------------------------------------------------------
   6a2. STUDENT SELF-SERVICE REPORT VIEW
   A Student's Reports tab is locked to their own record only —
   no class picker, no access to any other learner's data.
   --------------------------------------------------------- */
function renderOwnReportModule() {
    const student = studentsList.find(s => s.id.toLowerCase() === (currentUser.studentId || currentUser.username).toLowerCase());
    if (!student) {
        return `<div class="bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-400 text-sm font-semibold">
            No student record is linked to the username "${currentUser.username}". Ask your Administrator to check your account.
        </div>`;
    }
    const isALevel = (student.class === 'S.5' || student.class === 'S.6');
    const t = termSettings;
    const page = isALevel
        ? buildALevelReportPage(student, t.term, t.year, t.nextBegins, t.nextEnds, false)
        : buildOLevelReportPage(student, t.term, t.year, t.nextBegins, t.nextEnds, false);
    return `
        <div class="space-y-6">
            <div class="bg-white border border-slate-200 p-5 rounded-2xl shadow-xs flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <p class="text-xs font-semibold text-slate-500">Showing <span class="font-extrabold text-slate-700">${t.term}, ${t.year}</span> for ${student.name} (${student.id}). Only you can view this report.</p>
                <button onclick="printOwnReportCard()" style="background:var(--navy-900);" class="hover:opacity-90 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-print mr-1.5"></i>Print / Save PDF</button>
            </div>
            <div id="own-report-preview">${page}</div>
        </div>
    `;
}
function printOwnReportCard() {
    const previewArea = document.getElementById('own-report-preview');
    const printArea = document.getElementById('print-area');
    if (!previewArea || !printArea) return;
    printArea.innerHTML = previewArea.innerHTML;
    window.print();
}
async function generateReportCards() {
    if (!getPermissions(currentUser.role).canViewAllReports) return; // RBAC guard
    const classSelect = document.getElementById('report-class-select');
    const termSelect = document.getElementById('report-term-select');
    const yearInput = document.getElementById('report-year-input');
    const beginsInput = document.getElementById('report-next-begins');
    const endsInput = document.getElementById('report-next-ends');
    const previewArea = document.getElementById('report-cards-preview');
    if (!classSelect || !previewArea) return;

    const selectedClass = classSelect.value;
    const isALevel = (selectedClass === 'S.5' || selectedClass === 'S.6');
    const term = termSelect ? termSelect.value : termSettings.term;
    const year = yearInput ? yearInput.value : termSettings.year;
    const nextBegins = beginsInput ? beginsInput.value : termSettings.nextBegins;
    const nextEnds = endsInput ? endsInput.value : termSettings.nextEnds;

    // Keep the persisted term settings in sync with whatever is on screen,
    // so these values are correctly pulled into the report card even if the
    // Reports tab was re-rendered (e.g. via printReportCards) since they were set.
    termSettings = { term, year, nextBegins, nextEnds };

    const classStudents = studentsList.filter(s => s.class === selectedClass);
    if (classStudents.length === 0) {
        previewArea.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-400 text-sm font-semibold">No students registered in ${selectedClass} yet. Add them in the Students tab first.</div>`;
        return;
    }

    // The attendance % on each report card needs each student's full
    // history, but the login-time hydration only covers a recent rolling
    // window (see refreshAttendanceList) so the app isn't pulling the
    // entire school's attendance history on every login. Fetch full
    // history for just this class's roster, on demand, right before
    // rendering their reports.
    previewArea.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-400 text-sm font-semibold">Loading attendance history for ${selectedClass}&hellip;</div>`;
    await Promise.all(classStudents.map(s => refreshAttendanceForStudent(s.id)));

    previewArea.innerHTML = classStudents.map(student =>
        isALevel
            ? buildALevelReportPage(student, term, year, nextBegins, nextEnds)
            : buildOLevelReportPage(student, term, year, nextBegins, nextEnds)
    ).join('');
}
/* ---------------------------------------------------------
   6c. REPORT CARD SHARED HELPERS
   A subject only counts as "recorded" when marksStorage[key].touched
   is true — i.e. the teacher actually entered a mark or remark for it.
   This is what makes a subject automatically appear on (or stay off)
   a student's report card the moment real data is entered.
   --------------------------------------------------------- */
function getALevelSubjectRecords(student) {
    return aLevelSubjects
        .filter(subj => {
            const m = marksStorage[`${subj}_${student.id}`];
            return m && m.touched;
        })
        .map(subj => {
            const recordKey = `${subj}_${student.id}`;
            const marks = marksStorage[recordKey];
            const isSubsidiary = subsidiarySubjects.includes(subj.toUpperCase());
            const attemptedPapers = [Number(marks.p1), Number(marks.p2)].filter(p => p > 0);
            const avgMark = attemptedPapers.length > 0 ? Math.round(attemptedPapers.reduce((sum, p) => sum + p, 0) / attemptedPapers.length) : 0;
            const gradeInfo = computeALevelGrade(avgMark, isSubsidiary);
            return { subj, isSubsidiary, marks, avgMark, gradeInfo };
        });
}
function getOLevelSubjectRecords(student) {
    return oLevelSubjects
        .filter(subj => {
            const m = marksStorage[`${subj}_${student.id}`];
            return m && m.touched;
        })
        .map(subj => {
            const recordKey = `${subj}_${student.id}`;
            const marks = marksStorage[recordKey];
            const avScore = calculateAOAverage(marks.ao1, marks.ao2);
            const faScore = (avScore / 3.0) * 20;
            const finalTotal = Math.round(faScore + Number(marks.eot));
            const gradeData = computeOfficialGrade(finalTotal);
            return { subj, marks, avScore, faScore, finalTotal, gradeData };
        });
}
function getAttendanceSummary(student) {
    const suffix = `_${student.id}`;
    const records = Object.keys(attendanceStorage)
        .filter(key => key.endsWith(suffix))
        .map(key => attendanceStorage[key]);
    const present = records.filter(r => r === 'Present').length;
    const absent = records.filter(r => r === 'Absent').length;
    const excused = records.filter(r => r === 'Excused').length;
    const total = records.length;
    const pct = total > 0 ? Math.round((present / total) * 100) : null;
    return { present, absent, excused, total, pct };
}
function buildPerformanceRemark(records, isALevel) {
    if (records.length === 0) return "No subject scores have been recorded for this learner yet this term.";
    const avgPercent = isALevel
        ? records.reduce((s, r) => s + r.avgMark, 0) / records.length
        : records.reduce((s, r) => s + r.finalTotal, 0) / records.length;
    const rounded = avgPercent.toFixed(1);
    if (avgPercent >= 75) return `An exceptional term overall, averaging ${rounded}%. The learner consistently demonstrates strong mastery across subjects &mdash; keep nurturing this excellent standard.`;
    if (avgPercent >= 65) return `An outstanding term overall, averaging ${rounded}%. With continued consistency, even higher grades are within reach.`;
    if (avgPercent >= 55) return `A satisfactory term overall, averaging ${rounded}%. Steady, focused revision will help push performance further.`;
    if (avgPercent >= 45) return `A basic level of performance this term, averaging ${rounded}%. Extra effort and support in the weaker subjects is recommended.`;
    return `Performance this term, averaging ${rounded}%, is below the expected standard. Close follow-up and remedial support is strongly recommended.`;
}
// Colour bands mirror each level's own grading scale, so a bar's colour always
// reflects how that specific score was actually graded (A=green ... E=red).
function getPerformanceColor(score, isALevel) {
    const bands = isALevel ? [80, 70, 60, 50] : [75, 65, 55, 45];
    if (score >= bands[0]) return '#1f7a4d'; // A - green
    if (score >= bands[1]) return '#0f8a8f'; // B - teal
    if (score >= bands[2]) return '#c9962c'; // C - amber
    if (score >= bands[3]) return '#e07a2c'; // D - orange
    return '#c23b3b';                        // E - red
}
function buildSubjectBars(records, isALevel) {
    if (records.length === 0) return '<p class="rc-empty-note">No scores recorded yet.</p>';
    return `<div class="rc-bars-grid">${records.map(r => {
        const score = isALevel ? r.avgMark : r.finalTotal;
        const width = Math.max(2, Math.min(100, score));
        const color = getPerformanceColor(score, isALevel);
        return `
        <div class="rc-bar-row">
            <span class="rc-bar-label">${r.subj}</span>
            <span class="rc-bar-track"><span class="rc-bar-fill" style="width:${width}%;background:${color};"></span></span>
            <span class="rc-bar-score" style="color:${color};">${score}</span>
        </div>`;
    }).join('')}</div>`;
}
function buildSummarySection(student, subjectRecords, isALevel) {
    const attendance = getAttendanceSummary(student);
    const remarkText = buildPerformanceRemark(subjectRecords, isALevel);
    const avgScore = subjectRecords.length > 0
        ? (isALevel
            ? subjectRecords.reduce((s, r) => s + r.avgMark, 0) / subjectRecords.length
            : subjectRecords.reduce((s, r) => s + r.finalTotal, 0) / subjectRecords.length)
        : null;
    const bestSubject = subjectRecords.length > 0
        ? subjectRecords.reduce((best, r) => {
            const score = isALevel ? r.avgMark : r.finalTotal;
            const bestScore = isALevel ? best.avgMark : best.finalTotal;
            return score > bestScore ? r : best;
        })
        : null;
    return `
        <div class="rc-summary-section">
            <div class="rc-summary-grid">
                <div class="rc-summary-card">
                    <h4>Term Snapshot</h4>
                    <div class="rc-summary-row"><span>Average Score</span><span>${avgScore !== null ? avgScore.toFixed(1) + '%' : 'N/A'}</span></div>
                    <div class="rc-summary-row"><span>Attendance</span><span>${attendance.total > 0 ? `${attendance.present}/${attendance.total} days (${attendance.pct}%)` : 'Not yet recorded'}</span></div>
                    <div class="rc-summary-row"><span>Best Subject</span><span>${bestSubject ? bestSubject.subj : 'N/A'}</span></div>
                </div>
                <div class="rc-summary-card">
                    <h4>Subject Performance Overview</h4>
                    ${buildSubjectBars(subjectRecords, isALevel)}
                </div>
            </div>
            <div class="rc-remark-box">
                <h4>Performance Overview (System Generated)</h4>
                <p>${remarkText}</p>
            </div>
        </div>
    `;
}
function buildALevelReportPage(student, term, year, nextBegins, nextEnds, editableComments = true) {
    const subjectRecords = getALevelSubjectRecords(student);
    const totalPoints = subjectRecords.reduce((sum, r) => sum + r.gradeInfo.points, 0);

    const rows = subjectRecords.length > 0 ? subjectRecords.map(r => `
        <tr>
            <td class="rc-subj">${r.subj}${r.isSubsidiary ? ' <span class="rc-sub-tag">SUB</span>' : ''}</td>
            <td class="rc-num">${r.marks.p1 || '-'}</td>
            <td class="rc-num">${r.marks.p2 || '-'}</td>
            <td class="rc-num">${r.avgMark}</td>
            <td class="rc-grade">${r.gradeInfo.grade}</td>
            <td class="rc-grade">${r.gradeInfo.grade} (${r.gradeInfo.points} pt${r.gradeInfo.points === 1 ? '' : 's'})</td>
            <td class="rc-descriptor">${r.marks.remarks ? r.marks.remarks : r.gradeInfo.descriptor}</td>
        </tr>
    `).join('') : `<tr><td colspan="7" class="rc-empty">No scores recorded for this learner yet. Enter marks in the Scores tab and they will appear here automatically.</td></tr>`;

    return `
        <div class="report-page report-page-alevel">
            <div class="rc-header-top">
                <img src="school_badge.jpg" class="rc-logo" alt="School Badge">
                <div class="rc-school-info">
                    <h1>LUWEERO COMMUNITY SECONDARY SCHOOL</h1>
                    <p>P.O BOX 29540, KAMPALA-UGANDA</p>
                    <p>TEL: 0772620552 / 0782572120 / 0740773771</p>
                    <p class="rc-motto">&ldquo;BE KNOWN BY DEEDS&rdquo;</p>
                </div>
                <div class="rc-qr-box">PHOTO</div>
            </div>
            <div class="rc-report-title">END OF TERM ACADEMIC REPORT CARD &mdash; A-LEVEL</div>
            <div class="rc-learner-row">
                <div><span>NAME:</span>${student.name}</div>
                <div><span>CLASS:</span><span class="rc-tag">${student.class}</span></div>
                <div><span>TERM:</span><span class="rc-tag">${term}</span></div>
                <div><span>YEAR:</span><span class="rc-tag">${year}</span></div>
                <div><span>STUDENT ID:</span>${student.id}</div>
            </div>
            <table class="rc-table">
                <thead>
                    <tr>
                        <th>Subject</th>
                        <th>P1</th>
                        <th>P2</th>
                        <th>A.S</th>
                        <th>Paper Grade</th>
                        <th>Subject Grade</th>
                        <th>Teacher's Remarks</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            <div class="rc-overall-row">
                <div class="rc-overall-box">
                    <span class="rc-overall-label">Total Points</span>
                    <span class="rc-overall-value">${totalPoints}</span>
                </div>
                <table class="rc-legend-table">
                    <tr class="rc-legend-head"><td>Grade</td><td>A</td><td>B</td><td>C</td><td>D</td><td>E</td></tr>
                    <tr><td>Score Range</td><td>80+</td><td>70&ndash;79</td><td>60&ndash;69</td><td>50&ndash;59</td><td>0&ndash;49</td></tr>
                    <tr><td>Descriptor</td><td>Exceptional</td><td>Outstanding</td><td>Satisfactory</td><td>Basic</td><td>Elementary</td></tr>
                    <tr><td>Points (Principal)</td><td>5</td><td>4</td><td>3</td><td>2</td><td>1</td></tr>
                    <tr><td>Points (Subsidiary)</td><td>1</td><td>1</td><td>1</td><td>1</td><td>0</td></tr>
                </table>
            </div>
            ${buildSummarySection(student, subjectRecords, true)}
            <div class="rc-footer">
                ${buildCommentRow("CLASS TEACHER'S COMMENT", student.id, term, year, 'classTeacherComment', editableComments)}
                <div class="rc-comment-row">
                    <span class="rc-sign">SIGNATURE:</span><span class="rc-sign-line"></span>
                </div>
                ${buildCommentRow("HEADTEACHER'S COMMENT", student.id, term, year, 'headteacherComment', editableComments)}
                <div class="rc-comment-row">
                    <span class="rc-sign">SIGNATURE:</span><span class="rc-sign-line"></span>
                </div>
                <div class="rc-comment-row">
                    <span class="rc-comment-label">NEXT TERM BEGINS:</span>
                    <span class="rc-comment-line">${nextBegins ? formatReportDate(nextBegins) : ''}</span>
                    <span class="rc-comment-label">ENDS ON:</span>
                    <span class="rc-comment-line">${nextEnds ? formatReportDate(nextEnds) : ''}</span>
                </div>
                <div class="rc-legal-row">
                    <span class="rc-motto">&ldquo;BE KNOWN BY DEEDS&rdquo;</span>
                    <span class="rc-print-meta">Printed on ${formatGeneratedTimestamp()} &middot; via Luweero Community SS Management System</span>
                    <span class="rc-stamp-note">NOT VALID WITHOUT STAMP</span>
                </div>
            </div>
        </div>
    `;
}
function getCompetencyDescriptor(grade) {
    switch (grade) {
        case 'A': return "Demonstrates an extraordinary level of competency";
        case 'B': return "Demonstrates a high level of competency";
        case 'C': return "Demonstrates an adequate level of competency";
        case 'D': return "Demonstrates a minimum level of competency";
        default: return "Demonstrates below the basic level of competency";
    }
}
function getOverallIdentifier(avgScore) {
    if (avgScore >= 2.5) return "OUTSTANDING";
    if (avgScore >= 1.5) return "MODERATE";
    return "BASIC";
}
/* ---------------------------------------------------------
   O-LEVEL OVERALL ACHIEVEMENT — tiered by class level.
   S.1/S.2 learners sit 12 subjects; S.3/S.4 learners sit 9.
   Overall Achievement = (sum of every recorded subject's Final
   score) / (tier subject count &times; 100) &times; 3 — i.e.
   divide the total by 1200 for S.1/S.2, or by 900 for S.3/S.4.
   This keeps the result on the same 0&ndash;3 scale the
   BASIC/MODERATE/OUTSTANDING identifiers already use, but now
   reflects the tier's fixed subject load rather than however
   many subjects happen to have marks entered so far.
   --------------------------------------------------------- */
const O_LEVEL_TIER_SUBJECT_COUNTS = { 'S.1': 12, 'S.2': 12, 'S.3': 9, 'S.4': 9 };
function calculateOLevelOverallAchievement(classLevel, subjectRecords) {
    const tierSubjectCount = O_LEVEL_TIER_SUBJECT_COUNTS[classLevel] || 12;
    const denominator = tierSubjectCount * 100; // 1200 for S.1/S.2, 900 for S.3/S.4
    const totalScore = subjectRecords.reduce((sum, r) => sum + r.finalTotal, 0);
    return (totalScore / denominator) * 3;
}
function buildOLevelReportPage(student, term, year, nextBegins, nextEnds, editableComments = true) {
    const subjectRecords = getOLevelSubjectRecords(student);

    const overallAvg = calculateOLevelOverallAchievement(student.class, subjectRecords);
    const overallIdentifier = getOverallIdentifier(overallAvg);

    const rows = subjectRecords.length > 0 ? subjectRecords.map(r => `
        <tr>
            <td class="rc-subj">${r.subj}</td>
            <td class="rc-num">${formatAOScoreDisplay(r.marks.ao1, '-')}</td>
            <td class="rc-num">${formatAOScoreDisplay(r.marks.ao2, '-')}</td>
            <td class="rc-num">${r.avScore.toFixed(1)}</td>
            <td class="rc-num">${r.faScore.toFixed(1)}</td>
            <td class="rc-num">${formatWholeScoreDisplay(r.marks.eot, '-')}</td>
            <td class="rc-final">${r.finalTotal}</td>
            <td class="rc-grade">${r.gradeData.grade}</td>
            <td class="rc-descriptor">${getCompetencyDescriptor(r.gradeData.grade)}</td>
            <td class="rc-num">${r.marks.remarks || ''}</td>
        </tr>
    `).join('') : `<tr><td colspan="10" class="rc-empty">No scores recorded for this learner yet.</td></tr>`;

    return `
        <div class="report-page report-page-olevel">
            <div class="rc-header-top">
                <img src="school_badge.jpg" class="rc-logo" alt="School Badge">
                <div class="rc-school-info">
                    <h1>LUWEERO COMMUNITY SECONDARY SCHOOL</h1>
                    <p>P.O BOX 29540, KAMPALA-UGANDA</p>
                    <p>TEL: 0772620552 / 0782572120 / 0740773771</p>
                    <p class="rc-motto">&ldquo;BE KNOWN BY DEEDS&rdquo;</p>
                </div>
                <div class="rc-qr-box">PHOTO</div>
            </div>
            <div class="rc-report-title">LEARNER'S TERMLY ACHIEVEMENT REPORT</div>
            <div class="rc-learner-row">
                <div><span>LEARNER'S NAME:</span>${student.name}</div>
                <div><span>CLASS:</span><span class="rc-tag">${student.class}</span></div>
                <div><span>TERM:</span><span class="rc-tag">${term}</span></div>
                <div><span>YEAR:</span><span class="rc-tag">${year}</span></div>
                <div><span>STUDENT ID:</span>${student.id}</div>
            </div>
            <table class="rc-table">
                <thead>
                    <tr>
                        <th>Subject</th>
                        <th>AO1</th>
                        <th>AO2</th>
                        <th>Av. Score</th>
                        <th>F.A (20)</th>
                        <th>E.O.T (80)</th>
                        <th>Final (100)</th>
                        <th>Grade</th>
                        <th>Grade Descriptor</th>
                        <th>TR's Initial</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            <div class="rc-overall-row">
                <div class="rc-overall-box">
                    <span class="rc-overall-label">Overall Achievement</span>
                    <span class="rc-overall-value">${overallAvg.toFixed(1)} &mdash; ${overallIdentifier}</span>
                </div>
                <table class="rc-legend-table">
                    <tr class="rc-legend-head"><td>Score</td><td>75-100</td><td>65-74</td><td>55-64</td><td>45-54</td><td>44-0</td></tr>
                    <tr><td>Grade</td><td>A</td><td>B</td><td>C</td><td>D</td><td>E</td></tr>
                </table>
            </div>
            <div class="rc-two-col">
                <table class="rc-mini-table">
                    <tr><th>Identifiers</th><th>Description</th></tr>
                    <tr><td>0 &ndash; 1.4</td><td>Basic</td></tr>
                    <tr><td>1.5 &ndash; 2.4</td><td>Moderate</td></tr>
                    <tr><td>2.5 &ndash; 3.0</td><td>Outstanding</td></tr>
                </table>
                <table class="rc-mini-table">
                    <tr><th>Grade</th><th>Assessment</th></tr>
                    <tr><td>A</td><td>Exceptional</td></tr>
                    <tr><td>B</td><td>Outstanding</td></tr>
                    <tr><td>C</td><td>Satisfactory</td></tr>
                    <tr><td>D</td><td>Basic</td></tr>
                    <tr><td>E</td><td>Elementary</td></tr>
                </table>
            </div>
            ${buildSummarySection(student, subjectRecords, false)}
            <div class="rc-footer">
                ${buildCommentRow("CLASS TEACHER'S COMMENT", student.id, term, year, 'classTeacherComment', editableComments)}
                <div class="rc-comment-row">
                    <span class="rc-sign">SIGNATURE:</span><span class="rc-sign-line"></span>
                </div>
                ${buildCommentRow("HEADTEACHER'S COMMENT", student.id, term, year, 'headteacherComment', editableComments)}
                <div class="rc-comment-row">
                    <span class="rc-sign">SIGNATURE:</span><span class="rc-sign-line"></span>
                </div>
                <div class="rc-comment-row">
                    <span class="rc-comment-label">NEXT TERM BEGINS:</span>
                    <span class="rc-comment-line">${nextBegins ? formatReportDate(nextBegins) : ''}</span>
                    <span class="rc-comment-label">ENDS ON:</span>
                    <span class="rc-comment-line">${nextEnds ? formatReportDate(nextEnds) : ''}</span>
                </div>
                <div class="rc-legal-row">
                    <span>AOI &ndash; Activity of Integration &nbsp;|&nbsp; AS &ndash; Average Score &nbsp;|&nbsp; FA &ndash; Formative Assessment</span>
                    <span class="rc-stamp-note">ONLY VALID WITH A STAMP</span>
                </div>
            </div>
        </div>
    `;
}
function formatGeneratedTimestamp() {
    const now = new Date();
    const datePart = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const timePart = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${datePart} at ${timePart}`;
}
function formatReportDate(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
async function printReportCards() {
    // Always regenerate right before printing so the printed output reflects
    // any marks entered since the preview was last generated. generateReportCards
    // is async (it fetches attendance history before populating the preview), so
    // this MUST be awaited — printing before it resolves was grabbing whatever
    // was already in report-cards-preview (stale content, or the "Loading
    // attendance history..." placeholder), producing a blank/loading print.
    await generateReportCards();
    const previewArea = document.getElementById('report-cards-preview');
    const printArea = document.getElementById('print-area');
    if (!previewArea || !printArea || previewArea.innerHTML.trim() === '') {
        alert('Select a class with registered students before printing.');
        return;
    }
    printArea.innerHTML = previewArea.innerHTML;
    // Batch export: this preview already compiles every student in the
    // selected class into one continuous print job (one PDF when the
    // browser's print dialog is used to "Save as PDF"). Temporarily swap
    // the page title so that saved filename is meaningful instead of the
    // generic app title — restored right after the print dialog closes.
    const classSelect = document.getElementById('report-class-select');
    const selectedClass = classSelect ? classSelect.value : 'Class';
    const suggestedName = `${selectedClass}_ReportCards_${termSettings.term.replace(/\s+/g, '')}_${termSettings.year}`.replace(/[^\w-]/g, '');
    const originalTitle = document.title;
    document.title = suggestedName;
    window.print();
    document.title = originalTitle;
}
/* ---------------------------------------------------------
   6d. ANALYTICS DATA AGGREGATION
   Pulls real performance metrics per class level (S.1 - S.6) by
   reusing the SAME per-student subject records + grading functions
   already used for report cards (getOLevelSubjectRecords /
   getALevelSubjectRecords, which call computeOfficialGrade /
   computeALevelGrade internally) — no grading formula is
   reimplemented here, only aggregated.
   --------------------------------------------------------- */
const ANALYTICS_CLASS_LEVELS = ['S.1', 'S.2', 'S.3', 'S.4', 'S.5', 'S.6'];
function computeAnalyticsData() {
    const classAverages = {};
    const gradeCountsByClass = {};
    const overallGradeCounts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    const subjectTotals = {}; // { subjectName: { sum, count } }

    ANALYTICS_CLASS_LEVELS.forEach(level => {
        const isALevel = (level === 'S.5' || level === 'S.6');
        const classStudents = studentsList.filter(s => s.class === level);
        const gradeCounts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
        let scoreSum = 0;
        let scoreCount = 0;

        classStudents.forEach(student => {
            const records = isALevel ? getALevelSubjectRecords(student) : getOLevelSubjectRecords(student);
            records.forEach(r => {
                const grade = isALevel ? r.gradeInfo.grade : r.gradeData.grade;
                const score = isALevel ? r.avgMark : r.finalTotal;
                if (gradeCounts[grade] !== undefined) gradeCounts[grade]++;
                if (overallGradeCounts[grade] !== undefined) overallGradeCounts[grade]++;
                scoreSum += score;
                scoreCount++;
                if (!subjectTotals[r.subj]) subjectTotals[r.subj] = { sum: 0, count: 0 };
                subjectTotals[r.subj].sum += score;
                subjectTotals[r.subj].count++;
            });
        });

        classAverages[level] = scoreCount > 0 ? Math.round(scoreSum / scoreCount) : 0;
        gradeCountsByClass[level] = gradeCounts;
    });

    let bestSubject = null;
    let bestSubjectAvg = -1;
    Object.keys(subjectTotals).forEach(subj => {
        const avg = subjectTotals[subj].sum / subjectTotals[subj].count;
        if (avg > bestSubjectAvg) {
            bestSubjectAvg = avg;
            bestSubject = subj;
        }
    });

    return {
        classAverages,
        gradeCountsByClass,
        overallGradeCounts,
        bestSubject,
        bestSubjectAvg: bestSubject ? Math.round(bestSubjectAvg) : 0
    };
}
/* ---------------------------------------------------------
   7. PERFORMANCE ANALYTICS GRAPH MODULE (Chart.js)
   --------------------------------------------------------- */
function renderAnalyticsModule() {
    const analytics = computeAnalyticsData();
    return `
        <div class="space-y-6">
            <div class="bg-white border border-slate-200 p-5 rounded-2xl shadow-xs flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h3 class="text-sm font-black text-slate-900 uppercase"><i class="fa-solid fa-chart-column mr-2 text-teal-600"></i>Learner Performance Analytics & Trends</h3>
                    <p class="text-xs font-semibold text-slate-500 mt-0.5">Visualizing grade distribution across school class tiers.</p>
                </div>
                <div>
                    <select id="analytics-metric" onchange="initPerformanceChart()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                        <option value="class-average">Average Score by Class</option>
                        <option value="grade-distribution">Grade Distribution (A - E)</option>
                    </select>
                </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="bg-white border border-slate-200 p-5 rounded-2xl shadow-xs flex items-center gap-4">
                    <div class="w-11 h-11 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center text-lg flex-shrink-0">
                        <i class="fa-solid fa-trophy"></i>
                    </div>
                    <div class="min-w-0">
                        <p class="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">Best Performed Subject (School-Wide)</p>
                        <p class="text-lg font-black text-slate-900 truncate">${analytics.bestSubject || 'No scores recorded yet'}</p>
                        ${analytics.bestSubject ? `<p class="text-xs font-bold text-teal-600">Average score: ${analytics.bestSubjectAvg}%</p>` : ''}
                    </div>
                </div>
                <div class="bg-white border border-slate-200 p-5 rounded-2xl shadow-xs flex items-center gap-4">
                    <div class="w-11 h-11 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-lg flex-shrink-0">
                        <i class="fa-solid fa-star"></i>
                    </div>
                    <div class="min-w-0">
                        <p class="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">Total "A" Grades (All Classes)</p>
                        <p class="text-lg font-black text-slate-900">${analytics.overallGradeCounts.A}</p>
                    </div>
                </div>
            </div>
            <div class="bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-3">"A" Grades Achieved, By Class</h4>
                <div class="grid grid-cols-3 sm:grid-cols-6 gap-3">
                    ${ANALYTICS_CLASS_LEVELS.map(level => `
                        <div class="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">
                            <p class="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">${level}</p>
                            <p class="text-xl font-black text-teal-700">${analytics.gradeCountsByClass[level].A}</p>
                        </div>
                    `).join('')}
                </div>
            </div>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div class="bg-white border border-slate-200 p-6 rounded-2xl shadow-xs relative h-96 flex items-center justify-center">
                    <canvas id="performanceChart"></canvas>
                </div>
                <div class="bg-white border border-slate-200 p-6 rounded-2xl shadow-xs relative h-96 flex flex-col items-center justify-center">
                    <p class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2 self-start">Grade Distribution Proportions (All Classes)</p>
                    <canvas id="gradeDistributionPieChart"></canvas>
                </div>
            </div>
        </div>
    `;
}
function initPerformanceChart() {
    const analytics = computeAnalyticsData();
    const ctx = document.getElementById('performanceChart');
    if (!ctx) return;
    
    if (performanceChartInstance) {
        performanceChartInstance.destroy();
    }
    const metricSelect = document.getElementById('analytics-metric');
    const metricType = metricSelect ? metricSelect.value : 'class-average';
    let chartConfig;
    if (metricType === 'class-average') {
        chartConfig = {
            type: 'bar',
            data: {
                labels: ANALYTICS_CLASS_LEVELS,
                datasets: [{
                    label: 'Class Mean Score (%)',
                    data: ANALYTICS_CLASS_LEVELS.map(level => analytics.classAverages[level]),
                    backgroundColor: 'rgba(13, 148, 136, 0.8)',
                    borderColor: 'rgba(15, 118, 110, 1)',
                    borderWidth: 1,
                    borderRadius: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { font: { weight: 'bold', size: 11 } } }
                },
                scales: {
                    y: { beginAtZero: true, max: 100, ticks: { font: { weight: 'bold' } } },
                    x: { ticks: { font: { weight: 'bold' } } }
                }
            }
        };
    } else {
        chartConfig = {
            type: 'doughnut',
            data: {
                labels: ['Grade A', 'Grade B', 'Grade C', 'Grade D', 'Grade E'],
                datasets: [{
                    label: 'Number of Students',
                    data: ['A', 'B', 'C', 'D', 'E'].map(g => analytics.overallGradeCounts[g]),
                    backgroundColor: [
                        'rgba(13, 148, 136, 0.9)',
                        'rgba(59, 130, 246, 0.9)',
                        'rgba(234, 179, 8, 0.9)',
                        'rgba(249, 115, 22, 0.9)',
                        'rgba(225, 29, 72, 0.9)'
                    ],
                    borderWidth: 2,
                    borderColor: '#ffffff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { font: { weight: 'bold', size: 11 } } }
                }
            }
        };
    }
    performanceChartInstance = new Chart(ctx, chartConfig);

    // Pie chart lives alongside the bar chart at all times (not tied to the
    // dropdown above) — it always shows grade-distribution proportions across
    // every class, using the same real, aggregated grade counts.
    const pieCtx = document.getElementById('gradeDistributionPieChart');
    if (pieCtx) {
        if (gradeDistributionChartInstance) {
            gradeDistributionChartInstance.destroy();
        }
        gradeDistributionChartInstance = new Chart(pieCtx, {
            type: 'pie',
            data: {
                labels: ['Grade A', 'Grade B', 'Grade C', 'Grade D', 'Grade E'],
                datasets: [{
                    label: 'Share of Grades',
                    data: ['A', 'B', 'C', 'D', 'E'].map(g => analytics.overallGradeCounts[g]),
                    backgroundColor: [
                        'rgba(13, 148, 136, 0.9)',
                        'rgba(59, 130, 246, 0.9)',
                        'rgba(234, 179, 8, 0.9)',
                        'rgba(249, 115, 22, 0.9)',
                        'rgba(225, 29, 72, 0.9)'
                    ],
                    borderWidth: 2,
                    borderColor: '#ffffff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { font: { weight: 'bold', size: 11 } } }
                }
            }
        });
    }
}
/* ---------------------------------------------------------
   8. ATTENDANCE REGISTRY MODULE (Light Theme)
   --------------------------------------------------------- */
function renderAttendanceModule() {
    const today = new Date().toISOString().split('T')[0];
    return `
        <div class="space-y-6">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                <div class="flex flex-wrap items-center gap-4">
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1.5">Select Class Level</label>
                        <select id="attendance-class-filter" onchange="loadAttendanceData()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700 focus:ring-1 focus:ring-teal-500">
                            <option value="S.1">S.1</option>
                            <option value="S.2">S.2</option>
                            <option value="S.3">S.3</option>
                            <option value="S.4">S.4</option>
                            <option value="S.5">S.5</option>
                            <option value="S.6">S.6</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1.5">Registry Date</label>
                        <input type="date" id="attendance-date" value="${today}" onchange="loadAttendanceData()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700 focus:ring-1 focus:ring-teal-500">
                    </div>
                </div>
                <div class="flex gap-2">
                    <button onclick="markAllPresent()" class="bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-300 text-xs font-extrabold uppercase py-3 px-5 rounded-xl transition"><i class="fa-solid fa-check-double mr-1.5"></i>Mark All Present</button>
                    <button onclick="saveAttendanceRegistry()" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase py-3 px-5 rounded-xl shadow-xs transition"><i class="fa-solid fa-floppy-disk mr-1.5"></i>Save Attendance</button>
                </div>
            </div>
            <div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
                <div class="overflow-x-auto">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider border-b border-slate-200">
                                <th class="p-4">Student ID</th>
                                <th class="p-4">Full Name</th>
                                <th class="p-4">Class Level</th>
                                <th class="p-4 text-center">Status Selection</th>
                            </tr>
                        </thead>
                        <tbody id="attendance-table-body" class="divide-y divide-slate-100 text-xs text-slate-700"></tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
}
function loadAttendanceData() {
    const tbody = document.getElementById('attendance-table-body');
    const classFilter = document.getElementById('attendance-class-filter');
    const dateField = document.getElementById('attendance-date');
    
    if (!tbody || !classFilter || !dateField) return;
    const selectedClass = classFilter.value;
    const selectedDate = dateField.value;
    tbody.innerHTML = "";
    
    const classStudents = studentsList.filter(s => s.class === selectedClass);
    updateDashboardStats();
    
    if (classStudents.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-slate-400 text-xs font-medium uppercase tracking-wider">No student records found for ${selectedClass}.</td></tr>`;
        return;
    }
    
    classStudents.forEach(student => {
        const recordKey = `${selectedDate}_${student.id}`;
        if (!attendanceStorage[recordKey]) attendanceStorage[recordKey] = 'Present';
        const currentStatus = attendanceStorage[recordKey];
        
        tbody.innerHTML += `
            <tr class="hover:bg-slate-50 transition">
                <td class="p-4 font-mono text-xs font-bold text-teal-700">${student.id}</td>
                <td class="p-4 font-bold text-slate-900">${student.name}</td>
                <td class="p-4"><span class="bg-teal-50 text-teal-800 font-extrabold px-2.5 py-1 rounded-lg text-xs border border-teal-200">${student.class}</span></td>
                <td class="p-4 text-center space-x-2">
                    <button type="button" onclick="setAttendanceStatus('${student.id}', 'Present')" class="px-3 py-1.5 rounded-lg text-xs font-extrabold uppercase transition ${currentStatus === 'Present' ? 'bg-emerald-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'}"><i class="fa-solid fa-check mr-1"></i>Present</button>
                    <button type="button" onclick="setAttendanceStatus('${student.id}', 'Absent')" class="px-3 py-1.5 rounded-lg text-xs font-extrabold uppercase transition ${currentStatus === 'Absent' ? 'bg-rose-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'}"><i class="fa-solid fa-xmark mr-1"></i>Absent</button>
                    <button type="button" onclick="setAttendanceStatus('${student.id}', 'Excused')" class="px-3 py-1.5 rounded-lg text-xs font-extrabold uppercase transition ${currentStatus === 'Excused' ? 'bg-amber-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'}"><i class="fa-solid fa-user-clock mr-1"></i>Excused</button>
                </td>
            </tr>
        `;
    });
}
// Daily register shortcut: sets every currently-listed student in the
// selected class/date to "Present" in one click, instead of clicking
// Present individually for each row. Reuses the exact same per-student
// AttendanceAPI.setStatus() write that a manual click uses — no new
// attendance logic, just a loop over the existing single-student path.
function markAllPresent() {
    if (!getPermissions(currentUser.role).canManageAttendance) return; // RBAC guard
    const classFilter = document.getElementById('attendance-class-filter');
    const dateField = document.getElementById('attendance-date');
    if (!classFilter || !dateField) return;
    const selectedClass = classFilter.value;
    const selectedDate = dateField.value;
    const classStudents = studentsList.filter(s => s.class === selectedClass);
    if (classStudents.length === 0) return;
    if (!confirm(`Mark all ${classStudents.length} student(s) in ${selectedClass} as Present for ${selectedDate}?`)) return;
    classStudents.forEach(student => {
        const recordKey = `${selectedDate}_${student.id}`;
        attendanceStorage[recordKey] = 'Present';
        AttendanceAPI.setStatus(selectedDate, student.id, 'Present', selectedClass).catch(() => {});
    });
    loadAttendanceData();
    updateDashboardStats();
}
function setAttendanceStatus(studId, status) {
    if (!getPermissions(currentUser.role).canManageAttendance) return; // RBAC guard
    const dateField = document.getElementById('attendance-date');
    const recordKey = `${dateField.value}_${studId}`;
    attendanceStorage[recordKey] = status;
    const classFilter = document.getElementById('attendance-class-filter');
    AttendanceAPI.setStatus(dateField.value, studId, status, classFilter ? classFilter.value : undefined).catch(() => {});
    loadAttendanceData();
    updateDashboardStats();
}
async function saveAttendanceRegistry() {
    if (!getPermissions(currentUser.role).canManageAttendance) return; // RBAC guard
    const dateField = document.getElementById('attendance-date');
    const classFilter = document.getElementById('attendance-class-filter');
    try {
        await AttendanceAPI.saveRegistry(dateField.value, classFilter ? classFilter.value : '');
    } catch (err) {
        alert(err.message || 'Could not save attendance. Please try again.');
        return;
    }
    await refreshAttendanceList();
    alert(`Attendance successfully recorded and saved for ${dateField.value}!`);
    updateDashboardStats();
}
/* ---------------------------------------------------------
   8b. EDUCATIONAL RESOURCES MODULE
   Upload/download hub for teachers & admins to share notes, past
   papers, schemes of work, etc. Files are held in-memory as data
   URLs for now (no backend yet) — download works via a plain
   anchor tag, no server round-trip needed.
   --------------------------------------------------------- */
const RESOURCE_MAX_BYTES = 4 * 1024 * 1024; // 4MB cap — kept under Vercel's ~4.5MB serverless request body limit
function renderResourcesModule() {
    const canUpload = getPermissions(currentUser.role).canManageResources;
    const allSubjects = ['GENERAL', ...new Set([...oLevelSubjects, ...aLevelSubjects])];
    return `
        <div class="space-y-6">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                <div class="flex flex-wrap items-end gap-4">
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Filter by Level</label>
                        <select id="resource-level-filter" onchange="loadResourcesData()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700 focus:ring-1 focus:ring-teal-500">
                            <option value="ALL">All Levels</option>
                            <option value="O-Level">O-Level</option>
                            <option value="A-Level">A-Level</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Search</label>
                        <input type="text" id="resource-search" oninput="loadResourcesData()" placeholder="Search by title or subject..." class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700 w-64">
                    </div>
                </div>
                ${canUpload ? `
                <button onclick="toggleResourceForm()" class="w-full md:w-auto bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs">
                    <i class="fa-solid fa-upload mr-2"></i>Upload Resource
                </button>` : ''}
            </div>
            ${canUpload ? `
            <div id="resource-form-container" class="hidden bg-white border border-slate-200 p-5 rounded-2xl shadow-xs transition-all duration-300 ease-in-out">
                <h4 class="text-xs font-extrabold text-teal-700 uppercase tracking-wider mb-3"><i class="fa-solid fa-folder-plus mr-2"></i>Upload New Resource</h4>
                <form onsubmit="handleAddResource(event)" class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                    <div class="sm:col-span-2 md:col-span-2">
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Title</label>
                        <input type="text" id="res-title" placeholder="e.g. Physics Wave Motion Notes" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Subject</label>
                        <select id="res-subject" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                            ${allSubjects.map(s => `<option value="${s}">${s}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Target Level</label>
                        <select id="res-level" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                            <option value="All Levels">All Levels</option>
                            <option value="O-Level">O-Level (S.1 &ndash; S.4)</option>
                            <option value="A-Level">A-Level (S.5 &ndash; S.6)</option>
                        </select>
                    </div>
                    <div class="sm:col-span-2 md:col-span-4">
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">File</label>
                        <input type="file" id="res-file" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                        <p class="text-[10px] text-slate-400 font-semibold mt-1">Accepted: PDF, Word, PowerPoint, Excel, images, ZIP. Max size 4MB.</p>
                    </div>
                    <div id="resource-form-error" class="hidden sm:col-span-2 md:col-span-4 text-xs font-bold text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2"></div>
                    <div class="sm:col-span-2 md:col-span-4 flex justify-end space-x-2 pt-2">
                        <button type="button" onclick="toggleResourceForm()" class="bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-extrabold uppercase py-2 px-4 rounded-xl"><i class="fa-solid fa-xmark mr-1.5"></i>Cancel</button>
                        <button type="submit" id="resource-submit-btn" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase py-2 px-4 rounded-xl transition"><i class="fa-solid fa-upload mr-1.5"></i>Upload</button>
                    </div>
                </form>
            </div>` : ''}
            <div id="resource-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"></div>
        </div>
    `;
}
function toggleResourceForm() {
    const formContainer = document.getElementById('resource-form-container');
    if (formContainer) formContainer.classList.toggle('hidden');
}
function getFileIcon(fileName) {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    if (ext === 'pdf') return 'fa-file-pdf';
    if (['doc', 'docx'].includes(ext)) return 'fa-file-word';
    if (['ppt', 'pptx'].includes(ext)) return 'fa-file-powerpoint';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return 'fa-file-excel';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'fa-file-image';
    if (['zip', 'rar', '7z'].includes(ext)) return 'fa-file-zipper';
    return 'fa-file-lines';
}
function getFileTypeLabel(fileName) {
    const ext = (fileName.split('.').pop() || '').toUpperCase();
    return ext || 'FILE';
}
function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function handleAddResource(event) {
    event.preventDefault();
    if (!getPermissions(currentUser.role).canManageResources) return; // RBAC guard
    const titleInput = document.getElementById('res-title');
    const subjectSelect = document.getElementById('res-subject');
    const levelSelect = document.getElementById('res-level');
    const fileInput = document.getElementById('res-file');
    const errorBox = document.getElementById('resource-form-error');
    const submitBtn = document.getElementById('resource-submit-btn');

    const title = titleInput.value.trim();
    const file = fileInput.files[0];

    if (errorBox) errorBox.classList.add('hidden');

    if (!title || !file) {
        if (errorBox) { errorBox.innerText = 'Please provide a title and choose a file.'; errorBox.classList.remove('hidden'); }
        return;
    }
    if (file.size > RESOURCE_MAX_BYTES) {
        if (errorBox) { errorBox.innerText = `That file is too large (${formatFileSize(file.size)}). Maximum allowed is 4MB.`; errorBox.classList.remove('hidden'); }
        return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Uploading...'; }

    // Build a real FormData payload — ready to POST straight to a
    // Node.js multer (or similar) endpoint at ENDPOINTS.RESOURCE_UPLOAD.
    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', title);
    formData.append('subject', subjectSelect.value);
    formData.append('level', levelSelect.value);

    const finishUpload = (resource) => {
        resourcesList.push(resource);
        toggleResourceForm();
        event.target.reset();
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fa-solid fa-upload mr-1.5"></i>Upload'; }
        loadResourcesData();
    };

    ResourcesAPI.upload(formData).then((serverResource) => {
        if (serverResource) {
            // Backend is live and returned the stored resource's metadata/URL.
            finishUpload(serverResource);
            return;
        }
        // Backend not deployed yet — read the file locally so the upload
        // still works end-to-end for demos/testing.
        const reader = new FileReader();
        reader.onload = function () {
            finishUpload({
                id: resourceIdCounter++,
                title,
                subject: subjectSelect.value,
                level: levelSelect.value,
                fileName: file.name,
                fileType: file.type,
                fileSize: file.size,
                uploadedBy: currentUser.username,
                createdAt: new Date().toISOString(),
                uploadedAt: Date.now(),
                fileUrl: reader.result
            });
        };
        reader.onerror = function () {
            if (errorBox) { errorBox.innerText = 'Something went wrong reading that file. Please try again.'; errorBox.classList.remove('hidden'); }
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fa-solid fa-upload mr-1.5"></i>Upload'; }
        };
        reader.readAsDataURL(file);
    }).catch((err) => {
        if (errorBox) { errorBox.innerText = err.message || 'Upload failed. Please try again.'; errorBox.classList.remove('hidden'); }
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fa-solid fa-upload mr-1.5"></i>Upload'; }
    });
}
async function deleteResource(id) {
    const resource = resourcesList.find(r => r.id === id);
    if (!resource) return;
    const perms = getPermissions(currentUser.role);
    const canDelete = perms.canDeleteAnyResource || (perms.canManageResources && resource.uploadedBy.toLowerCase() === currentUser.username.toLowerCase());
    if (!canDelete) return; // RBAC guard
    if (!confirm(`Delete "${resource.title}"? This cannot be undone.`)) return;
    try {
        await ResourcesAPI.remove(id);
    } catch (err) {
        alert(err.message || 'Could not delete this resource. Please try again.');
        return;
    }
    await refreshResourcesList();
    loadResourcesData();
}
function loadResourcesData() {
    const grid = document.getElementById('resource-grid');
    if (!grid) return;
    const levelFilter = document.getElementById('resource-level-filter');
    const searchInput = document.getElementById('resource-search');
    const level = levelFilter ? levelFilter.value : 'ALL';
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

    let filtered = resourcesList.filter(r => {
        const matchesLevel = level === 'ALL' || r.level === level || r.level === 'All Levels';
        const matchesQuery = query === '' || r.title.toLowerCase().includes(query) || r.subject.toLowerCase().includes(query);
        return matchesLevel && matchesQuery;
    });
    filtered = filtered.slice().sort((a, b) => b.uploadedAt - a.uploadedAt);

    if (filtered.length === 0) {
        const emptyMsg = resourcesList.length === 0
            ? (currentUser.role !== 'Student' ? 'No resources uploaded yet. Use "+ Upload Resource" to add the first one.' : 'No resources have been shared yet. Check back later.')
            : 'No resources match your current filter or search.';
        grid.innerHTML = `<div class="col-span-full bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-400 text-xs font-semibold">${emptyMsg}</div>`;
        return;
    }
    grid.innerHTML = filtered.map(r => buildResourceCard(r)).join('');
}
function buildResourceCard(r) {
    const perms = getPermissions(currentUser.role);
    const canDelete = perms.canDeleteAnyResource || (perms.canManageResources && r.uploadedBy.toLowerCase() === currentUser.username.toLowerCase());
    const fileTypeLabel = getFileTypeLabel(r.fileName);
    const fileSizeLabel = (typeof r.fileSize === 'number') ? formatFileSize(r.fileSize) : '';
    const uploadedDate = r.createdAt || r.uploadedAtISO; // uploadedAtISO kept for backward compatibility with any cached local-fallback entries
    return `
        <div class="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs flex flex-col gap-3">
            <div class="flex items-start gap-3">
                <div class="w-11 h-11 rounded-xl bg-teal-50 border border-teal-100 text-teal-700 flex items-center justify-center text-lg flex-shrink-0">
                    <i class="fa-solid ${getFileIcon(r.fileName)}"></i>
                </div>
                <div class="min-w-0">
                    <p class="font-bold text-slate-900 text-sm truncate" title="${r.title}">${r.title}</p>
                    <p class="text-[11px] font-semibold text-slate-500 truncate">${r.subject} &middot; ${r.level}</p>
                </div>
            </div>
            <div class="flex flex-wrap gap-1.5">
                <span class="badge-blue">${fileTypeLabel}</span>
                ${fileSizeLabel ? `<span class="text-[10px] font-bold text-slate-400 self-center">${fileSizeLabel}</span>` : ''}
            </div>
            <div class="text-[10.5px] font-semibold text-slate-400 border-t border-slate-100 pt-2">
                Uploaded by ${r.uploadedBy} &middot; ${formatReportDate(uploadedDate)}
            </div>
            <div class="flex gap-2 pt-1">
                <a href="${r.fileUrl}" download="${r.fileName}" target="_blank" rel="noopener" class="flex-1 text-center bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-extrabold uppercase tracking-wider py-2 rounded-lg transition">
                    <i class="fa-solid fa-download mr-1"></i>Download
                </a>
                ${canDelete ? `<button onclick="deleteResource(${r.id})" class="text-rose-600 hover:text-rose-700 text-[11px] font-extrabold uppercase tracking-wider bg-rose-50 hover:bg-rose-100 px-3 py-2 rounded-lg border border-rose-200 transition-colors"><i class="fa-solid fa-trash mr-1"></i>Delete</button>` : ''}
            </div>
        </div>
    `;
}
/* ---------------------------------------------------------
   9. TEACHER PROFILES & CREDENTIALS MODULE
   --------------------------------------------------------- */
function renderTeachersModule() {
    if (currentUser.role === 'Administrator') {
        return `
            <div class="space-y-6">
                <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                    <p class="text-xs font-semibold text-slate-500">Add, remove, or reset login credentials for teacher accounts.</p>
                    <button onclick="toggleTeacherForm()" class="w-full md:w-auto bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs">
                        <i class="fa-solid fa-chalkboard-user mr-2"></i>Add New Teacher
                    </button>
                </div>
                <div id="teacher-form-container" class="hidden bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                    <h4 class="text-xs font-extrabold text-teal-700 uppercase tracking-wider mb-3"><i class="fa-solid fa-user-plus mr-2"></i>Register New Teacher</h4>
                    <form onsubmit="handleAddTeacher(event)" class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                            <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Teacher ID</label>
                            <input type="text" id="teach-id" placeholder="e.g. T003" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                        </div>
                        <div>
                            <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Full Name</label>
                            <input type="text" id="teach-name" placeholder="Full name" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                        </div>
                        <div>
                            <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Username</label>
                            <input type="text" id="teach-username" placeholder="e.g. jsmith" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                        </div>
                        <div>
                            <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Temporary Password</label>
                            <input type="text" id="teach-password" placeholder="Temporary password" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                        </div>
                        <div>
                            <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Subject</label>
                            <input type="text" id="teach-subject" placeholder="e.g. MATHEMATICS" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                        </div>
                        <div class="sm:col-span-2 md:col-span-4 flex justify-end space-x-2 pt-2">
                            <button type="button" onclick="toggleTeacherForm()" class="bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-extrabold uppercase py-2 px-4 rounded-xl"><i class="fa-solid fa-xmark mr-1.5"></i>Cancel</button>
                            <button type="submit" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase py-2 px-4 rounded-xl transition"><i class="fa-solid fa-floppy-disk mr-1.5"></i>Save Teacher</button>
                        </div>
                    </form>
                </div>
                <div class="overflow-x-auto bg-white border border-slate-200 rounded-2xl shadow-xs">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider border-b border-slate-200">
                                <th class="p-4">Teacher ID</th>
                                <th class="p-4">Full Name</th>
                                <th class="p-4">Username</th>
                                <th class="p-4">Subject</th>
                                <th class="p-4">Password</th>
                                <th class="p-4 text-center">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="teacher-table-body" class="divide-y divide-slate-100 text-xs text-slate-700"></tbody>
                    </table>
                </div>
            </div>
        `;
    }

    // Teacher self-service view
    const me = teachersList.find(t => t.username.toLowerCase() === currentUser.username.toLowerCase());
    if (!me) {
        return `<div class="bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-400 text-sm font-semibold">
            No teacher profile is linked to the username "${currentUser.username}". Ask your Administrator to create one for you in the Teachers panel.
        </div>`;
    }
    return `
        <div class="max-w-xl bg-white border border-slate-200 p-6 rounded-2xl shadow-xs space-y-4">
            <h4 class="text-xs font-extrabold text-teal-700 uppercase tracking-wider"><i class="fa-solid fa-id-badge mr-2"></i>Edit My Profile</h4>
            <form onsubmit="saveOwnTeacherProfile(event)" class="space-y-4">
                <div>
                    <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Full Name</label>
                    <input type="text" id="my-teach-name" value="${me.name}" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                </div>
                <div>
                    <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Username</label>
                    <input type="text" id="my-teach-username" value="${me.username}" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                </div>
                <div>
                    <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">New Password</label>
                    <input type="text" id="my-teach-password" placeholder="Leave blank to keep current password" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                </div>
                <div>
                    <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Subject</label>
                    <input type="text" id="my-teach-subject" value="${me.subject || ''}" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                </div>
                <div id="teacher-profile-msg" class="hidden text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2"></div>
                <div class="flex justify-end pt-2">
                    <button type="submit" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase py-2 px-4 rounded-xl transition"><i class="fa-solid fa-floppy-disk mr-1.5"></i>Save Changes</button>
                </div>
            </form>
        </div>
    `;
}
function loadTeacherData() {
    const tbody = document.getElementById('teacher-table-body');
    if (!tbody) return;
    tbody.innerHTML = "";
    if (teachersList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400 text-xs font-medium">No teacher accounts yet.</td></tr>`;
        return;
    }
    teachersList.forEach((teacher, index) => {
        tbody.innerHTML += `
            <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-4 font-mono text-xs font-bold text-teal-700">${teacher.id}</td>
                <td class="p-4 font-bold text-slate-900">${teacher.name}</td>
                <td class="p-4 text-slate-600 font-semibold">${teacher.username}</td>
                <td class="p-4 text-slate-600 font-semibold">${teacher.subject || '-'}</td>
                <td class="p-4 font-mono text-xs text-slate-500" title="Passwords are never shown in plain text once stored securely on the server.">${teacher.password ? teacher.password : '••••••••'}</td>
                <td class="p-4 text-center space-x-2">
                    <button onclick="resetTeacherPassword(${index})" class="text-teal-700 hover:text-teal-800 text-[11px] font-extrabold uppercase tracking-wider bg-teal-50 hover:bg-teal-100 px-3 py-1.5 rounded-lg border border-teal-200 transition-colors"><i class="fa-solid fa-key mr-1"></i>Reset Password</button>
                    <button onclick="deleteTeacher(${index})" class="text-rose-600 hover:text-rose-700 text-[11px] font-extrabold uppercase tracking-wider bg-rose-50 hover:bg-rose-100 px-3 py-1.5 rounded-lg border border-rose-200 transition-colors"><i class="fa-solid fa-trash mr-1"></i>Delete</button>
                </td>
            </tr>
        `;
    });
}
function toggleTeacherForm() {
    const formContainer = document.getElementById('teacher-form-container');
    if (formContainer) formContainer.classList.toggle('hidden');
}
async function handleAddTeacher(event) {
    event.preventDefault();
    if (!getPermissions(currentUser.role).canManageTeachers) return; // RBAC guard: Administrator only
    const newTeacher = {
        id: document.getElementById('teach-id').value.trim().toUpperCase(),
        name: document.getElementById('teach-name').value.trim(),
        username: document.getElementById('teach-username').value.trim(),
        password: document.getElementById('teach-password').value,
        subject: document.getElementById('teach-subject').value.toUpperCase()
    };
    if (newTeacher.id === '' || newTeacher.name === '' || newTeacher.username === '') {
        alert('Please fill in Teacher ID, Full Name, and Username.');
        return;
    }
    if (teachersList.some(t => t.id.toUpperCase() === newTeacher.id)) {
        alert(`Teacher ID "${newTeacher.id}" is already in use. Please choose another.`);
        return;
    }
    if (teachersList.some(t => t.username.toLowerCase() === newTeacher.username.toLowerCase())) {
        alert('That username is already taken. Please choose another.');
        return;
    }
    try {
        await TeachersAPI.create(newTeacher);
    } catch (err) {
        alert(err.message || 'Could not save this teacher. Please try again.');
        return;
    }
    await refreshTeachersList();
    toggleTeacherForm();
    event.target.reset();
    loadTeacherData();
}
async function deleteTeacher(index) {
    if (!getPermissions(currentUser.role).canManageTeachers) return; // RBAC guard: Administrator only
    const teacher = teachersList[index];
    if (!teacher) return;
    if (!confirm(`Remove ${teacher.name}'s account? This cannot be undone.`)) return;
    try {
        await TeachersAPI.remove(teacher.id);
    } catch (err) {
        alert(err.message || 'Could not delete this teacher. Please try again.');
        return;
    }
    await refreshTeachersList();
    loadTeacherData();
}
async function resetTeacherPassword(index) {
    if (!getPermissions(currentUser.role).canManageTeachers) return; // RBAC guard: Administrator only
    const teacher = teachersList[index];
    if (!teacher) return;
    const newPass = prompt(`Enter a new temporary password for ${teacher.name}:`);
    if (newPass === null || newPass.trim() === "") return;
    try {
        await TeachersAPI.resetPassword(teacher.id, newPass.trim());
    } catch (err) {
        alert(err.message || 'Could not reset this password. Please try again.');
        return;
    }
    await refreshTeachersList();
    loadTeacherData();
}
async function saveOwnTeacherProfile(event) {
    event.preventDefault();
    if (currentUser.role !== 'Teacher') return; // RBAC guard: teachers edit only their own profile
    const me = teachersList.find(t => t.username.toLowerCase() === currentUser.username.toLowerCase());
    if (!me) return;
    const newUsername = document.getElementById('my-teach-username').value.trim();
    const duplicateUsername = teachersList.some(t => t !== me && t.username.toLowerCase() === newUsername.toLowerCase());
    if (duplicateUsername) {
        alert('That username is already taken. Please choose another.');
        return;
    }
    const updates = {
        name: document.getElementById('my-teach-name').value,
        username: newUsername,
        subject: document.getElementById('my-teach-subject').value.toUpperCase()
    };
    const newPassword = document.getElementById('my-teach-password').value.trim();
    if (newPassword !== "") updates.password = newPassword;

    try {
        await TeachersAPI.update(me.id, updates);
    } catch (err) {
        alert(err.message || 'Could not update your profile. Please try again.');
        return;
    }
    await refreshTeachersList();

    currentUser.username = newUsername;
    const userBadge = document.getElementById('user-badge');
    if (userBadge) userBadge.innerText = `Logged in: ${newUsername}`;

    const msg = document.getElementById('teacher-profile-msg');
    if (msg) {
        msg.innerText = "Profile updated successfully.";
        msg.classList.remove('hidden');
    }
}
/* ---------------------------------------------------------
   10. INITIAL PAGE LOAD
   --------------------------------------------------------- */
(async function restoreSessionOnLoad() {
    const savedUser = AuthAPI.getSession();
    if (savedUser && savedUser.username && savedUser.role) {
        await applySessionUser(savedUser);
    } else {
        renderSidebarNav();
    }
})();
