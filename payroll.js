/* =========================================================
   STAFF PAYROLL MODULE (payroll.js)
   ---------------------------------------------------------
   Fully isolated add-on feature, same pattern as finance.js itself.
   It renders INSIDE the "Payroll" sub-tab of the School Finance panel
   (see finance.js -> renderFinanceModule()/switchFinanceSection()) and
   talks only to PayrollAPI (api.js), which itself talks to
   routes/payroll.routes.js on the backend.

   Unlike the rest of Finance, there is NO view-only tier here: the
   backend rejects every /finance/payroll/* route for anyone who isn't
   Admin/Bursar (see EDIT_ROLES in payroll.routes.js), so this module
   hides the "Payroll" tab entirely for Teachers rather than showing a
   read-only view that would just 403 on load — see payrollCanAccess().

   Wiring into the rest of the app required exactly 2 minimal,
   additive touch-points in finance.js:
     1. renderFinanceModule()   -> one more <button> in the section-tab
                                    bar (only rendered for Admin/Bursar).
     2. loadFinanceActiveSection() -> one more branch, calling
                                    loadFinancePayrollSection() below.
   Plus 1 touch-point in index.html: this file added as a <script> tag,
   after finance.js. No existing function body, route, or DB model was
   changed to do this.
   ========================================================= */

let payrollActiveView = 'staff'; // 'staff' | 'runs' — sub-tab inside the Payroll tab
let payrollStaffCache = [];      // last-fetched staff list, so modals can look up a name without refetching
let payrollRecordsCache = [];    // last-fetched payroll_records for the selected month/year

function payrollCanAccess() {
    return currentUser.role === ROLES.ADMIN || currentUser.role === ROLES.BURSAR;
}

/* ---------------------------------------------------------
   ENTRY POINT — called from finance.js's loadFinanceActiveSection()
   when the "Payroll" section tab is active. Renders its own sub-tab
   bar (Staff Profiles / Payroll Runs) into #fin-section-body, then
   delegates to whichever sub-view is active.
   --------------------------------------------------------- */
function loadFinancePayrollSection() {
    const body = document.getElementById('fin-section-body');
    if (!body) return;
    if (!payrollCanAccess()) {
        body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium">You don't have access to Payroll.</div>`;
        return;
    }
    body.innerHTML = `
        <div class="flex gap-2 border-b border-slate-200 mb-4">
            <button id="payroll-subtab-staff" onclick="switchPayrollView('staff')" class="finance-section-tab">Staff Profiles</button>
            <button id="payroll-subtab-runs" onclick="switchPayrollView('runs')" class="finance-section-tab">Payroll Runs</button>
        </div>
        <div id="payroll-section-body"></div>
    `;
    switchPayrollView(payrollActiveView);
}

function switchPayrollView(view) {
    payrollActiveView = view;
    ['staff', 'runs'].forEach(v => {
        const tabEl = document.getElementById(`payroll-subtab-${v}`);
        if (tabEl) tabEl.classList.toggle('active', v === view);
    });
    if (view === 'runs') return loadPayrollRunsSection();
    return loadPayrollStaffList();
}

/* ---------------------------------------------------------
   STAFF PROFILES — list, add/edit, delete, and the detail modal
   where allowances are assigned and salary advances are issued.
   --------------------------------------------------------- */
