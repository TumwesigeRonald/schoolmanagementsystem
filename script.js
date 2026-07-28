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

/* ---------------------------------------------------------
   2. AUTHENTICATION & NAVIGATION
   --------------------------------------------------------- */
async function handleLogin(event) {
    event.preventDefault();
    const usernameInput = document.getElementById('login-username').value.trim();
    const passwordInput = document.getElementById('login-password').value;
    const errorElem = document.getElementById('login-error');

    if (!usernameInput || !passwordInput) {
        if (errorElem) {
            errorElem.innerText = "Please enter both username and password.";
            errorElem.classList.remove('hidden');
        }
        return;
    }

    const result = await AuthAPI.login(usernameInput, passwordInput);
    if (!result.ok) {
        if (errorElem) {
            errorElem.innerText = result.message || "Invalid credentials.";
            errorElem.classList.remove('hidden');
        }
        return;
    }

    if (errorElem) errorElem.classList.add('hidden');
    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('dashboard-section').classList.remove('hidden');
    
    const sessionUser = AuthAPI.getSession();
    const userBadge = document.getElementById('user-badge');
    const roleTag = document.getElementById('user-role-tag');
    
    if (userBadge) userBadge.innerText = sessionUser.name || sessionUser.username;
    if (roleTag) roleTag.innerText = sessionUser.role; 
    
    applyRolePermissions(sessionUser.role);
    switchTab('students');
    updateDashboardStats();
}

function handleLogout() {
    AuthAPI.logout();
    document.getElementById('dashboard-section').classList.add('hidden');
    document.getElementById('login-section').classList.remove('hidden');
    const passwordField = document.getElementById('login-password');
    if (passwordField) passwordField.value = "";
    const usernameField = document.getElementById('login-username');
    if (usernameField) usernameField.value = "";
}

function applyRolePermissions(role) {
    const permissions = getPermissions(role);
    const navContainer = document.getElementById('sidebar-nav');
    if (!navContainer) return;

    const allNavItems = [
        { id: 'students', label: 'Students', icon: 'fa-user-graduate' },
        { id: 'scores', label: 'Score Sheets', icon: 'fa-pen-to-square' },
        { id: 'analytics', label: 'Analytics', icon: 'fa-chart-pie' },
        { id: 'attendance', label: 'Attendance', icon: 'fa-clipboard-user' }
    ];

    navContainer.innerHTML = allNavItems
        .filter(item => permissions.tabs.includes(item.id))
        .map(item => `
            <a href="javascript:void(0)" id="nav-${item.id}" onclick="switchTab('${item.id}')" class="nav-link">
                <i class="fa-solid ${item.icon}"></i> ${item.label}
            </a>
        `).join('');
}

function switchTab(tabName) {
    const sessionUser = AuthAPI.getSession();
    const permissions = getPermissions(sessionUser ? sessionUser.role : ROLES.STUDENT);
    
    if (!permissions.tabs.includes(tabName)) {
        tabName = permissions.defaultTab;
    }

    permissions.tabs.forEach(tab => {
        const navItem = document.getElementById(`nav-${tab}`);
        if (!navItem) return;
        if (tab === tabName) {
            navItem.className = "nav-link nav-link-active";
        } else {
            navItem.className = "nav-link";
        }
    });

    const titleElem = document.getElementById('page-title');
    let titleText = "";
    switch (tabName) {
        case 'students': titleText = "Student Records Management"; break;
        case 'scores': titleText = "Academic Score Sheets"; break;
        case 'analytics': titleText = "Learner Performance Analytics"; break;
        case 'attendance': titleText = "Attendance Registry"; break;
    }
    if (titleElem) titleElem.innerText = titleText;
    const contentElem = document.getElementById('tab-content');
    if (!contentElem) return;
    
    if (performanceChartInstance) {
        performanceChartInstance.destroy();
        performanceChartInstance = null;
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
        case 'analytics':
            contentElem.innerHTML = renderAnalyticsModule();
            initPerformanceChart();
            break;
        case 'attendance':
            contentElem.innerHTML = renderAttendanceModule();
            loadAttendanceData();
            break;
    }
    updateDashboardStats();
}

