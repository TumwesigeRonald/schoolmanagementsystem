/* =========================================================
   SCHOOL FINANCE MODULE (finance.js)
   ---------------------------------------------------------
   Fully isolated add-on feature, following the same pattern as
   class-summaries.js / teacher-toolbox.js. It does NOT define any
   new global state, does NOT touch studentsList/marksStorage, and
   does NOT modify any function that already exists in script.js/
   api.js. It only reads termSettings/studentsList/currentUser/ROLES
   (already kept in sync elsewhere) and calls the FinanceAPI client
   added to api.js (getFeeStructure/setFeeStructure/getPayments/
   recordPayment/deletePayment/getSummary), which itself talks to
   routes/finance.routes.js on the backend.

   Every request FinanceAPI makes automatically carries the Finance-
   scoped token (see apiRequest() in api.js) obtained by passing the
   password gate in script.js (openFinanceGate / FinanceAuthAPI) —
   this module never has to think about that token itself.

   Wiring into the rest of the app required exactly 2 minimal,
   additive touch-points elsewhere:
     1. script.js  -> showFinancePanel() (small wiring function next
                       to openFinanceGate) calls renderFinanceModule()/
                       initFinanceModule() instead of the old "Under
                       Construction" notice.
     2. index.html -> this file added as a new <script> tag.
   No existing array, function body, route, or DB model was changed
   to do this.

   Roles: Admin + Bursar can record payments and set fee structures
   (EDIT_ROLES, enforced server-side too — see finance.routes.js).
   Teacher gets the same views but every edit control is hidden/
   disabled, since the backend would reject the write anyway.
   ========================================================= */

const FINANCE_CLASSES = ['S.1', 'S.2', 'S.3', 'S.4', 'S.5', 'S.6'];
let financeReceiptCache = {}; // paymentId -> { payment, student } — populated whenever a receipt could be printed from, so print buttons don't need to re-fetch
let financeActiveSection = 'payments'; // 'payments' | 'fees' | 'summary' | 'defaulters'
let financePaymentsCache = []; // last-fetched balances list for the active class/term/year, so the search box can filter instantly without refetching
let financeCollectedChart = null; // Chart.js instances — kept so each canvas can be destroyed and redrawn
let financeMethodChart = null;    // cleanly whenever its section reloads (term/year change), instead of
let financeFlowChart = null;      // Chart.js throwing on a re-init of a canvas still attached to a chart.
let financeExpenseCatChart = null;
let financeRevenueCatChart = null;

// Small fixed color set for chart series — kept in one place so every
// donut/pie on the finance pages reads the same palette.
const FINANCE_CHART_COLORS = ['#0f766e', '#2563eb', '#f59e0b', '#a855f7', '#ec4899', '#64748b', '#22c55e', '#eab308'];

// Suggested categories (via <datalist>, not enforced) for the Expenses and
// Revenues forms — kept as free text like fee_payments.method, so a school
// isn't blocked from entering something that isn't on this list.
const FINANCE_EXPENSE_CATEGORIES = ['Salaries', 'Utilities', 'Maintenance & Repairs', 'Transport', 'Teaching Supplies', 'Boarding & Meals', 'Administration', 'Other'];
const FINANCE_REVENUE_CATEGORIES = ['Donations', 'Grants', 'Rent Income', 'Fundraising', 'Other Income'];

function financeCanEdit() {
    return currentUser.role === ROLES.ADMIN || currentUser.role === ROLES.BURSAR;
}
function formatUGX(amount) {
    const n = Number(amount) || 0;
    return 'UGX ' + n.toLocaleString('en-UG', { maximumFractionDigits: 0 });
}
function getFinanceViewedTermYear() {
    const termSelect = document.getElementById('fin-term-select');
    const yearInput = document.getElementById('fin-year-input');
    return {
        term: termSelect ? termSelect.value : termSettings.term,
        year: yearInput ? Number(yearInput.value) : termSettings.year
    };
}

/* ---------------------------------------------------------
   SHELL — term/year selector + section tabs, shared by all 3 views.
   --------------------------------------------------------- */
function renderFinanceModule() {
    const t = termSettings;
    return `
        <div class="space-y-6">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                <div class="flex flex-wrap items-end gap-4">
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Term</label>
                        <select id="fin-term-select" onchange="loadFinanceActiveSection()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                            <option value="Term 1" ${t.term === 'Term 1' ? 'selected' : ''}>Term 1</option>
                            <option value="Term 2" ${t.term === 'Term 2' ? 'selected' : ''}>Term 2</option>
                            <option value="Term 3" ${t.term === 'Term 3' ? 'selected' : ''}>Term 3</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Year</label>
                        <input type="number" id="fin-year-input" value="${t.year}" onchange="loadFinanceActiveSection()" class="w-24 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                    </div>
                </div>
                <button onclick="lockFinancePanel()" class="text-xs font-extrabold uppercase tracking-wider text-slate-500 hover:text-rose-600 transition"><i class="fa-solid fa-lock mr-1.5"></i>Lock Finance</button>
            </div>

            <div class="flex gap-2 border-b border-slate-200">
                <button id="fin-tab-payments" onclick="switchFinanceSection('payments')" class="finance-section-tab">Fees &amp; Payments</button>
                <button id="fin-tab-fees" onclick="switchFinanceSection('fees')" class="finance-section-tab">Fee Structure</button>
                <button id="fin-tab-expenses" onclick="switchFinanceSection('expenses')" class="finance-section-tab">Expenses</button>
                <button id="fin-tab-revenue" onclick="switchFinanceSection('revenue')" class="finance-section-tab">Revenue</button>
                <button id="fin-tab-summary" onclick="switchFinanceSection('summary')" class="finance-section-tab">Termly Summary</button>
                <button id="fin-tab-defaulters" onclick="switchFinanceSection('defaulters')" class="finance-section-tab">Defaulters</button>
            </div>
            <style>
                .finance-section-tab { padding: 10px 16px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; border-bottom: 2px solid transparent; transition: all .15s; }
                .finance-section-tab:hover { color: #0f766e; }
                .finance-section-tab.active { color: #0f766e; border-bottom-color: #0f766e; }
            </style>

            <div id="fin-section-body"></div>
        </div>
    `;
}

function initFinanceModule() {
    switchFinanceSection(financeActiveSection);
}

function switchFinanceSection(section) {
    financeActiveSection = section;
    ['payments', 'fees', 'expenses', 'revenue', 'summary', 'defaulters'].forEach(s => {
        const tabEl = document.getElementById(`fin-tab-${s}`);
        if (tabEl) tabEl.classList.toggle('active', s === section);
    });
    loadFinanceActiveSection();
}