async function loadPayrollStaffList() {
    const body = document.getElementById('payroll-section-body');
    if (!body) return;
    const statusFilter = document.getElementById('payroll-staff-status-filter');
    const roleFilter = document.getElementById('payroll-staff-role-filter');
    const status = statusFilter ? statusFilter.value : '';
    const roleType = roleFilter ? roleFilter.value : '';

    body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading staff&hellip;</div>`;

    try {
        payrollStaffCache = await PayrollAPI.listStaff({ status, roleType });
    } catch (err) {
        body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-rose-500 text-xs font-semibold">${escapeHTML(err.message || "Couldn't load staff profiles.")}</div>`;
        return;
    }

    body.innerHTML = `
        <div class="bg-white border border-slate-200 p-4 rounded-2xl shadow-xs flex flex-wrap items-end gap-4 mb-4">
            <div>
                <label class="block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Status</label>
                <select id="payroll-staff-status-filter" onchange="loadPayrollStaffList()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                    <option value="">All</option>
                    <option value="active" ${status === 'active' ? 'selected' : ''}>Active</option>
                    <option value="inactive" ${status === 'inactive' ? 'selected' : ''}>Inactive</option>
                </select>
            </div>
            <div>
                <label class="block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Role Type</label>
                <select id="payroll-staff-role-filter" onchange="loadPayrollStaffList()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                    <option value="">All</option>
                    <option value="teaching" ${roleType === 'teaching' ? 'selected' : ''}>Teaching</option>
                    <option value="non-teaching" ${roleType === 'non-teaching' ? 'selected' : ''}>Non-teaching</option>
                </select>
            </div>
            <button onclick="openBulkSalaryModal()" class="ml-auto bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-extrabold uppercase py-2.5 px-4 rounded-xl transition"><i class="fa-solid fa-coins mr-1.5"></i>Bulk Salary Update</button>
            <button onclick="openStaffFormModal()" class="bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-extrabold uppercase py-2.5 px-4 rounded-xl transition"><i class="fa-solid fa-plus mr-1.5"></i>Add Staff</button>
        </div>

        ${!payrollStaffCache.length
            ? `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium">No staff profiles found.</div>`
            : `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-auto max-h-[55vh]">
                <table class="w-full text-left text-xs text-slate-700">
                    <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider sticky top-0"><tr>
                        <th class="p-3">Name</th><th class="p-3">Role</th><th class="p-3">Base Salary</th><th class="p-3">Phone</th><th class="p-3">Status</th><th class="p-3"></th>
                    </tr></thead>
                    <tbody class="divide-y divide-slate-100">
                        ${payrollStaffCache.map(s => `
                            <tr>
                                <td class="p-3 font-extrabold"><button onclick="openStaffDetailModal(${s.id})" class="hover:text-teal-600 hover:underline">${escapeHTML(s.name)}</button></td>
                                <td class="p-3 capitalize">${escapeHTML(s.roleType)}</td>
                                <td class="p-3 font-bold">${formatUGX(s.baseSalary)}</td>
                                <td class="p-3 text-slate-500">${s.phone ? escapeHTML(s.phone) : '&mdash;'}</td>
                                <td class="p-3"><span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase ${s.status === 'active' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}">${escapeHTML(s.status)}</span></td>
                                <td class="p-3 text-right whitespace-nowrap">
                                    <button onclick="openStaffDetailModal(${s.id})" class="text-slate-500 hover:text-teal-600 text-[11px] font-extrabold uppercase mr-2"><i class="fa-solid fa-eye"></i></button>
                                    <button onclick="openStaffFormModal(${s.id})" class="text-blue-600 hover:text-blue-700 text-[11px] font-extrabold uppercase mr-2"><i class="fa-solid fa-pen"></i></button>
                                    <button onclick="deletePayrollStaff(${s.id}, '${escapeHTML(s.name).replace(/'/g, "\\'")}')" class="text-rose-500 hover:text-rose-700 text-[11px] font-extrabold uppercase"><i class="fa-solid fa-trash"></i></button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>`}
    `;
}

// openStaffFormModal(id) — id omitted = Add, provided = Edit. Payment
// details are kept to 2 common fields (method + account/phone) rather
// than a raw JSON box; the backend column is JSONB so this shape is
// purely a frontend choice and can grow later without a migration.
function openStaffFormModal(id) {
    const staff = id ? payrollStaffCache.find(s => s.id === id) : null;
    const pd = (staff && staff.paymentDetails) || {};
    const root = document.getElementById('modal-root');
    if (!root) return;
    root.innerHTML = `
        <div class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4" onclick="if(event.target===this) closeModal()">
            <div class="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
                <div class="p-6">
                    <h3 class="text-sm font-black text-slate-900 uppercase tracking-wider">${staff ? 'Edit Staff Profile' : 'Add Staff Profile'}</h3>
                    <div class="space-y-2 mt-4">
                        <input type="text" id="payroll-staff-name" placeholder="Full name" value="${staff ? escapeHTML(staff.name) : ''}" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                        <select id="payroll-staff-roletype" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                            <option value="teaching" ${staff && staff.roleType === 'teaching' ? 'selected' : ''}>Teaching</option>
                            <option value="non-teaching" ${staff && staff.roleType === 'non-teaching' ? 'selected' : ''}>Non-teaching</option>
                        </select>
                        <input type="number" min="0" id="payroll-staff-salary" placeholder="Base salary (UGX)" value="${staff ? staff.baseSalary : ''}" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold">
                        <input type="text" id="payroll-staff-phone" placeholder="Phone (optional)" value="${staff && staff.phone ? escapeHTML(staff.phone) : ''}" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                        <div class="flex gap-2">
                            <select id="payroll-staff-pay-method" class="flex-1 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                                <option value="">Payment method (optional)</option>
                                <option value="Bank Transfer" ${pd.method === 'Bank Transfer' ? 'selected' : ''}>Bank Transfer</option>
                                <option value="Mobile Money" ${pd.method === 'Mobile Money' ? 'selected' : ''}>Mobile Money</option>
                                <option value="Cash" ${pd.method === 'Cash' ? 'selected' : ''}>Cash</option>
                            </select>
                            <input type="text" id="payroll-staff-pay-account" placeholder="Account / phone no." value="${pd.accountNumber ? escapeHTML(pd.accountNumber) : ''}" class="flex-1 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                        </div>
                        ${staff ? `
                        <select id="payroll-staff-status" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                            <option value="active" ${staff.status === 'active' ? 'selected' : ''}>Active</option>
                            <option value="inactive" ${staff.status === 'inactive' ? 'selected' : ''}>Inactive</option>
                        </select>` : ''}
                    </div>
                    <p id="payroll-staff-form-error" class="text-rose-600 text-xs font-bold mt-2 hidden"></p>
                    <div class="flex justify-end gap-2 mt-5">
                        <button onclick="closeModal()" class="text-xs font-extrabold uppercase tracking-wider text-slate-500 hover:text-slate-700 py-2.5 px-4 rounded-xl transition">Cancel</button>
                        <button id="payroll-staff-submit-btn" onclick="submitStaffForm(${staff ? staff.id : 'null'})" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-6 rounded-xl transition shadow-xs">${staff ? 'Save' : 'Add'}</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

