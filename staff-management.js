/* =========================================================
   ADMIN STAFF MANAGEMENT MODULE (staff-management.js)
   ---------------------------------------------------------
   Fully isolated add-on feature, same pattern as class-summaries.js /
   teacher-toolbox.js / finance.js. It renders inside its own top-level
   "Staff Management" tab (see script.js -> renderSidebarNav() /
   switchTab()'s 'staffmanagement' case) and talks only to StaffAPI
   (api.js), which itself talks to routes/admin-staff.routes.js on the
   backend.

   Administrator-only, both here and on the server:
     - ROLE_PERMISSIONS[ROLES.ADMIN].tabs (api.js) is the only tabs[]
       array that includes 'staffmanagement', so no other role even
       gets the nav item or can switchTab() into it.
     - Every route in routes/admin-staff.routes.js additionally requires
       requireRole('Administrator') server-side, so this is defended in
       depth exactly like every other admin-only screen in the app.

   This screen creates/edits/deletes LOGIN ACCOUNTS for the three
   Finance-tier roles (Bursar, Human Resource, Director) only — it does
   not touch Administrator, Teacher, or Student accounts (those have
   their own dedicated flows), and creating an account here does NOT by
   itself grant Finance access: the new account still has to pass the
   separate Finance password gate (script.js -> openFinanceGate) the
   first time it opens "School Finance", exactly like every Bursar
   account already does today.

   Wiring into the rest of the app required exactly 3 minimal,
   additive touch-points elsewhere:
     1. api.js       -> ROLES.HR / ROLES.DIRECTOR, their
                         ROLE_PERMISSIONS entries (canManageStaff on
                         Administrator only), ENDPOINTS.ADMIN_STAFF_*,
                         and the StaffAPI client.
     2. script.js     -> one nav item + one switchTab() case, same
                         pattern as every other tab.
     3. index.html    -> this file added as a new <script> tag.
   No existing array, function body, route, or DB model was changed to
   do this beyond what those three touch-points needed.
   ========================================================= */

const STAFF_MANAGEABLE_ROLES = [ROLES.BURSAR, ROLES.HR, ROLES.DIRECTOR];

let staffManagementLoaded = false; // whether the first list() fetch has completed, so a slow network shows a loading row instead of "No staff accounts yet."

function renderStaffManagementModule() {
    if (!getPermissions(currentUser.role).canManageStaff) {
        // Defense in depth — the nav item/tab is already hidden for every
        // other role (see api.js ROLE_PERMISSIONS), but switchTab() can in
        // theory be called directly (e.g. from the console).
        return `<div class="bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-400 text-sm font-semibold">
            You don't have access to Staff Management.
        </div>`;
    }
    return `
        <div class="space-y-6">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                <p class="text-xs font-semibold text-slate-500">Create and manage login accounts for Bursar, Human Resource, and Director staff. These accounts still need their own Finance password the first time they open School Finance.</p>
                <button onclick="toggleStaffForm()" class="w-full md:w-auto bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs">
                    <i class="fa-solid fa-user-plus mr-2"></i>Add New Staff Account
                </button>
            </div>
            <div id="staff-form-container" class="hidden bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                <h4 class="text-xs font-extrabold text-teal-700 uppercase tracking-wider mb-3"><i class="fa-solid fa-id-badge mr-2"></i>Register New Staff Account</h4>
                <form onsubmit="handleAddStaff(event)" class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Full Name</label>
                        <input type="text" id="staff-fullname" placeholder="Full name" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Username</label>
                        <input type="text" id="staff-username" placeholder="e.g. jnakato" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Temporary Password</label>
                        <input type="text" id="staff-password" placeholder="Min. 6 characters" required minlength="6" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Role</label>
                        <select id="staff-role" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                            ${STAFF_MANAGEABLE_ROLES.map(r => `<option value="${escapeHTML(r)}">${escapeHTML(r)}</option>`).join('')}
                        </select>
                    </div>
                    <div class="sm:col-span-2 md:col-span-4 flex justify-end space-x-2 pt-2">
                        <button type="button" onclick="toggleStaffForm()" class="bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-extrabold uppercase py-2 px-4 rounded-xl"><i class="fa-solid fa-xmark mr-1.5"></i>Cancel</button>
                        <button type="submit" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase py-2 px-4 rounded-xl transition"><i class="fa-solid fa-floppy-disk mr-1.5"></i>Save Account</button>
                    </div>
                </form>
            </div>
            <div class="overflow-x-auto bg-white border border-slate-200 rounded-2xl shadow-xs">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider border-b border-slate-200">
                            <th class="p-4">Full Name</th>
                            <th class="p-4">Username</th>
                            <th class="p-4">Role</th>
                            <th class="p-4 text-center">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="staff-table-body" class="divide-y divide-slate-100 text-xs text-slate-700"></tbody>
                </table>
            </div>
        </div>
    `;
}