function loadFinanceActiveSection() {
    if (financeActiveSection === 'fees') return loadFinanceFeeStructure();
    if (financeActiveSection === 'expenses') return loadFinanceLedger('expense');
    if (financeActiveSection === 'revenue') return loadFinanceLedger('revenue');
    if (financeActiveSection === 'summary') return loadFinanceSummary();
    if (financeActiveSection === 'defaulters') return loadFinanceDefaulters();
    return loadFinancePayments();
}

function lockFinancePanel() {
    FinanceAuthAPI.lock();
    switchTab(getPermissions(currentUser.role).defaultTab);
}

/* ---------------------------------------------------------
   FEE STRUCTURE — expected fee per class for the selected term/year.
   --------------------------------------------------------- */
async function loadFinanceFeeStructure() {
    const body = document.getElementById('fin-section-body');
    if (!body) return;
    const { term, year } = getFinanceViewedTermYear();
    body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading fee structure&hellip;</div>`;

    let rows = [];
    try {
        rows = await FinanceAPI.getFeeStructure(term, year);
    } catch (err) {
        body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-rose-500 text-xs font-semibold">${escapeHTML(err.message || "Couldn't load the fee structure.")}</div>`;
        return;
    }
    const byClass = {};
    rows.forEach(r => { byClass[r.class] = r.amount; });
    const canEdit = financeCanEdit();

    body.innerHTML = `
        <div class="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
            <p class="text-[11px] font-semibold text-slate-400 p-4 border-b border-slate-100">Expected fee per student, by class, for <span class="font-extrabold text-slate-600">${escapeHTML(term)}, ${escapeHTML(String(year))}</span>. ${canEdit ? 'Update an amount and click Save.' : 'View only — Admin/Bursar can update these.'}</p>
            <table class="w-full text-left text-xs text-slate-700">
                <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider"><tr>
                    <th class="p-3">Class</th><th class="p-3">Fee Amount (UGX)</th>${canEdit ? '<th class="p-3"></th>' : ''}
                </tr></thead>
                <tbody class="divide-y divide-slate-100">
                    ${FINANCE_CLASSES.map(c => `
                        <tr>
                            <td class="p-3 font-extrabold">${c}</td>
                            <td class="p-3">
                                ${canEdit
                                    ? `<input type="number" min="0" id="fin-fee-${c}" value="${byClass[c] != null ? byClass[c] : ''}" placeholder="0" class="w-32 p-2 bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold">`
                                    : formatUGX(byClass[c] || 0)}
                            </td>
                            ${canEdit ? `<td class="p-3"><button onclick="saveFinanceFeeAmount('${c}')" class="bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-extrabold uppercase py-1.5 px-3 rounded-lg transition">Save</button> <span id="fin-fee-saved-${c}" class="text-emerald-600 text-[11px] font-bold ml-1 hidden"><i class="fa-solid fa-check"></i></span></td>` : ''}
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

async function saveFinanceFeeAmount(className) {
    const input = document.getElementById(`fin-fee-${className}`);
    if (!input) return;
    const amount = Number(input.value);
    if (isNaN(amount) || amount < 0) return;
    const { term, year } = getFinanceViewedTermYear();
    try {
        await FinanceAPI.setFeeStructure(className, term, year, amount);
        const saved = document.getElementById(`fin-fee-saved-${className}`);
        if (saved) {
            saved.classList.remove('hidden');
            setTimeout(() => saved.classList.add('hidden'), 2000);
        }
    } catch (err) {
        alert(err.message || "Couldn't save that fee amount.");
    }
}

/* ---------------------------------------------------------
   PAYMENTS & BALANCES — per-student billed/paid/balance, filterable
   by class, with a per-student payment history + record-payment modal.
   --------------------------------------------------------- */
async function loadFinancePayments() {
    const body = document.getElementById('fin-section-body');
    if (!body) return;
    const { term, year } = getFinanceViewedTermYear();
    const classFilter = document.getElementById('fin-payments-class-select');
    const selectedClass = classFilter ? classFilter.value : '';
    const searchBox = document.getElementById('fin-payments-search');
    const searchValue = searchBox ? searchBox.value : '';

    body.innerHTML = `
        <div class="bg-white border border-slate-200 p-4 rounded-2xl shadow-xs flex flex-wrap items-end gap-4 mb-4">
            <div>
                <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Class</label>
                <select id="fin-payments-class-select" onchange="loadFinancePayments()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                    <option value="">All Classes</option>
                    ${FINANCE_CLASSES.map(c => `<option value="${c}" ${selectedClass === c ? 'selected' : ''}>${c}</option>`).join('')}
                </select>
            </div>
            <div class="flex-1 min-w-[180px]">
                <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Search Student</label>
                <div class="relative">
                    <i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                    <input type="text" id="fin-payments-search" oninput="applyFinancePaymentsFilter()" placeholder="Name or Student ID&hellip;" class="w-full pl-8 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                </div>
            </div>
        </div>
        <div id="fin-payments-table-wrapper" class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading balances&hellip;</div>
    `;
    // Re-apply filter values after the re-render above wiped them
    // (innerHTML replace resets <select>/<input> state).
    const reselect = document.getElementById('fin-payments-class-select');
    if (reselect) reselect.value = selectedClass;
    const research = document.getElementById('fin-payments-search');
    if (research) research.value = searchValue;

    const wrapper = document.getElementById('fin-payments-table-wrapper');
    try {
        financePaymentsCache = await FinanceAPI.getPayments({ term, year, class: selectedClass || undefined });
    } catch (err) {
        financePaymentsCache = [];
        wrapper.innerHTML = `<p class="text-rose-500 text-xs font-semibold">${escapeHTML(err.message || "Couldn't load balances.")}</p>`;
        return;
    }
    applyFinancePaymentsFilter();
}