async function submitStaffForm(id) {
    const name = document.getElementById('payroll-staff-name').value.trim();
    const roleType = document.getElementById('payroll-staff-roletype').value;
    const baseSalary = Number(document.getElementById('payroll-staff-salary').value);
    const phone = document.getElementById('payroll-staff-phone').value.trim();
    const method = document.getElementById('payroll-staff-pay-method').value;
    const accountNumber = document.getElementById('payroll-staff-pay-account').value.trim();
    const statusEl = document.getElementById('payroll-staff-status');
    const errEl = document.getElementById('payroll-staff-form-error');
    const btn = document.getElementById('payroll-staff-submit-btn');
    if (errEl) errEl.classList.add('hidden');

    if (!name || !roleType || isNaN(baseSalary) || baseSalary < 0) {
        if (errEl) { errEl.textContent = 'Name and a valid, non-negative base salary are required.'; errEl.classList.remove('hidden'); }
        return;
    }
    const paymentDetails = (method || accountNumber) ? { method: method || undefined, accountNumber: accountNumber || undefined } : {};
    const payload = { name, roleType, baseSalary, phone: phone || undefined, paymentDetails };
    if (statusEl) payload.status = statusEl.value;

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        if (id) await PayrollAPI.updateStaff(id, payload);
        else await PayrollAPI.createStaff(payload);
        closeModal();
        loadPayrollStaffList();
    } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = id ? 'Save' : 'Add'; }
        if (errEl) { errEl.textContent = err.message || "Couldn't save that staff profile."; errEl.classList.remove('hidden'); }
    }
}

async function deletePayrollStaff(id, name) {
    if (!confirm(`Delete ${name}'s staff profile? This only works if they have no payroll history — otherwise, edit their status to "inactive" instead.`)) return;
    try {
        await PayrollAPI.deleteStaff(id);
        loadPayrollStaffList();
    } catch (err) {
        alert(err.message || "Couldn't delete that staff profile.");
    }
}

/* ---------------------------------------------------------
   STAFF DETAIL MODAL — profile summary + allowances (add/remove) +
   salary advances (issue). Single data source: GET /staff/:id, which
   the backend already returns as { ...profile, allowances, advances }.
   --------------------------------------------------------- */
async function openStaffDetailModal(id) {
    const root = document.getElementById('modal-root');
    if (!root) return;
    root.innerHTML = `<div class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4"><div class="bg-white rounded-2xl shadow-xl p-10 text-xs font-semibold text-slate-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading&hellip;</div></div>`;

    let staff;
    try {
        staff = await PayrollAPI.getStaff(id);
    } catch (err) {
        root.innerHTML = '';
        alert(err.message || "Couldn't load that staff member.");
        return;
    }
    renderStaffDetailModal(staff);
}