/* ---------------------------------------------------------
   3. DASHBOARD STATISTICS CALCULATION
   --------------------------------------------------------- */
function updateDashboardStats() {
    const totalStudents = studentsList.length;
    const uniqueClasses = [...new Set(studentsList.map(s => s.class))].length;
    const totalMarksRecorded = Object.keys(marksStorage).length;
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
   4. STUDENT RECORDS MODULE
   --------------------------------------------------------- */
function renderStudentsModule() {
    const sessionUser = AuthAPI.getSession();
    const permissions = getPermissions(sessionUser ? sessionUser.role : ROLES.STUDENT);

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
                ${permissions.canManageStudents ? `
                <button onclick="toggleStudentForm()" class="w-full md:w-auto bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs">
                    + Add New Student
                </button>` : ''}
            </div>
            ${permissions.canManageStudents ? `
            <div id="student-form-container" class="hidden bg-white border border-slate-200 p-5 rounded-2xl shadow-xs transition-all duration-300 ease-in-out">
                <h4 class="text-xs font-extrabold text-teal-700 uppercase tracking-wider mb-3">Register New Student</h4>
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
                        <button type="button" onclick="toggleStudentForm()" class="bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-extrabold uppercase py-2 px-4 rounded-xl">Cancel</button>
                        <button type="submit" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase py-2 px-4 rounded-xl transition">Save Student</button>
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
                            ${permissions.canManageStudents ? '<th class="p-4 text-center">Actions</th>' : ''}
                        </tr>
                    </thead>
                    <tbody id="student-table-body" class="divide-y divide-slate-100 text-xs text-slate-700"></tbody>
                </table>
            </div>
        </div>
    `;
}

async function loadStudentData() {
    const tbody = document.getElementById('student-table-body');
    const filterSelect = document.getElementById('class-filter');
    if (!tbody) return;
    
    try {
        studentsList = await StudentsAPI.list();
    } catch (e) {
        // fallback to local array if network/API fails
    }

    const selectedClass = filterSelect ? filterSelect.value : 'ALL';
    tbody.innerHTML = "";
    const filteredStudents = (selectedClass === 'ALL') ? studentsList : studentsList.filter(s => s.class === selectedClass);
    
    updateDashboardStats();
    if (filteredStudents.length === 0) {
        const colSpan = getPermissions(AuthAPI.getSession()?.role).canManageStudents ? 5 : 4;
        tbody.innerHTML = `<tr><td colspan="${colSpan}" class="p-6 text-center text-slate-400 text-xs font-medium">No student records found for ${selectedClass}.</td></tr>`;
        return;
    }
    
    const sessionUser = AuthAPI.getSession();
    const permissions = getPermissions(sessionUser ? sessionUser.role : ROLES.STUDENT);

    filteredStudents.forEach((student) => {
        const originalIndex = studentsList.findIndex(s => s.id === student.id);
        tbody.innerHTML += `
            <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-4 font-mono text-xs font-bold text-teal-700">${student.id}</td>
                <td class="p-4 font-bold text-slate-900">${student.name}</td>
                <td class="p-4"><span class="bg-teal-50 text-teal-800 font-extrabold px-2.5 py-1 rounded-lg text-[11px] border border-teal-200">${student.class}</span></td>
                <td class="p-4 text-slate-600 font-semibold">${student.gender}</td>
                ${permissions.canManageStudents ? `
                <td class="p-4 text-center">
                    <button onclick="deleteStudent(${originalIndex})" class="text-rose-600 hover:text-rose-700 text-[11px] font-extrabold uppercase tracking-wider bg-rose-50 hover:bg-rose-100 px-3 py-1.5 rounded-lg border border-rose-200 transition-colors">Delete</button>
                </td>` : ''}
            </tr>
        `;
    });
}

function toggleStudentForm() {
    const formContainer = document.getElementById('student-form-container');
    if (formContainer) formContainer.classList.toggle('hidden');
}

async function handleAddStudent(event) {
    event.preventDefault();
    const newStudent = {
        id: document.getElementById('stud-id').value.toUpperCase(),
        name: document.getElementById('stud-name').value,
        class: document.getElementById('stud-class').value,
        gender: document.getElementById('stud-gender').value
    };
    try {
        await StudentsAPI.create(newStudent);
        studentsList.push(newStudent);
        loadStudentData();
        toggleStudentForm();
        document.getElementById('stud-id').value = "";
        document.getElementById('stud-name').value = "";
        updateDashboardStats();
    } catch (error) {
        console.error("Failed to add student:", error);
        alert("Could not save student to the server.");
    }
}

async function deleteStudent(index) {
  if (!confirm("Are you sure you want to remove this student record?")) return;
  const student = studentsList[index];
  
  try {
    await StudentsAPI.remove(student.id);
    studentsList.splice(index, 1);
    loadStudentData();
    updateDashboardStats();
  } catch (error) {
    console.error("Failed to delete student:", error); // Fixed console.err typo
    alert("Could not delete student from the server.");
  }
}

/* ---------------------------------------------------------
   5. SCORE SHEETS MODULE
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
                        <button onclick="loadNextSubject()" class="bg-slate-100 hover:bg-slate-200 text-teal-700 text-xs font-extrabold uppercase py-2.5 px-3 rounded-xl border border-slate-300 transition">Next Subject</button>
                    </div>
                </div>
                <button onclick="saveAllMarks()" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs">Save Marks Entry</button>
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
        const colSpan = isALevel ? 8 : 10;
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
            <th class="p-4">Student ID</th>
            <th class="p-4">Student Name</th>
            <th class="p-4 text-center">Paper 1 (100)</th>
            <th class="p-4 text-center">Paper 2 (100)</th>
            <th class="p-4 text-center">Average</th>
            <th class="p-4 text-center">Grade</th>
            <th class="p-4 text-center">Descriptor</th>
            <th class="p-4 text-center">Points</th>
        </tr>
    `;
}

function buildOLevelHeader() {
    return `
        <tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider border-b border-slate-200">
            <th class="p-4">Student ID</th>
            <th class="p-4">Full Name</th>
            <th class="p-4 text-center">AO1 (3.0)</th>
            <th class="p-4 text-center">AO2 (3.0)</th>
            <th class="p-4 text-center">Av. Score</th>
            <th class="p-4 text-center">F.A (20)</th>
            <th class="p-4 text-center">E.O.T (80)</th>
            <th class="p-4 text-center">Final (100)</th>
            <th class="p-4 text-center">Grade</th>
            <th class="p-4 text-center">Descriptor</th>
        </tr>
    `;
}

function buildALevelRow(student, recordKey, isSubsidiary) {
    if (!marksStorage[recordKey]) marksStorage[recordKey] = { p1: 0, p2: 0 };
    const marks = marksStorage[recordKey];
    const attemptedPapers = [Number(marks.p1), Number(marks.p2)].filter(p => p > 0);
    const avgMark = attemptedPapers.length > 0 ? Math.round(attemptedPapers.reduce((sum, p) => sum + p, 0) / attemptedPapers.length) : 0;
    const gradeInfo = computeALevelGrade(avgMark, isSubsidiary);
    
    return `
        <tr class="hover:bg-slate-50 transition">
            <td class="p-4 font-mono text-xs font-bold text-teal-700">${student.id}</td>
            <td class="p-4 font-bold text-slate-900">${student.name}</td>
            <td class="p-4 text-center"><input type="number" min="0" max="100" value="${marks.p1}" onchange="updateALevelMarks('${student.id}', 'p1', this.value)" class="w-16 p-1.5 text-center bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800"></td>
            <td class="p-4 text-center"><input type="number" min="0" max="100" value="${marks.p2}" onchange="updateALevelMarks('${student.id}', 'p2', this.value)" class="w-16 p-1.5 text-center bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800"></td>
            <td id="total-${student.id}" class="p-4 text-center font-extrabold text-slate-800">${avgMark}</td>
            <td id="grade-${student.id}" class="p-4 text-center font-extrabold text-teal-700">${gradeInfo.grade}</td>
            <td id="descriptor-${student.id}" class="p-4 text-center text-xs font-bold text-slate-500">${gradeInfo.descriptor}</td>
            <td id="points-${student.id}" class="p-4 text-center text-xs font-extrabold text-slate-500">${gradeInfo.points}</td>
        </tr>
    `;
}

function buildOLevelRow(student, recordKey) {
    if (!marksStorage[recordKey]) marksStorage[recordKey] = { ao1: 0, ao2: 0, eot: 0 };
    const marks = marksStorage[recordKey];
    const avScore = ((Number(marks.ao1) + Number(marks.ao2)) / 2).toFixed(1);
    const faScore = ((avScore / 3.0) * 20).toFixed(1);
    const finalTotal = Math.round(Number(faScore) + Number(marks.eot));
    const gradeData = computeOfficialGrade(finalTotal);
    
    return `
        <tr class="hover:bg-slate-50 transition">
            <td class="p-4 font-mono text-xs font-bold text-teal-700">${student.id}</td>
            <td class="p-4 font-bold text-slate-900">${student.name}</td>
            <td class="p-4 text-center"><input type="number" step="0.1" min="0" max="3" value="${marks.ao1}" onchange="updateMarks('${student.id}', 'ao1', this.value)" class="w-16 p-1.5 text-center bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800"></td>
            <td class="p-4 text-center"><input type="number" step="0.1" min="0" max="3" value="${marks.ao2}" onchange="updateMarks('${student.id}', 'ao2', this.value)" class="w-16 p-1.5 text-center bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800"></td>
            <td id="av-${student.id}" class="p-4 text-center text-xs font-bold text-slate-500">${avScore}</td>
            <td id="fa-${student.id}" class="p-4 text-center text-xs font-bold text-slate-500">${faScore}</td>
            <td class="p-4 text-center"><input type="number" min="0" max="80" value="${marks.eot}" onchange="updateMarks('${student.id}', 'eot', this.value)" class="w-16 p-1.5 text-center bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800"></td>
            <td id="total-${student.id}" class="p-4 text-center font-extrabold text-slate-800">${finalTotal}</td>
            <td id="grade-${student.id}" class="p-4 text-center font-extrabold text-teal-700">${gradeData.grade}</td>
            <td id="descriptor-${student.id}" class="p-4 text-center text-xs font-bold text-slate-500">${gradeData.descriptor}</td>
        </tr>
    `;
}

function updateMarks(studId, type, value) {
    const subjectSelect = document.getElementById('score-subject-select');
    const selectedSubject = subjectSelect ? subjectSelect.value : "GENERAL";
    const recordKey = `${selectedSubject}_${studId}`;
    if (!marksStorage[recordKey]) marksStorage[recordKey] = { ao1: 0, ao2: 0, eot: 0 };
    marksStorage[recordKey][type] = Number(value);
    
    const marks = marksStorage[recordKey];
    const avScore = ((marks.ao1 + marks.ao2) / 2).toFixed(1);
    const faScore = ((avScore / 3.0) * 20).toFixed(1);
    const finalTotal = Math.round(Number(faScore) + marks.eot);
    const gradeData = computeOfficialGrade(finalTotal);
    
    document.getElementById(`av-${studId}`).innerText = avScore;
    document.getElementById(`fa-${studId}`).innerText = faScore;
    document.getElementById(`total-${studId}`).innerText = finalTotal;
    document.getElementById(`grade-${studId}`).innerText = gradeData.grade;
    document.getElementById(`descriptor-${studId}`).innerText = gradeData.descriptor;
    updateDashboardStats();
}

function updateALevelMarks(studId, type, value) {
    const subjectSelect = document.getElementById('score-subject-select');
    const selectedSubject = subjectSelect ? subjectSelect.value : "GENERAL";
    const recordKey = `${selectedSubject}_${studId}`;
    if (!marksStorage[recordKey]) marksStorage[recordKey] = { p1: 0, p2: 0 };
    marksStorage[recordKey][type] = Number(value);
    
    const marks = marksStorage[recordKey];
    const attemptedPapers = [Number(marks.p1), Number(marks.p2)].filter(p => p > 0);
    const avgMark = attemptedPapers.length > 0 ? Math.round(attemptedPapers.reduce((sum, p) => sum + p, 0) / attemptedPapers.length) : 0;
    const isSubsidiary = subsidiarySubjects.includes(selectedSubject.toUpperCase());
    const gradeInfo = computeALevelGrade(avgMark, isSubsidiary);
    
    document.getElementById(`total-${studId}`).innerText = avgMark;
    document.getElementById(`grade-${studId}`).innerText = gradeInfo.grade;
    document.getElementById(`descriptor-${studId}`).innerText = gradeInfo.descriptor;
    document.getElementById(`points-${studId}`).innerText = gradeInfo.points;
    updateDashboardStats();
}

async function saveAllMarks() {
    try {
        for (const [recordKey, marksRecord] of Object.entries(marksStorage)) {
            await ScoresAPI.save(recordKey, marksRecord);
        }
        alert("Marks successfully saved to system register and backend!");
        updateDashboardStats();
    } catch (error) {
        console.error("Failed to save marks:", error);
        alert("Failed to save marks to the server.");
    }
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
   7. PERFORMANCE ANALYTICS GRAPH MODULE (Chart.js)
   --------------------------------------------------------- */
function renderAnalyticsModule() {
    return `
        <div class="space-y-6">
            <div class="bg-white border border-slate-200 p-5 rounded-2xl shadow-xs flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h3 class="text-sm font-black text-slate-900 uppercase">Learner Performance Analytics & Trends</h3>
                    <p class="text-xs font-semibold text-slate-500 mt-0.5">Visualizing grade distribution across school class tiers.</p>
                </div>
                <div>
                    <select id="analytics-metric" onchange="initPerformanceChart()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                        <option value="class-average">Average Score by Class</option>
                        <option value="grade-distribution">Grade Distribution (A - E)</option>
                    </select>
                </div>
            </div>
            <div class="bg-white border border-slate-200 p-6 rounded-2xl shadow-xs relative h-96 flex items-center justify-center">
                <canvas id="performanceChart"></canvas>
            </div>
        </div>
    `;
}

function initPerformanceChart() {
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
                labels: ['S.1', 'S.2', 'S.3', 'S.4', 'S.5', 'S.6'],
                datasets: [{
                    label: 'Class Mean Score (%)',
                    data: [68, 74, 62, 79, 71, 83],
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
                    data: [12, 19, 15, 8, 3],
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
}

/* ---------------------------------------------------------
   8. ATTENDANCE REGISTRY MODULE
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
                <button onclick="saveAttendanceRegistry()" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase py-3 px-5 rounded-xl shadow-xs transition">Save Attendance</button>
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
                    <button type="button" onclick="setAttendanceStatus('${student.id}', 'Present')" class="px-3 py-1.5 rounded-lg text-xs font-extrabold uppercase transition ${currentStatus === 'Present' ? 'bg-emerald-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'}">Present</button>
                    <button type="button" onclick="setAttendanceStatus('${student.id}', 'Absent')" class="px-3 py-1.5 rounded-lg text-xs font-extrabold uppercase transition ${currentStatus === 'Absent' ? 'bg-rose-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'}">Absent</button>
                    <button type="button" onclick="setAttendanceStatus('${student.id}', 'Excused')" class="px-3 py-1.5 rounded-lg text-xs font-extrabold uppercase transition ${currentStatus === 'Excused' ? 'bg-amber-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'}">Excused</button>
                </td>
            </tr>
        `;
    });
}

function setAttendanceStatus(studId, status) {
    const dateField = document.getElementById('attendance-date');
    const recordKey = `${dateField.value}_${studId}`;
    attendanceStorage[recordKey] = status;
    loadAttendanceData();
    updateDashboardStats();
}

async function saveAttendanceRegistry() {
    const dateField = document.getElementById('attendance-date');
    const classFilter = document.getElementById('attendance-class-filter');
    try {
        await AttendanceAPI.saveRegistry(dateField.value, classFilter.value);
        alert(`Attendance successfully recorded and saved for ${dateField.value}!`);
        updateDashboardStats();
    } catch (error) {
        console.error("Failed to save attendance:", error);
        alert("Could not save attendance to the server.");
    }
}