// Filters the already-fetched balances list client-side by name or
// student ID — instant as the bursar types, no extra network call, and
// works across "All Classes" too so they can find one student quickly
// without knowing which class they're in.
function applyFinancePaymentsFilter() {
    const wrapper = document.getElementById('fin-payments-table-wrapper');
    if (!wrapper) return;
    const searchBox = document.getElementById('fin-payments-search');
    const query = (searchBox ? searchBox.value : '').trim().toLowerCase();

    const filtered = query
        ? financePaymentsCache.filter(s =>
            s.name.toLowerCase().includes(query) || String(s.id).toLowerCase().includes(query))
        : financePaymentsCache;

    if (!financePaymentsCache.length) {
        wrapper.outerHTML = `<div id="fin-payments-table-wrapper" class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium">No students found.</div>`;
        return;
    }
    if (!filtered.length) {
        wrapper.outerHTML = `<div id="fin-payments-table-wrapper" class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium">No student matches &ldquo;${escapeHTML(searchBox.value.trim())}&rdquo;.</div>`;
        return;
    }

    wrapper.outerHTML = `
        <div id="fin-payments-table-wrapper" class="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-auto max-h-[65vh]">
            <table class="w-full text-left text-xs text-slate-700">
                <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider sticky top-0"><tr>
                    <th class="p-3">Student</th><th class="p-3">Class</th><th class="p-3">Billed</th><th class="p-3">Paid</th><th class="p-3">Balance</th><th class="p-3"></th>
                </tr></thead>
                <tbody class="divide-y divide-slate-100">
                    ${filtered.map(s => {
                        const nameEsc = escapeHTML(s.name).replace(/'/g, "\\'");
                        const classEsc = escapeHTML(s.class).replace(/'/g, "\\'");
                        const reasonEsc = escapeHTML(s.customFeeReason || '').replace(/'/g, "\\'");
                        return `
                        <tr>
                            <td class="p-3 font-extrabold">${escapeHTML(s.name)}</td>
                            <td class="p-3">${escapeHTML(s.class)}</td>
                            <td class="p-3">
                                ${formatUGX(s.billed)}
                                ${s.hasCustomFee ? `<span title="${s.customFeeReason ? escapeHTML(s.customFeeReason) : 'Custom fee set for this student'}" class="ml-1 text-[9px] font-extrabold uppercase bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Custom</span>` : ''}
                                ${financeCanEdit() ? `<button onclick="openFeeOverrideModal('${s.id}', '${nameEsc}', '${classEsc}', ${s.billed}, ${s.hasCustomFee}, '${reasonEsc}')" class="ml-1 text-slate-400 hover:text-teal-600"><i class="fa-solid fa-pen text-[10px]"></i></button>` : ''}
                            </td>
                            <td class="p-3 text-emerald-600 font-bold">${formatUGX(s.paid)}</td>
                            <td class="p-3 font-extrabold ${s.balance > 0 ? 'text-rose-600' : 'text-emerald-600'}">${formatUGX(s.balance)}</td>
                            <td class="p-3 whitespace-nowrap">
                                <button onclick="openFinancePaymentHistory('${s.id}', '${nameEsc}')" class="text-slate-500 hover:text-teal-600 text-[11px] font-extrabold uppercase mr-3">History</button>
                                ${financeCanEdit() ? `<button onclick="openRecordFinancePaymentModal('${s.id}', '${nameEsc}', '${classEsc}')" class="bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-extrabold uppercase py-1.5 px-3 rounded-lg transition">Record Payment</button>` : ''}
                            </td>
                        </tr>
                    `; }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// Set/clear a per-student expected fee, overriding their class's default
// for this term/year (scholarship, sibling discount, extra charge, etc).
function openFeeOverrideModal(studentId, studentName, studentClass, currentBilled, hasCustomFee, currentReason) {
    const root = document.getElementById('modal-root');
    if (!root) return;
    root.innerHTML = `
        <div class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4" onclick="if(event.target===this) closeModal()">
            <div class="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
                <div class="p-6">
                    <h3 class="text-sm font-black text-slate-900 uppercase tracking-wider">Student Fee</h3>
                    <p class="text-xs font-semibold text-slate-500 mt-1 mb-4">${escapeHTML(studentName)} &middot; ${escapeHTML(studentClass)}</p>
                    <p class="text-[11px] text-slate-400 mb-3">${hasCustomFee ? 'This student has a custom fee for the selected term.' : "Currently billed the class's default fee. Set an amount below to override it just for this student."}</p>
                    <div class="space-y-2">
                        <input type="number" min="0" id="fin-override-amount" value="${currentBilled}" placeholder="Amount (UGX)" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                        <input type="text" id="fin-override-reason" value="${escapeHTML(currentReason || '')}" placeholder="Reason (optional) e.g. Scholarship" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                    </div>
                    <p id="fin-override-error" class="text-rose-600 text-xs font-bold mt-2 hidden"></p>
                    <div class="flex justify-between items-center gap-2 mt-5">
                        ${hasCustomFee ? `<button onclick="resetFeeOverride('${studentId}', '${escapeHTML(studentName).replace(/'/g, "\\'")}')" class="text-[11px] font-extrabold uppercase tracking-wider text-rose-500 hover:text-rose-700">Reset to Class Default</button>` : '<span></span>'}
                        <div class="flex gap-2">
                            <button onclick="closeModal()" class="text-xs font-extrabold uppercase tracking-wider text-slate-500 hover:text-slate-700 py-2.5 px-4 rounded-xl transition">Cancel</button>
                            <button id="fin-override-submit-btn" onclick="submitFeeOverride('${studentId}')" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-6 rounded-xl transition shadow-xs">Save</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    const amountInput = document.getElementById('fin-override-amount');
    if (amountInput) { amountInput.focus(); amountInput.select(); }
}

async function submitFeeOverride(studentId) {
    const amount = Number(document.getElementById('fin-override-amount').value);
    const reason = document.getElementById('fin-override-reason').value.trim();
    const errEl = document.getElementById('fin-override-error');
    const btn = document.getElementById('fin-override-submit-btn');
    if (errEl) errEl.classList.add('hidden');
    if (isNaN(amount) || amount < 0) {
        if (errEl) { errEl.textContent = 'Enter a valid amount.'; errEl.classList.remove('hidden'); }
        return;
    }
    const { term, year } = getFinanceViewedTermYear();
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        await FinanceAPI.setFeeOverride(studentId, term, year, amount, reason);
        closeModal();
        loadFinancePayments();
    } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
        if (errEl) { errEl.textContent = err.message || "Couldn't save that fee."; errEl.classList.remove('hidden'); }
    }
}

async function resetFeeOverride(studentId, studentName) {
    if (!confirm(`Reset ${studentName} back to the class's default fee?`)) return;
    const { term, year } = getFinanceViewedTermYear();
    try {
        await FinanceAPI.clearFeeOverride(studentId, term, year);
        closeModal();
        loadFinancePayments();
    } catch (err) {
        alert(err.message || "Couldn't reset that fee.");
    }
}