function renderStaffDetailModal(staff) {
    const root = document.getElementById('modal-root');
    if (!root) return;
    const activeAdvance = staff.advances.find(a => a.status === 'active');
    root.innerHTML = `
        <div class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4" onclick="if(event.target===this) closeModal()">
            <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden max-h-[85vh] flex flex-col">
                <div class="p-6 pb-4 border-b border-slate-100">
                    <h3 class="text-sm font-black text-slate-900 uppercase tracking-wider">${escapeHTML(staff.name)}</h3>
                    <p class="text-xs font-semibold text-slate-500 mt-1 capitalize">${escapeHTML(staff.roleType)} &middot; Base salary ${formatUGX(staff.baseSalary)}</p>
                </div>
                <div class="p-6 overflow-y-auto space-y-6">

                    <div>
                        <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">Allowances</h4>
                        ${staff.allowances.length ? `
                        <div class="border border-slate-200 rounded-xl overflow-hidden mb-3">
                            <table class="w-full text-left text-xs text-slate-700">
                                <tbody class="divide-y divide-slate-100">
                                    ${staff.allowances.map(a => `
                                        <tr>
                                            <td class="p-2.5 font-bold">${escapeHTML(a.title)}</td>
                                            <td class="p-2.5">${formatUGX(a.amount)}</td>
                                            <td class="p-2.5 capitalize text-slate-500">${escapeHTML(a.type)}${a.appliedPayrollId ? ' &middot; paid out' : ''}</td>
                                            <td class="p-2.5 text-right">${a.appliedPayrollId ? '' : `<button onclick="deletePayrollAllowanceFromModal(${a.id}, ${staff.id})" class="text-rose-500 hover:text-rose-700"><i class="fa-solid fa-trash"></i></button>`}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>` : `<p class="text-xs text-slate-400 mb-3">No allowances yet.</p>`}
                        <div class="flex flex-wrap items-end gap-2">
                            <input type="text" id="payroll-allowance-title" placeholder="Title (e.g. Transport)" class="flex-1 min-w-[120px] p-2 bg-slate-50 border border-slate-300 rounded-lg text-xs font-semibold">
                            <input type="number" min="1" id="payroll-allowance-amount" placeholder="Amount" class="w-24 p-2 bg-slate-50 border border-slate-300 rounded-lg text-xs font-semibold">
                            <select id="payroll-allowance-type" class="p-2 bg-slate-50 border border-slate-300 rounded-lg text-xs font-semibold">
                                <option value="recurring">Recurring</option>
                                <option value="one-time">One-time</option>
                            </select>
                            <button onclick="addPayrollAllowance(${staff.id})" class="bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-extrabold uppercase py-2 px-3 rounded-lg transition">Add</button>
                        </div>
                        <p id="payroll-allowance-error" class="text-rose-600 text-[11px] font-bold mt-1.5 hidden"></p>
                    </div>

                    <div>
                        <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">Salary Advances</h4>
                        ${staff.advances.length ? `
                        <div class="border border-slate-200 rounded-xl overflow-hidden mb-3">
                            <table class="w-full text-left text-xs text-slate-700">
                                <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider"><tr>
                                    <th class="p-2.5">Requested</th><th class="p-2.5">Per Month</th><th class="p-2.5">Balance</th><th class="p-2.5">Status</th>
                                </tr></thead>
                                <tbody class="divide-y divide-slate-100">
                                    ${staff.advances.map(a => `
                                        <tr>
                                            <td class="p-2.5 font-bold">${formatUGX(a.requestedAmount)}</td>
                                            <td class="p-2.5">${formatUGX(a.repaymentAmountPerMonth)}</td>
                                            <td class="p-2.5">${formatUGX(a.balanceRemaining)}</td>
                                            <td class="p-2.5"><span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase ${a.status === 'cleared' ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-600'}">${escapeHTML(a.status)}</span></td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>` : `<p class="text-xs text-slate-400 mb-3">No salary advances yet.</p>`}
                        ${activeAdvance ? `
                        <p class="text-[11px] text-amber-600 font-semibold mb-2"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Already has an active advance — issuing another will deduct both every payroll run.</p>
                        ` : ''}
                        <div class="flex flex-wrap items-end gap-2">
                            <input type="number" min="1" id="payroll-advance-amount" placeholder="Requested amount" class="w-32 p-2 bg-slate-50 border border-slate-300 rounded-lg text-xs font-semibold">
                            <input type="number" min="1" id="payroll-advance-repayment" placeholder="Repay / month" class="w-32 p-2 bg-slate-50 border border-slate-300 rounded-lg text-xs font-semibold">
                            <button onclick="issuePayrollAdvance(${staff.id})" class="bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-extrabold uppercase py-2 px-3 rounded-lg transition">Issue Advance</button>
                        </div>
                        <p id="payroll-advance-error" class="text-rose-600 text-[11px] font-bold mt-1.5 hidden"></p>
                    </div>

                    <div>
                        <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">Salary History</h4>
                        ${staff.salaryHistory && staff.salaryHistory.length ? `
                        <div class="border border-slate-200 rounded-xl overflow-hidden">
                            <table class="w-full text-left text-xs text-slate-700">
                                <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider"><tr>
                                    <th class="p-2.5">Date</th><th class="p-2.5">Change</th><th class="p-2.5">By</th><th class="p-2.5">Reason</th>
                                </tr></thead>
                                <tbody class="divide-y divide-slate-100">
                                    ${staff.salaryHistory.map(h => `
                                        <tr>
                                            <td class="p-2.5 text-slate-500">${escapeHTML(new Date(h.changedAt).toLocaleDateString())}</td>
                                            <td class="p-2.5 font-bold">${formatUGX(h.oldSalary)} &rarr; <span class="${h.newSalary >= h.oldSalary ? 'text-emerald-600' : 'text-rose-600'}">${formatUGX(h.newSalary)}</span></td>
                                            <td class="p-2.5 text-slate-500">${escapeHTML(h.changedBy || '—')}</td>
                                            <td class="p-2.5 text-slate-500">${h.reason ? escapeHTML(h.reason) : '&mdash;'}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>` : `<p class="text-xs text-slate-400">No salary changes recorded yet.</p>`}
                    </div>

                </div>
                <div class="p-4 border-t border-slate-100 flex justify-end">
                    <button onclick="closeModal(); loadPayrollStaffList();" class="text-xs font-extrabold uppercase tracking-wider text-slate-500 hover:text-slate-700 py-2 px-4 rounded-xl transition">Close</button>
                </div>
            </div>
        </div>
    `;
}

async function addPayrollAllowance(staffId) {
    const title = document.getElementById('payroll-allowance-title').value.trim();
    const amount = Number(document.getElementById('payroll-allowance-amount').value);
    const type = document.getElementById('payroll-allowance-type').value;
    const errEl = document.getElementById('payroll-allowance-error');
    if (errEl) errEl.classList.add('hidden');
    if (!title || !amount || amount <= 0) {
        if (errEl) { errEl.textContent = 'A title and a positive amount are required.'; errEl.classList.remove('hidden'); }
        return;
    }
    try {
        await PayrollAPI.addAllowance(staffId, { title, amount, type });
        const staff = await PayrollAPI.getStaff(staffId);
        renderStaffDetailModal(staff);
    } catch (err) {
        if (errEl) { errEl.textContent = err.message || "Couldn't add that allowance."; errEl.classList.remove('hidden'); }
    }
}

async function deletePayrollAllowanceFromModal(allowanceId, staffId) {
    if (!confirm('Delete this allowance?')) return;
    try {
        await PayrollAPI.deleteAllowance(allowanceId);
        const staff = await PayrollAPI.getStaff(staffId);
        renderStaffDetailModal(staff);
    } catch (err) {
        alert(err.message || "Couldn't delete that allowance.");
    }
}

async function issuePayrollAdvance(staffId) {
    const requestedAmount = Number(document.getElementById('payroll-advance-amount').value);
    const repaymentAmountPerMonth = Number(document.getElementById('payroll-advance-repayment').value);
    const errEl = document.getElementById('payroll-advance-error');
    if (errEl) errEl.classList.add('hidden');
    if (!requestedAmount || requestedAmount <= 0 || !repaymentAmountPerMonth || repaymentAmountPerMonth <= 0) {
        if (errEl) { errEl.textContent = 'Both amounts must be greater than 0.'; errEl.classList.remove('hidden'); }
        return;
    }
    if (!confirm(`Issue an advance of ${formatUGX(requestedAmount)}, repaid at ${formatUGX(repaymentAmountPerMonth)}/month? This takes effect immediately, starting with the next payroll run.`)) return;
    try {
        await PayrollAPI.issueAdvance(staffId, { requestedAmount, repaymentAmountPerMonth });
        const staff = await PayrollAPI.getStaff(staffId);
        renderStaffDetailModal(staff);
    } catch (err) {
        if (errEl) { errEl.textContent = err.message || "Couldn't issue that advance."; errEl.classList.remove('hidden'); }
    }
}

/* ---------------------------------------------------------
   PAYROLL RUNS — month/year picker, "Generate Payroll", and the
   resulting records with a Mark Paid action (which the backend ties
   to an `expenses` ledger entry — see PUT .../mark-paid).
   --------------------------------------------------------- */
function getPayrollViewedMonthYear() {
    const monthEl = document.getElementById('payroll-run-month');
    const yearEl = document.getElementById('payroll-run-year');
    const now = new Date();
    return {
        month: monthEl ? Number(monthEl.value) : now.getMonth() + 1,
        year: yearEl ? Number(yearEl.value) : now.getFullYear()
    };
}

function loadPayrollRunsSection() {
    const body = document.getElementById('payroll-section-body');
    if (!body) return;
    const now = new Date();
    const { month, year } = getPayrollViewedMonthYear() || { month: now.getMonth() + 1, year: now.getFullYear() };
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    body.innerHTML = `
        <div class="bg-white border border-slate-200 p-4 rounded-2xl shadow-xs flex flex-wrap items-end gap-4 mb-4">
            <div>
                <label class="block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Month</label>
                <select id="payroll-run-month" onchange="loadPayrollRecords()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                    ${MONTH_NAMES.map((m, i) => `<option value="${i + 1}" ${i + 1 === month ? 'selected' : ''}>${m}</option>`).join('')}
                </select>
            </div>
            <div>
                <label class="block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Year</label>
                <input type="number" id="payroll-run-year" value="${year}" onchange="loadPayrollRecords()" class="w-24 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
            </div>
            <button onclick="generatePayrollRun()" class="ml-auto bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-extrabold uppercase py-2.5 px-4 rounded-xl transition"><i class="fa-solid fa-gears mr-1.5"></i>Generate Payroll</button>
        </div>
        <div id="payroll-records-body"></div>
    `;
    loadPayrollRecords();
}

async function loadPayrollRecords() {
    const body = document.getElementById('payroll-records-body');
    if (!body) return;
    const { month, year } = getPayrollViewedMonthYear();
    body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading payroll records&hellip;</div>`;

    try {
        payrollRecordsCache = await PayrollAPI.listRecords({ month, year });
    } catch (err) {
        body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-rose-500 text-xs font-semibold">${escapeHTML(err.message || "Couldn't load payroll records.")}</div>`;
        return;
    }

    const totalNetPay = payrollRecordsCache.reduce((sum, r) => sum + r.netPay, 0);

    body.innerHTML = `
        <div class="bg-white border border-slate-200 p-4 rounded-2xl shadow-xs mb-4">
            <p class="text-xs font-semibold text-slate-600">Total net pay for this run: <span class="font-extrabold text-teal-600">${formatUGX(totalNetPay)}</span> across ${payrollRecordsCache.length} staff.</p>
        </div>
        ${!payrollRecordsCache.length
            ? `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium">No payroll generated for this month/year yet. Click "Generate Payroll" above.</div>`
            : `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-auto max-h-[55vh]">
                <table class="w-full text-left text-xs text-slate-700">
                    <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider sticky top-0"><tr>
                        <th class="p-3">Staff</th><th class="p-3">Base</th><th class="p-3">Allowances</th><th class="p-3">Advance Deduction</th><th class="p-3">Net Pay</th><th class="p-3">Status</th><th class="p-3"></th>
                    </tr></thead>
                    <tbody class="divide-y divide-slate-100">
                        ${payrollRecordsCache.map(r => `
                            <tr>
                                <td class="p-3 font-extrabold">${escapeHTML(r.staffName)}</td>
                                <td class="p-3">${formatUGX(r.baseSalary)}</td>
                                <td class="p-3 text-emerald-600">${r.totalAllowances ? '+' + formatUGX(r.totalAllowances) : '&mdash;'}</td>
                                <td class="p-3 text-rose-500">${r.advanceDeduction ? '-' + formatUGX(r.advanceDeduction) : '&mdash;'}</td>
                                <td class="p-3 font-black text-slate-900">${formatUGX(r.netPay)}</td>
                                <td class="p-3">${r.status === 'paid'
                                    ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase bg-emerald-50 text-emerald-600">Paid</span>`
                                    : `<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase bg-amber-50 text-amber-600">Pending</span>`}</td>
                                <td class="p-3 text-right">${r.status === 'paid'
                                    ? `<span class="text-slate-400 text-[10px]">by ${escapeHTML(r.paidBy || '')}</span>`
                                    : `<button onclick="markPayrollPaid(${r.id}, '${escapeHTML(r.staffName).replace(/'/g, "\\'")}')" class="bg-teal-600 hover:bg-teal-700 text-white text-[10px] font-extrabold uppercase py-1.5 px-3 rounded-lg transition">Mark Paid</button>`}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>`}
    `;
}

async function generatePayrollRun() {
    const { month, year } = getPayrollViewedMonthYear();
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    if (!confirm(`Generate payroll for ${MONTH_NAMES[month - 1]} ${year} across every active staff member? Staff already generated for this month/year will be skipped automatically.`)) return;
    try {
        const result = await PayrollAPI.generate(month, year);
        loadPayrollRecords();
        if (result && result.skipped && result.skipped.length) {
            alert(`Generated ${result.generated.length} record(s). ${result.skipped.length} staff already had a record for this month and were skipped.`);
        }
    } catch (err) {
        alert(err.message || "Couldn't generate payroll for that month.");
    }
}

// markPayrollPaid — the backend logs the matching `expenses` entry
// (category "Salaries") in the same transaction, so nothing further is
// needed here besides refreshing this table.
async function markPayrollPaid(recordId, staffName) {
    if (!confirm(`Mark ${staffName}'s payroll as paid? This will log an expense entry in the Finance ledger and cannot be undone here.`)) return;
    try {
        await PayrollAPI.markPaid(recordId);
        loadPayrollRecords();
    } catch (err) {
        alert(err.message || "Couldn't mark that record as paid.");
    }
}

/* ---------------------------------------------------------
   BULK SALARY UPDATE — apply one flat/percentage change to every
   active (or filtered) staff member at once, instead of editing
   profiles one at a time. Targets by { roleType, status } filter only
   (matching PayrollAPI.bulkUpdateSalary's filter mode) — not by an
   explicit staffIds list, since there's no multi-select in the staff
   table to drive that from. A live preview (fetched via the same
   listStaff() filter, recomputed client-side as mode/value change)
   shows exactly who's affected and their new salary before anything
   is submitted, mirroring the backend's own skip-if-negative rule so
   the preview never overpromises what the server will actually do.
   --------------------------------------------------------- */
function openBulkSalaryModal() {
    const root = document.getElementById('modal-root');
    if (!root) return;
    root.innerHTML = `
        <div class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4" onclick="if(event.target===this) closeModal()">
            <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden max-h-[85vh] flex flex-col">
                <div class="p-6 pb-4 border-b border-slate-100">
                    <h3 class="text-sm font-black text-slate-900 uppercase tracking-wider">Bulk Salary Update</h3>
                    <p class="text-xs font-semibold text-slate-500 mt-1">Applies a flat or percentage change to every staff member matching the filter below.</p>
                </div>
                <div class="p-6 overflow-y-auto space-y-4">
                    <div class="grid grid-cols-2 gap-2">
                        <div>
                            <label class="block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Role Type</label>
                            <select id="bulk-salary-roletype" onchange="refreshBulkSalaryPreview()" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                                <option value="">All</option>
                                <option value="teaching">Teaching</option>
                                <option value="non-teaching">Non-teaching</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Status</label>
                            <select id="bulk-salary-status" onchange="refreshBulkSalaryPreview()" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                                <option value="active">Active</option>
                                <option value="inactive">Inactive</option>
                            </select>
                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-2">
                        <div>
                            <label class="block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Change Type</label>
                            <select id="bulk-salary-mode" onchange="refreshBulkSalaryPreview(false)" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                                <option value="percent">Percentage</option>
                                <option value="flat">Flat Amount (UGX)</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Value</label>
                            <input type="number" id="bulk-salary-value" placeholder="e.g. 10 or -5" oninput="refreshBulkSalaryPreview(false)" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold">
                        </div>
                    </div>
                    <p class="text-[10px] text-slate-400">Use a negative value for a pay cut. A percentage of 10 means +10%.</p>
                    <input type="text" id="bulk-salary-reason" placeholder="Reason (optional, e.g. \"2026 annual raise\")" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">

                    <div>
                        <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">Preview</h4>
                        <div id="bulk-salary-preview"><p class="text-xs text-slate-400">Loading matching staff&hellip;</p></div>
                    </div>
                    <p id="bulk-salary-error" class="text-rose-600 text-xs font-bold hidden"></p>
                </div>
                <div class="p-4 border-t border-slate-100 flex justify-end gap-2">
                    <button onclick="closeModal()" class="text-xs font-extrabold uppercase tracking-wider text-slate-500 hover:text-slate-700 py-2.5 px-4 rounded-xl transition">Cancel</button>
                    <button id="bulk-salary-submit-btn" onclick="submitBulkSalaryUpdate()" class="bg-amber-500 hover:bg-amber-600 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-6 rounded-xl transition shadow-xs">Apply Update</button>
                </div>
            </div>
        </div>
    `;
    refreshBulkSalaryPreview();
}

let bulkSalaryPreviewStaff = []; // last-fetched matches for the current roleType/status filter, reused as mode/value change without refetching

async function refreshBulkSalaryPreview(refetch = true) {
    const previewEl = document.getElementById('bulk-salary-preview');
    if (!previewEl) return;
    const roleType = document.getElementById('bulk-salary-roletype').value;
    const status = document.getElementById('bulk-salary-status').value;
    const mode = document.getElementById('bulk-salary-mode').value;
    const value = Number(document.getElementById('bulk-salary-value').value);

    if (refetch) {
        previewEl.innerHTML = `<p class="text-xs text-slate-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading matching staff&hellip;</p>`;
        try {
            bulkSalaryPreviewStaff = await PayrollAPI.listStaff({ status, roleType });
        } catch (err) {
            previewEl.innerHTML = `<p class="text-xs text-rose-500 font-semibold">${escapeHTML(err.message || "Couldn't load matching staff.")}</p>`;
            return;
        }
    }

    if (!bulkSalaryPreviewStaff.length) {
        previewEl.innerHTML = `<p class="text-xs text-slate-400">No staff match that filter.</p>`;
        return;
    }
    if (!value) {
        previewEl.innerHTML = `<p class="text-xs text-slate-400">${bulkSalaryPreviewStaff.length} staff match. Enter a value to preview new salaries.</p>`;
        return;
    }

    const rows = bulkSalaryPreviewStaff.map(s => {
        const newSalary = mode === 'percent' ? s.baseSalary * (1 + value / 100) : s.baseSalary + value;
        return { ...s, newSalary: Math.round(newSalary * 100) / 100 };
    });
    const willSkip = rows.filter(r => r.newSalary < 0);

    previewEl.innerHTML = `
        <div class="border border-slate-200 rounded-xl overflow-hidden max-h-48 overflow-y-auto">
            <table class="w-full text-left text-xs text-slate-700">
                <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider sticky top-0"><tr>
                    <th class="p-2">Staff</th><th class="p-2">Current</th><th class="p-2">New</th>
                </tr></thead>
                <tbody class="divide-y divide-slate-100">
                    ${rows.map(r => `
                        <tr>
                            <td class="p-2 font-bold">${escapeHTML(r.name)}</td>
                            <td class="p-2">${formatUGX(r.baseSalary)}</td>
                            <td class="p-2 ${r.newSalary < 0 ? 'text-rose-500 font-bold' : 'text-emerald-600 font-bold'}">${r.newSalary < 0 ? 'Skipped (negative)' : formatUGX(r.newSalary)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        <p class="text-[11px] text-slate-500 mt-1.5">${rows.length - willSkip.length} of ${rows.length} staff will be updated.${willSkip.length ? ` ${willSkip.length} skipped — would go negative.` : ''}</p>
    `;
}

async function submitBulkSalaryUpdate() {
    const roleType = document.getElementById('bulk-salary-roletype').value;
    const status = document.getElementById('bulk-salary-status').value;
    const mode = document.getElementById('bulk-salary-mode').value;
    const value = Number(document.getElementById('bulk-salary-value').value);
    const reason = document.getElementById('bulk-salary-reason').value.trim();
    const errEl = document.getElementById('bulk-salary-error');
    const btn = document.getElementById('bulk-salary-submit-btn');
    if (errEl) errEl.classList.add('hidden');

    if (!value) {
        if (errEl) { errEl.textContent = 'A non-zero value is required.'; errEl.classList.remove('hidden'); }
        return;
    }
    if (!bulkSalaryPreviewStaff.length) {
        if (errEl) { errEl.textContent = 'No staff match that filter.'; errEl.classList.remove('hidden'); }
        return;
    }
    if (!confirm(`Apply this ${mode === 'percent' ? value + '%' : formatUGX(value)} change to ${bulkSalaryPreviewStaff.length} staff member(s)? This cannot be undone here — each change is logged individually in Salary History.`)) return;

    if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
    try {
        const result = await PayrollAPI.bulkUpdateSalary({ roleType: roleType || undefined, status, mode, value, reason: reason || undefined });
        closeModal();
        loadPayrollStaffList();
        alert(`Updated ${result.updated.length} staff member(s).${result.skipped && result.skipped.length ? ` ${result.skipped.length} skipped (would have gone negative).` : ''}`);
    } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Apply Update'; }
        if (errEl) { errEl.textContent = err.message || "Couldn't apply that bulk update."; errEl.classList.remove('hidden'); }
    }
}