function initStaffManagementModule() {
    staffManagementLoaded = false;
    loadStaffData();
}

async function loadStaffData() {
    const tbody = document.getElementById('staff-table-body');
    if (!tbody) return;
    if (!staffManagementLoaded) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-slate-400 text-xs font-medium"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading staff accounts…</td></tr>`;
    }
    let staff;
    try {
        staff = await StaffAPI.list();
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-rose-500 text-xs font-semibold">${escapeHTML(err.message || 'Could not load staff accounts.')}</td></tr>`;
        return;
    }
    staffManagementLoaded = true;
    renderStaffTableRows(staff);
}

function renderStaffTableRows(staff) {
    const tbody = document.getElementById('staff-table-body');
    if (!tbody) return;
    if (!staff.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-slate-400 text-xs font-medium">No staff accounts yet. Use "Add New Staff Account" to create a Bursar, Human Resource, or Director login.</td></tr>`;
        return;
    }
    const ROLE_BADGE_CLASSES = {
        [ROLES.BURSAR]: 'bg-amber-50 text-amber-800 border-amber-200',
        [ROLES.HR]: 'bg-blue-50 text-blue-800 border-blue-200',
        [ROLES.DIRECTOR]: 'bg-purple-50 text-purple-800 border-purple-200'
    };
    tbody.innerHTML = staff.map(s => `
        <tr class="hover:bg-slate-50 transition-colors">
            <td class="p-4 font-bold text-slate-900">${escapeHTML(s.name)}</td>
            <td class="p-4 text-slate-600 font-semibold">${escapeHTML(s.username)}</td>
            <td class="p-4"><span class="text-[10px] font-extrabold uppercase px-2 py-1 rounded-lg border ${ROLE_BADGE_CLASSES[s.role] || 'bg-slate-50 text-slate-700 border-slate-200'}">${escapeHTML(s.role)}</span></td>
            <td class="p-4 text-center space-x-2">
                <button onclick="openEditStaffModal('${escapeHTML(s.username)}')" class="text-blue-600 hover:text-blue-700 text-[11px] font-extrabold uppercase tracking-wider bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg border border-blue-200 transition-colors"><i class="fa-solid fa-pen mr-1"></i>Edit</button>
                <button onclick="resetStaffPassword('${escapeHTML(s.username)}')" class="text-teal-700 hover:text-teal-800 text-[11px] font-extrabold uppercase tracking-wider bg-teal-50 hover:bg-teal-100 px-3 py-1.5 rounded-lg border border-teal-200 transition-colors"><i class="fa-solid fa-key mr-1"></i>Reset Password</button>
                <button onclick="deleteStaffAccount('${escapeHTML(s.username)}')" class="text-rose-600 hover:text-rose-700 text-[11px] font-extrabold uppercase tracking-wider bg-rose-50 hover:bg-rose-100 px-3 py-1.5 rounded-lg border border-rose-200 transition-colors"><i class="fa-solid fa-trash mr-1"></i>Delete</button>
            </td>
        </tr>
    `).join('');
}

function toggleStaffForm() {
    const formContainer = document.getElementById('staff-form-container');
    if (formContainer) formContainer.classList.toggle('hidden');
}

async function handleAddStaff(event) {
    event.preventDefault();
    if (!getPermissions(currentUser.role).canManageStaff) return; // RBAC guard: Administrator only

    const fullName = getInputValue('staff-fullname').trim();
    const username = getInputValue('staff-username').trim();
    const password = getInputValue('staff-password');
    const roleSelect = document.getElementById('staff-role');
    const role = roleSelect ? roleSelect.value : '';

    if (!fullName || !username || !password || !role) {
        alert('Please fill in Full Name, Username, Temporary Password, and Role.');
        return;
    }
    if (!STAFF_MANAGEABLE_ROLES.includes(role)) {
        alert('Please choose a valid role.');
        return;
    }
    if (password.length < 6) {
        alert('Password must be at least 6 characters.');
        return;
    }

    try {
        await StaffAPI.create({ username, password, fullName, role });
    } catch (err) {
        alert(err.message || 'Could not create this staff account. Please try again.');
        return;
    }
    toggleStaffForm();
    event.target.reset();
    loadStaffData();
}