function openRecordFinancePaymentModal(studentId, studentName, studentClass) {
    const root = document.getElementById('modal-root');
    if (!root) return;
    root.innerHTML = `
        <div class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4" onclick="if(event.target===this) closeModal()">
            <div class="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
                <div class="p-6">
                    <h3 class="text-sm font-black text-slate-900 uppercase tracking-wider">Record Payment</h3>
                    <p class="text-xs font-semibold text-slate-500 mt-1 mb-4">${escapeHTML(studentName)}</p>
                    <div class="space-y-2">
                        <input type="number" min="1" id="fin-pay-amount" placeholder="Amount (UGX)" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                        <select id="fin-pay-method" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                            <option value="Cash">Cash</option>
                            <option value="Mobile Money">Mobile Money</option>
                            <option value="Bank">Bank</option>
                            <option value="Other">Other</option>
                        </select>
                        <input type="text" id="fin-pay-reference" placeholder="Reference / receipt no. (optional)" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                        <textarea id="fin-pay-note" placeholder="Note (optional)" rows="2" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold"></textarea>
                    </div>
                    <p id="fin-pay-error" class="text-rose-600 text-xs font-bold mt-2 hidden"></p>
                    <div class="flex justify-end gap-2 mt-5">
                        <button onclick="closeModal()" class="text-xs font-extrabold uppercase tracking-wider text-slate-500 hover:text-slate-700 py-2.5 px-4 rounded-xl transition">Cancel</button>
                        <button id="fin-pay-submit-btn" onclick="submitFinancePayment('${studentId}', '${escapeHTML(studentName).replace(/'/g, "\\'")}', '${escapeHTML(studentClass || '').replace(/'/g, "\\'")}')" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-6 rounded-xl transition shadow-xs">Record</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    const amountInput = document.getElementById('fin-pay-amount');
    if (amountInput) amountInput.focus();
}

async function submitFinancePayment(studentId, studentName, studentClass) {
    const amount = Number(document.getElementById('fin-pay-amount').value);
    const method = document.getElementById('fin-pay-method').value;
    const reference = document.getElementById('fin-pay-reference').value.trim();
    const note = document.getElementById('fin-pay-note').value.trim();
    const errEl = document.getElementById('fin-pay-error');
    const btn = document.getElementById('fin-pay-submit-btn');
    if (errEl) errEl.classList.add('hidden');
    if (!amount || amount <= 0) {
        if (errEl) { errEl.textContent = 'Enter a valid amount.'; errEl.classList.remove('hidden'); }
        return;
    }
    const { term, year } = getFinanceViewedTermYear();
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const created = await FinanceAPI.recordPayment({ studentId, term, year, amount, method, reference, note });
        financeReceiptCache[created.id] = { payment: created, student: { name: studentName, class: studentClass, term, year } };
        showFinancePaymentSuccess(created.id, studentName);
    } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Record'; }
        if (errEl) { errEl.textContent = err.message || "Couldn't record that payment."; errEl.classList.remove('hidden'); }
    }
}

// Swaps the Record Payment modal into a brief confirmation with a Print
// Receipt option, rather than closing immediately — bursars will want a
// receipt for most in-person payments, so this puts it one click away
// right when the payment is fresh instead of making them hunt through
// History afterwards.
function showFinancePaymentSuccess(paymentId, studentName) {
    const root = document.getElementById('modal-root');
    if (!root) return;
    root.innerHTML = `
        <div class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4">
            <div class="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
                <div class="p-6 text-center">
                    <i class="fa-solid fa-circle-check text-emerald-500 text-3xl mb-3"></i>
                    <h3 class="text-sm font-black text-slate-900 uppercase tracking-wider">Payment Recorded</h3>
                    <p class="text-xs font-semibold text-slate-500 mt-1 mb-5">${escapeHTML(studentName)}</p>
                    <div class="flex justify-center gap-2">
                        <button onclick="finishFinancePaymentModal()" class="text-xs font-extrabold uppercase tracking-wider text-slate-500 hover:text-slate-700 py-2.5 px-4 rounded-xl transition">Done</button>
                        <button onclick="printFinanceReceiptById(${paymentId}); finishFinancePaymentModal();" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-6 rounded-xl transition shadow-xs"><i class="fa-solid fa-print mr-1.5"></i>Print Receipt</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function finishFinancePaymentModal() {
    closeModal();
    loadFinancePayments();
}

async function openFinancePaymentHistory(studentId, studentName) {
    const root = document.getElementById('modal-root');
    if (!root) return;
    root.innerHTML = `
        <div class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4" onclick="if(event.target===this) closeModal()">
            <div class="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
                <div class="p-6">
                    <h3 class="text-sm font-black text-slate-900 uppercase tracking-wider">Payment History</h3>
                    <p class="text-xs font-semibold text-slate-500 mt-1 mb-4">${escapeHTML(studentName)}</p>
                    <div id="fin-history-body" class="text-xs text-slate-500"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading&hellip;</div>
                    <div class="flex justify-end mt-5">
                        <button onclick="closeModal()" class="text-xs font-extrabold uppercase tracking-wider text-slate-500 hover:text-slate-700 py-2.5 px-4 rounded-xl transition">Close</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    const { term, year } = getFinanceViewedTermYear();
    const historyBody = document.getElementById('fin-history-body');
    try {
        const data = await FinanceAPI.getPayments({ term, year, studentId });
        const history = data.history || [];
        const studentMeta = { name: studentName, class: data.class, term, year };
        history.forEach(h => { financeReceiptCache[h.id] = { payment: h, student: studentMeta }; });
        if (!history.length) {
            historyBody.innerHTML = `<p>No payments recorded yet for ${escapeHTML(term)}, ${escapeHTML(String(year))}.</p>`;
            return;
        }
        historyBody.innerHTML = `
            <ul class="divide-y divide-slate-100 max-h-64 overflow-auto">
                ${history.map(h => `
                    <li class="py-2 flex justify-between items-start gap-2">
                        <div>
                            <p class="font-extrabold text-slate-700">${formatUGX(h.amount)} <span class="font-semibold text-slate-400">&middot; ${escapeHTML(h.method || 'N/A')}</span></p>
                            <p class="text-[11px] text-slate-400">${new Date(h.createdAt).toLocaleString()} &middot; by ${escapeHTML(h.recordedBy || '—')}${h.reference ? ` &middot; Ref: ${escapeHTML(h.reference)}` : ''}</p>
                            ${h.note ? `<p class="text-[11px] text-slate-400 italic">${escapeHTML(h.note)}</p>` : ''}
                        </div>
                        <div class="shrink-0 flex items-center gap-3">
                            <button onclick="printFinanceReceiptById(${h.id})" class="text-slate-400 hover:text-teal-600 text-[11px] font-extrabold uppercase"><i class="fa-solid fa-print"></i></button>
                            ${financeCanEdit() ? `<button onclick="deleteFinancePayment(${h.id}, '${studentId}', '${escapeHTML(studentName).replace(/'/g, "\\'")}')" class="text-rose-500 hover:text-rose-700 text-[11px] font-extrabold uppercase"><i class="fa-solid fa-trash"></i></button>` : ''}
                        </div>
                    </li>
                `).join('')}
            </ul>
        `;
    } catch (err) {
        historyBody.innerHTML = `<p class="text-rose-500">${escapeHTML(err.message || "Couldn't load payment history.")}</p>`;
    }
}

async function deleteFinancePayment(paymentId, studentId, studentName) {
    if (!confirm('Delete this payment record? This cannot be undone.')) return;
    try {
        await FinanceAPI.deletePayment(paymentId);
        openFinancePaymentHistory(studentId, studentName); // refresh the open modal
        loadFinancePayments(); // refresh the balances table underneath
    } catch (err) {
        alert(err.message || "Couldn't delete that payment.");
    }
}

/* ---------------------------------------------------------
   TERMLY SUMMARY — billed/collected/outstanding by class + totals.
   --------------------------------------------------------- */
async function loadFinanceSummary() {
    const body = document.getElementById('fin-section-body');
    if (!body) return;
    const { term, year } = getFinanceViewedTermYear();
    body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading summary&hellip;</div>`;

    let data;
    try {
        data = await FinanceAPI.getSummary(term, year);
    } catch (err) {
        body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-rose-500 text-xs font-semibold">${escapeHTML(err.message || "Couldn't load the termly summary.")}</div>`;
        return;
    }

    // Finance Flow (revenue vs expenses, whole calendar year) is fetched
    // separately and best-effort — it's a bonus panel, so a failure here
    // (e.g. no expenses/revenue recorded yet) shouldn't block the rest of
    // the summary from rendering.
    let flowData = null;
    try {
        flowData = await FinanceAPI.getFinanceFlow(year);
    } catch (err) {
        flowData = null;
    }

    const collectionRate = data.totals.billed > 0 ? (data.totals.collected / data.totals.billed) * 100 : 0;

    body.innerHTML = `
        <div class="flex justify-end mb-3">
            <button onclick="printFinanceSummary()" style="background:var(--navy-900);" class="hover:opacity-90 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-print mr-1.5"></i>Print</button>
        </div>

        <!-- Stat cards -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
            ${[
                { label: 'Expected (Billed)', value: data.totals.billed, bg: '#2563eb' },
                { label: 'Collected', value: data.totals.collected, bg: '#0f766e' },
                { label: 'Outstanding', value: data.totals.outstanding, bg: '#e11d48' },
                { label: 'Collection Rate', value: collectionRate.toFixed(1) + '%', bg: '#a855f7', raw: true }
            ].map(card => `
                <div class="rounded-2xl shadow-xs p-4 text-white" style="background:${card.bg};">
                    <p class="text-2xl font-black leading-tight">${card.raw ? card.value : formatUGX(card.value)}</p>
                    <p class="text-[10px] font-extrabold uppercase tracking-wider opacity-90 mt-1">${card.label}</p>
                </div>
            `).join('')}
        </div>

        <!-- Charts -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
            <div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-4">
                <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">Fees Collected vs Outstanding</h4>
                <div style="height:220px;"><canvas id="fin-collected-chart"></canvas></div>
            </div>
            <div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-4">
                <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">Collections by Payment Method</h4>
                <div style="height:220px;">
                    ${data.byMethod && data.byMethod.length
                        ? '<canvas id="fin-method-chart"></canvas>'
                        : '<p class="text-center text-slate-400 text-xs font-medium pt-16">No payments recorded yet this term.</p>'}
                </div>
            </div>
        </div>

        <!-- Finance Flow (whole calendar year, independent of term) -->
        <div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-4 mb-5">
            <div class="flex items-center justify-between mb-2">
                <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider">Finance Flow &mdash; ${year}</h4>
                ${flowData ? `<span class="text-[11px] font-extrabold ${flowData.totals.net >= 0 ? 'text-emerald-600' : 'text-rose-600'}">Net: ${formatUGX(flowData.totals.net)}</span>` : ''}
            </div>
            ${flowData
                ? '<div style="height:260px;"><canvas id="fin-flow-chart"></canvas></div>'
                : '<p class="text-center text-slate-400 text-xs font-medium py-10">No expenses or revenue recorded for ' + year + ' yet &mdash; add some in the Expenses / Revenue tabs to see this chart.</p>'}
        </div>

        ${flowData && (flowData.expensesByCategory.length || flowData.otherRevenueByCategory.length) ? `
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
            <div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-4">
                <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">Expenses by Category (${year})</h4>
                <div style="height:220px;">
                    ${flowData.expensesByCategory.length ? '<canvas id="fin-expense-cat-chart"></canvas>' : '<p class="text-center text-slate-400 text-xs font-medium pt-16">No expenses recorded for ' + year + '.</p>'}
                </div>
            </div>
            <div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-4">
                <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">Other Revenue by Category (${year})</h4>
                <div style="height:220px;">
                    ${flowData.otherRevenueByCategory.length ? '<canvas id="fin-revenue-cat-chart"></canvas>' : '<p class="text-center text-slate-400 text-xs font-medium pt-16">No non-fee revenue recorded for ' + year + '.</p>'}
                </div>
            </div>
        </div>
        ` : ''}

        <div id="fin-summary-preview" class="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
            <div class="p-5 border-b border-slate-100">
                <h3 class="text-sm font-black text-slate-800 uppercase tracking-wide">Termly Financial Summary</h3>
                <p class="text-[11px] font-semibold text-slate-400">${escapeHTML(term)}, ${escapeHTML(String(year))}</p>
            </div>
            <table class="w-full text-left text-xs text-slate-700">
                <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider"><tr>
                    <th class="p-3">Class</th><th class="p-3">Students</th><th class="p-3">Avg Fee/Student</th><th class="p-3">Billed</th><th class="p-3">Collected</th><th class="p-3">Outstanding</th>
                </tr></thead>
                <tbody class="divide-y divide-slate-100">
                    ${data.byClass.map(c => `
                        <tr>
                            <td class="p-3 font-extrabold">${escapeHTML(c.class)}</td>
                            <td class="p-3">${c.studentCount}</td>
                            <td class="p-3">${formatUGX(c.studentCount ? c.billed / c.studentCount : 0)}</td>
                            <td class="p-3">${formatUGX(c.billed)}</td>
                            <td class="p-3 text-emerald-600 font-bold">${formatUGX(c.collected)}</td>
                            <td class="p-3 font-extrabold ${c.outstanding > 0 ? 'text-rose-600' : 'text-emerald-600'}">${formatUGX(c.outstanding)}</td>
                        </tr>
                    `).join('')}
                </tbody>
                <tfoot class="bg-slate-50 font-extrabold text-slate-800 border-t-2 border-slate-200"><tr>
                    <td class="p-3" colspan="3">TOTAL</td>
                    <td class="p-3">${formatUGX(data.totals.billed)}</td>
                    <td class="p-3 text-emerald-700">${formatUGX(data.totals.collected)}</td>
                    <td class="p-3 text-rose-700">${formatUGX(data.totals.outstanding)}</td>
                </tr></tfoot>
            </table>
        </div>
    `;

    renderFinanceSummaryCharts(data);
    if (flowData) renderFinanceFlowCharts(flowData);
}