async function deleteStaffAccount(username) {
    if (!getPermissions(currentUser.role).canManageStaff) return; // RBAC guard: Administrator only
    if (!confirm(`Remove the account "${username}"? This cannot be undone.`)) return;
    try {
        await StaffAPI.remove(username);
    } catch (err) {
        alert(err.message || 'Could not delete this account. Please try again.');
        return;
    }
    loadStaffData();
}

async function resetStaffPassword(username) {
    if (!getPermissions(currentUser.role).canManageStaff) return; // RBAC guard: Administrator only
    const newPass = prompt(`Enter a new temporary password for "${username}":`);
    if (newPass === null || newPass.trim() === '') return;
    if (newPass.trim().length < 6) {
        alert('Password must be at least 6 characters.');
        return;
    }
    try {
        await StaffAPI.resetPassword(username, newPass.trim());
    } catch (err) {
        alert(err.message || 'Could not reset this password. Please try again.');
        return;
    }
    alert(`Password reset for "${username}".`);
}

/* ---------------------------------------------------------
   Edit Staff Account (Full Name / Role) — Administrator only.
   Reuses the existing #modal-root + closeModal() pattern already used
   by the Teachers module's edit modal.
   --------------------------------------------------------- */
function openEditStaffModal(username) {
    if (!getPermissions(currentUser.role).canManageStaff) return; // RBAC guard: Administrator only
    const person = staffAccountsList.find(s => s.username.toLowerCase() === username.toLowerCase());
    if (!person) return;
    const root = document.getElementById('modal-root');
    if (!root) return;
    root.innerHTML = `
        <div class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4" onclick="if(event.target===this) closeModal()">
            <div class="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
                <div class="p-6">
                    <h3 class="text-sm font-black text-slate-900 uppercase tracking-wider mb-4"><i class="fa-solid fa-id-badge mr-2 text-teal-600"></i>Edit Staff Account</h3>
                    <form onsubmit="handleEditStaff(event, '${escapeHTML(person.username)}')" class="space-y-3">
                        <div>
                            <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Full Name</label>
                            <input type="text" id="edit-staff-fullname" value="${escapeHTML(person.name)}" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                        </div>
                        <div>
                            <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Username</label>
                            <input type="text" value="${escapeHTML(person.username)}" disabled class="w-full p-2.5 bg-slate-100 border border-slate-300 rounded-xl text-xs font-semibold text-slate-400">
                        </div>
                        <div>
                            <label class="block text-[11px] font-extrabold text-slate-500 uppercase mb-1">Role</label>
                            <select id="edit-staff-role" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700">
                                ${STAFF_MANAGEABLE_ROLES.map(r => `<option value="${escapeHTML(r)}" ${r === person.role ? 'selected' : ''}>${escapeHTML(r)}</option>`).join('')}
                            </select>
                        </div>
                        <div class="flex justify-end gap-2 pt-3">
                            <button type="button" onclick="closeModal()" class="text-xs font-extrabold uppercase tracking-wider text-slate-500 hover:text-slate-700 py-2.5 px-4 rounded-xl transition">Cancel</button>
                            <button type="submit" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-6 rounded-xl transition shadow-xs">Save Changes</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    `;
}

async function handleEditStaff(event, username) {
    event.preventDefault();
    if (!getPermissions(currentUser.role).canManageStaff) return; // RBAC guard: Administrator only
    const fullName = getInputValue('edit-staff-fullname').trim();
    const roleSelect = document.getElementById('edit-staff-role');
    const role = roleSelect ? roleSelect.value : '';
    if (!fullName || !STAFF_MANAGEABLE_ROLES.includes(role)) return;

    try {
        await StaffAPI.update(username, { fullName, role });
    } catch (err) {
        alert(err.message || 'Could not save these changes. Please try again.');
        return;
    }
    closeModal();
    loadStaffData();
}