// Draws/redraws the two Chart.js canvases on the summary page. Destroys any
// previous instance first — required because loadFinanceSummary() re-injects
// the <canvas> elements every time the term/year changes, and Chart.js
// throws if you re-init a canvas that's still attached to a live chart.
function renderFinanceSummaryCharts(data) {
    if (typeof Chart === 'undefined') return; // Chart.js failed to load (e.g. offline) — charts just won't render

    if (financeCollectedChart) { financeCollectedChart.destroy(); financeCollectedChart = null; }
    if (financeMethodChart) { financeMethodChart.destroy(); financeMethodChart = null; }

    const collectedCanvas = document.getElementById('fin-collected-chart');
    if (collectedCanvas) {
        const collected = data.totals.collected || 0;
        const outstanding = data.totals.outstanding || 0;
        financeCollectedChart = new Chart(collectedCanvas, {
            type: 'doughnut',
            data: {
                labels: ['Collected', 'Outstanding'],
                datasets: [{ data: [collected, outstanding], backgroundColor: ['#0f766e', '#e11d48'], borderWidth: 0 }]
            },
            options: {
                maintainAspectRatio: false,
                cutout: '65%',
                plugins: {
                    legend: { position: 'bottom', labels: { font: { size: 11, weight: 'bold' }, boxWidth: 10 } },
                    tooltip: { callbacks: { label: ctx => `${ctx.label}: ${formatUGX(ctx.raw)}` } }
                }
            }
        });
    }

    const methodCanvas = document.getElementById('fin-method-chart');
    if (methodCanvas && data.byMethod && data.byMethod.length) {
        financeMethodChart = new Chart(methodCanvas, {
            type: 'doughnut',
            data: {
                labels: data.byMethod.map(m => m.method),
                datasets: [{
                    data: data.byMethod.map(m => m.amount),
                    backgroundColor: data.byMethod.map((_, i) => FINANCE_CHART_COLORS[i % FINANCE_CHART_COLORS.length]),
                    borderWidth: 0
                }]
            },
            options: {
                maintainAspectRatio: false,
                cutout: '65%',
                plugins: {
                    legend: { position: 'bottom', labels: { font: { size: 11, weight: 'bold' }, boxWidth: 10 } },
                    tooltip: { callbacks: { label: ctx => `${ctx.label}: ${formatUGX(ctx.raw)}` } }
                }
            }
        });
    }
}

// Draws the Finance Flow line chart + the two category donuts on the
// summary page. Separate from renderFinanceSummaryCharts() above because
// this data (flowData) is fetched independently and can be null (no
// expenses/revenue recorded yet) without blocking the rest of the summary.
function renderFinanceFlowCharts(flowData) {
    if (typeof Chart === 'undefined') return;

    if (financeFlowChart) { financeFlowChart.destroy(); financeFlowChart = null; }
    if (financeExpenseCatChart) { financeExpenseCatChart.destroy(); financeExpenseCatChart = null; }
    if (financeRevenueCatChart) { financeRevenueCatChart.destroy(); financeRevenueCatChart = null; }

    const flowCanvas = document.getElementById('fin-flow-chart');
    if (flowCanvas) {
        const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        financeFlowChart = new Chart(flowCanvas, {
            type: 'line',
            data: {
                labels: monthLabels,
                datasets: [
                    { label: 'Revenue', data: flowData.months.map(m => m.revenue), borderColor: '#2563eb', backgroundColor: '#2563eb22', fill: true, tension: 0.3 },
                    { label: 'Expenses', data: flowData.months.map(m => m.expenses), borderColor: '#e11d48', backgroundColor: '#e11d4822', fill: true, tension: 0.3 }
                ]
            },
            options: {
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { font: { size: 11, weight: 'bold' }, boxWidth: 10 } },
                    tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${formatUGX(ctx.raw)}` } }
                },
                scales: {
                    y: { ticks: { callback: v => formatUGX(v) } }
                }
            }
        });
    }

    const expenseCatCanvas = document.getElementById('fin-expense-cat-chart');
    if (expenseCatCanvas && flowData.expensesByCategory.length) {
        financeExpenseCatChart = new Chart(expenseCatCanvas, {
            type: 'doughnut',
            data: {
                labels: flowData.expensesByCategory.map(c => c.category),
                datasets: [{
                    data: flowData.expensesByCategory.map(c => c.amount),
                    backgroundColor: flowData.expensesByCategory.map((_, i) => FINANCE_CHART_COLORS[i % FINANCE_CHART_COLORS.length]),
                    borderWidth: 0
                }]
            },
            options: {
                maintainAspectRatio: false,
                cutout: '65%',
                plugins: {
                    legend: { position: 'bottom', labels: { font: { size: 11, weight: 'bold' }, boxWidth: 10 } },
                    tooltip: { callbacks: { label: ctx => `${ctx.label}: ${formatUGX(ctx.raw)}` } }
                }
            }
        });
    }

    const revenueCatCanvas = document.getElementById('fin-revenue-cat-chart');
    if (revenueCatCanvas && flowData.otherRevenueByCategory.length) {
        financeRevenueCatChart = new Chart(revenueCatCanvas, {
            type: 'doughnut',
            data: {
                labels: flowData.otherRevenueByCategory.map(c => c.category),
                datasets: [{
                    data: flowData.otherRevenueByCategory.map(c => c.amount),
                    backgroundColor: flowData.otherRevenueByCategory.map((_, i) => FINANCE_CHART_COLORS[i % FINANCE_CHART_COLORS.length]),
                    borderWidth: 0
                }]
            },
            options: {
                maintainAspectRatio: false,
                cutout: '65%',
                plugins: {
                    legend: { position: 'bottom', labels: { font: { size: 11, weight: 'bold' }, boxWidth: 10 } },
                    tooltip: { callbacks: { label: ctx => `${ctx.label}: ${formatUGX(ctx.raw)}` } }
                }
            }
        });
    }
}

/* ---------------------------------------------------------
   EXPENSES & REVENUE — a shared ledger UI for both. Money spent
   (salaries, utilities, maintenance…) and non-fee income (donations,
   grants, fundraising…) are each their own table on the backend, but
   the add-entry form + list + delete flow is identical, so one
   function serves both tabs, parameterized by `type`.
   Filtered by the calendar YEAR from the shared term/year selector
   (the term itself doesn't apply — expenses/revenue are dated, not
   termly — so only the year half of that selector is used here).
   --------------------------------------------------------- */
const FINANCE_LEDGER_CONFIG = {
    expense: {
        title: 'Expenses', singular: 'expense', color: 'rose',
        categories: FINANCE_EXPENSE_CATEGORIES,
        list: (year) => FinanceAPI.listExpenses(year),
        add: (entry) => FinanceAPI.addExpense(entry),
        remove: (id) => FinanceAPI.deleteExpense(id)
    },
    revenue: {
        title: 'Revenue (Non-Fee Income)', singular: 'revenue entry', color: 'emerald',
        categories: FINANCE_REVENUE_CATEGORIES,
        list: (year) => FinanceAPI.listRevenues(year),
        add: (entry) => FinanceAPI.addRevenue(entry),
        remove: (id) => FinanceAPI.deleteRevenue(id)
    }
};

async function loadFinanceLedger(type) {
    const cfg = FINANCE_LEDGER_CONFIG[type];
    const body = document.getElementById('fin-section-body');
    if (!body) return;
    const { year } = getFinanceViewedTermYear();
    body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading ${escapeHTML(cfg.title.toLowerCase())}&hellip;</div>`;

    let entries = [];
    try {
        entries = await cfg.list(year);
    } catch (err) {
        body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-rose-500 text-xs font-semibold">${escapeHTML(err.message || `Couldn't load ${cfg.title.toLowerCase()}.`)}</div>`;
        return;
    }

    const total = entries.reduce((sum, e) => sum + e.amount, 0);
    const todayISO = new Date().toISOString().slice(0, 10);

    body.innerHTML = `
        ${financeCanEdit() ? `
        <div class="bg-white border border-slate-200 p-4 rounded-2xl shadow-xs mb-4">
            <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-3">Record a new ${escapeHTML(cfg.singular)}</h4>
            <div class="flex flex-wrap items-end gap-3">
                <div>
                    <label class="block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Category</label>
                    <input list="fin-ledger-categories-${type}" id="fin-ledger-category" placeholder="e.g. ${escapeHTML(cfg.categories[0])}" class="w-44 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                    <datalist id="fin-ledger-categories-${type}">
                        ${cfg.categories.map(c => `<option value="${escapeHTML(c)}">`).join('')}
                    </datalist>
                </div>
                <div>
                    <label class="block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Amount (UGX)</label>
                    <input type="number" min="0" id="fin-ledger-amount" placeholder="0" class="w-32 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold">
                </div>
                <div>
                    <label class="block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Date</label>
                    <input type="date" id="fin-ledger-date" value="${todayISO}" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold">
                </div>
                <div class="flex-1 min-w-[160px]">
                    <label class="block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Note (optional)</label>
                    <input type="text" id="fin-ledger-note" placeholder="Short description&hellip;" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                </div>
                <button onclick="submitFinanceLedgerEntry('${type}')" class="bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-extrabold uppercase py-2.5 px-4 rounded-xl transition">Add</button>
            </div>
            <p id="fin-ledger-error" class="text-rose-500 text-[11px] font-semibold mt-2 hidden"></p>
        </div>
        ` : ''}

        <div class="bg-white border border-slate-200 p-4 rounded-2xl shadow-xs mb-4">
            <p class="text-xs font-semibold text-slate-600">Total ${escapeHTML(cfg.title.toLowerCase())} recorded for <span class="font-extrabold text-slate-800">${year}</span>: <span class="font-extrabold text-${cfg.color}-600">${formatUGX(total)}</span></p>
        </div>

        ${!entries.length
            ? `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium">No ${escapeHTML(cfg.title.toLowerCase())} recorded for ${year} yet.</div>`
            : `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-auto max-h-[55vh]">
                <table class="w-full text-left text-xs text-slate-700">
                    <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider sticky top-0"><tr>
                        <th class="p-3">Date</th><th class="p-3">Category</th><th class="p-3">Amount</th><th class="p-3">Note</th><th class="p-3">Recorded By</th>${financeCanEdit() ? '<th class="p-3"></th>' : ''}
                    </tr></thead>
                    <tbody class="divide-y divide-slate-100">
                        ${entries.map(e => `
                            <tr>
                                <td class="p-3">${escapeHTML(new Date(e.date).toLocaleDateString())}</td>
                                <td class="p-3 font-extrabold">${escapeHTML(e.category)}</td>
                                <td class="p-3 text-${cfg.color}-600 font-bold">${formatUGX(e.amount)}</td>
                                <td class="p-3 text-slate-500">${e.note ? escapeHTML(e.note) : '&mdash;'}</td>
                                <td class="p-3 text-slate-500">${escapeHTML(e.recordedBy || '—')}</td>
                                ${financeCanEdit() ? `<td class="p-3"><button onclick="deleteFinanceLedgerEntry('${type}', ${e.id})" class="text-rose-500 hover:text-rose-700 text-[11px] font-extrabold uppercase"><i class="fa-solid fa-trash"></i></button></td>` : ''}
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>`}
    `;
}

async function submitFinanceLedgerEntry(type) {
    const cfg = FINANCE_LEDGER_CONFIG[type];
    const category = (document.getElementById('fin-ledger-category').value || '').trim();
    const amount = Number(document.getElementById('fin-ledger-amount').value);
    const date = document.getElementById('fin-ledger-date').value || undefined;
    const note = document.getElementById('fin-ledger-note').value || undefined;
    const errorEl = document.getElementById('fin-ledger-error');

    if (!category || !amount || amount <= 0) {
        if (errorEl) { errorEl.textContent = 'A category and a positive amount are required.'; errorEl.classList.remove('hidden'); }
        return;
    }
    try {
        await cfg.add({ category, amount, date, note });
        loadFinanceLedger(type);
    } catch (err) {
        if (errorEl) { errorEl.textContent = err.message || `Couldn't save that ${cfg.singular}.`; errorEl.classList.remove('hidden'); }
    }
}

async function deleteFinanceLedgerEntry(type, id) {
    const cfg = FINANCE_LEDGER_CONFIG[type];
    if (!confirm(`Delete this ${cfg.singular}? This cannot be undone.`)) return;
    try {
        await cfg.remove(id);
        loadFinanceLedger(type);
    } catch (err) {
        alert(err.message || `Couldn't delete that ${cfg.singular}.`);
    }
}

/* ---------------------------------------------------------
   DEFAULTERS — students with an outstanding balance for the selected
   term/year, sorted highest balance first. Reuses the same balances
   endpoint as the Payments tab (fetched once for all classes), so no
   new backend route was needed — just filtered/sorted client-side.
   --------------------------------------------------------- */
async function loadFinanceDefaulters() {
    const body = document.getElementById('fin-section-body');
    if (!body) return;
    const { term, year } = getFinanceViewedTermYear();
    body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading defaulters&hellip;</div>`;

    let students = [];
    try {
        students = await FinanceAPI.getPayments({ term, year });
    } catch (err) {
        body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-rose-500 text-xs font-semibold">${escapeHTML(err.message || "Couldn't load defaulters.")}</div>`;
        return;
    }

    const defaulters = students.filter(s => s.balance > 0).sort((a, b) => b.balance - a.balance);
    const totalOwed = defaulters.reduce((sum, s) => sum + s.balance, 0);

    if (!defaulters.length) {
        body.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-emerald-600 text-xs font-bold"><i class="fa-solid fa-circle-check mr-1.5"></i>No outstanding balances for ${escapeHTML(term)}, ${escapeHTML(String(year))} &mdash; every student is fully paid up.</div>`;
        return;
    }

    body.innerHTML = `
        <div class="bg-white border border-slate-200 p-4 rounded-2xl shadow-xs mb-4 flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs font-semibold text-slate-600"><span class="font-extrabold text-rose-600">${defaulters.length}</span> student${defaulters.length === 1 ? '' : 's'} owing a total of <span class="font-extrabold text-rose-600">${formatUGX(totalOwed)}</span> for ${escapeHTML(term)}, ${escapeHTML(String(year))}.</p>
        </div>
        <div class="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-auto max-h-[65vh]">
            <table class="w-full text-left text-xs text-slate-700">
                <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider sticky top-0"><tr>
                    <th class="p-3">Student</th><th class="p-3">Class</th><th class="p-3">Billed</th><th class="p-3">Paid</th><th class="p-3">Balance</th><th class="p-3"></th>
                </tr></thead>
                <tbody class="divide-y divide-slate-100">
                    ${defaulters.map(s => {
                        const nameEsc = escapeHTML(s.name).replace(/'/g, "\\'");
                        const classEsc = escapeHTML(s.class).replace(/'/g, "\\'");
                        return `
                        <tr>
                            <td class="p-3 font-extrabold">${escapeHTML(s.name)}</td>
                            <td class="p-3">${escapeHTML(s.class)}</td>
                            <td class="p-3">${formatUGX(s.billed)}</td>
                            <td class="p-3 text-emerald-600 font-bold">${formatUGX(s.paid)}</td>
                            <td class="p-3 font-extrabold text-rose-600">${formatUGX(s.balance)}</td>
                            <td class="p-3 whitespace-nowrap">
                                <button onclick="openFinancePaymentHistory('${s.id}', '${nameEsc}')" class="text-slate-500 hover:text-teal-600 text-[11px] font-extrabold uppercase mr-3">History</button>
                                ${financeCanEdit() ? `<button onclick="openRecordFinancePaymentModal('${s.id}', '${nameEsc}', '${classEsc}')" class="bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-extrabold uppercase py-1.5 px-3 rounded-lg transition">Record Payment</button>` : ''}
                            </td>
                        </tr>
                    `; }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// Copies the on-screen summary into the app's shared #print-area (the
// same element/pattern printOwnReportCard() and other print buttons
// already use) and triggers the browser print dialog.
function printFinanceSummary() {
    const preview = document.getElementById('fin-summary-preview');
    const printArea = document.getElementById('print-area');
    if (!preview || !printArea) return;
    printArea.innerHTML = preview.outerHTML;
    window.print();
}

/* ---------------------------------------------------------
   RECEIPTS — printable proof of a single payment. Reuses the shared
   #print-area element (same mechanism as printFinanceSummary() above
   and the report-card print buttons elsewhere in the app).
   --------------------------------------------------------- */
function printFinanceReceiptById(paymentId) {
    const entry = financeReceiptCache[paymentId];
    if (!entry) { alert("That receipt isn't available anymore — reopen this student's history and try again."); return; }
    printFinanceReceipt(entry.payment, entry.student);
}

function printFinanceReceipt(payment, student) {
    const printArea = document.getElementById('print-area');
    if (!printArea) return;
    printArea.innerHTML = `
        <div style="max-width:480px;margin:0 auto;font-family:Arial,sans-serif;color:#111;padding:24px;border:1px solid #ccc;">
            <div style="text-align:center;border-bottom:2px solid #0f766e;padding-bottom:12px;margin-bottom:16px;">
                <img src="school_badge.jpg" style="height:60px;margin-bottom:6px;" alt="School Badge">
                <h2 style="margin:0;font-size:16px;letter-spacing:0.03em;">LUWEERO COMMUNITY SECONDARY SCHOOL</h2>
                <p style="margin:2px 0;font-size:11px;">P.O BOX 29540, KAMPALA-UGANDA</p>
                <p style="margin:2px 0;font-size:11px;">TEL: 0772620552 / 0782572120 / 0740773771</p>
            </div>
            <h3 style="text-align:center;margin:0 0 16px;font-size:14px;letter-spacing:0.08em;">OFFICIAL PAYMENT RECEIPT</h3>
            <table style="width:100%;font-size:12px;border-collapse:collapse;">
                <tr><td style="padding:4px 0;color:#555;">Receipt No.</td><td style="padding:4px 0;text-align:right;font-weight:bold;">RCT-${payment.id}</td></tr>
                <tr><td style="padding:4px 0;color:#555;">Date</td><td style="padding:4px 0;text-align:right;">${new Date(payment.createdAt).toLocaleString()}</td></tr>
                <tr><td style="padding:4px 0;color:#555;">Student</td><td style="padding:4px 0;text-align:right;font-weight:bold;">${escapeHTML(student.name || '')}</td></tr>
                <tr><td style="padding:4px 0;color:#555;">Class</td><td style="padding:4px 0;text-align:right;">${escapeHTML(student.class || '')}</td></tr>
                <tr><td style="padding:4px 0;color:#555;">Term / Year</td><td style="padding:4px 0;text-align:right;">${escapeHTML(student.term || '')}, ${escapeHTML(String(student.year || ''))}</td></tr>
            </table>
            <div style="border-top:1px dashed #999;border-bottom:1px dashed #999;margin:14px 0;padding:12px 0;">
                <table style="width:100%;font-size:12px;">
                    <tr><td style="color:#555;">Amount Paid</td><td style="text-align:right;font-size:16px;font-weight:bold;">${formatUGX(payment.amount)}</td></tr>
                    <tr><td style="color:#555;padding-top:4px;">Method</td><td style="text-align:right;padding-top:4px;">${escapeHTML(payment.method || 'N/A')}</td></tr>
                    ${payment.reference ? `<tr><td style="color:#555;">Reference</td><td style="text-align:right;">${escapeHTML(payment.reference)}</td></tr>` : ''}
                </table>
            </div>
            <table style="width:100%;font-size:11px;color:#555;">
                <tr><td>Received by</td><td style="text-align:right;">${escapeHTML(payment.recordedBy || '—')}</td></tr>
            </table>
            <p style="text-align:center;font-size:10px;color:#999;margin-top:20px;">This is a system-generated receipt. Not valid without an official school stamp.</p>
        </div>
    `;
    window.print();
}
