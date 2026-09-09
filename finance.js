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
let financeActiveSection = 'payments'; // 'payments' | 'fees' | 'summary'

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
                <button id="fin-tab-summary" onclick="switchFinanceSection('summary')" class="finance-section-tab">Termly Summary</button>
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
    ['payments', 'fees', 'summary'].forEach(s => {
        const tabEl = document.getElementById(`fin-tab-${s}`);
        if (tabEl) tabEl.classList.toggle('active', s === section);
    });
    loadFinanceActiveSection();
}

function loadFinanceActiveSection() {
    if (financeActiveSection === 'fees') return loadFinanceFeeStructure();
    if (financeActiveSection === 'summary') return loadFinanceSummary();
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

    body.innerHTML = `
        <div class="bg-white border border-slate-200 p-4 rounded-2xl shadow-xs flex items-end gap-4 mb-4">
            <div>
                <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Class</label>
                <select id="fin-payments-class-select" onchange="loadFinancePayments()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                    <option value="">All Classes</option>
                    ${FINANCE_CLASSES.map(c => `<option value="${c}" ${selectedClass === c ? 'selected' : ''}>${c}</option>`).join('')}
                </select>
            </div>
        </div>
        <div id="fin-payments-table-wrapper" class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading balances&hellip;</div>
    `;
    // Re-apply the class filter's selected value after the re-render above
    // wiped it (innerHTML replace resets <select> state).
    const reselect = document.getElementById('fin-payments-class-select');
    if (reselect) reselect.value = selectedClass;

    const wrapper = document.getElementById('fin-payments-table-wrapper');
    let students = [];
    try {
        students = await FinanceAPI.getPayments({ term, year, class: selectedClass || undefined });
    } catch (err) {
        wrapper.innerHTML = `<p class="text-rose-500 text-xs font-semibold">${escapeHTML(err.message || "Couldn't load balances.")}</p>`;
        return;
    }

    if (!students.length) {
        wrapper.innerHTML = `<p class="text-slate-400 text-xs font-medium">No students found${selectedClass ? ` in ${escapeHTML(selectedClass)}` : ''}.</p>`;
        return;
    }

    wrapper.outerHTML = `
        <div id="fin-payments-table-wrapper" class="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-auto max-h-[65vh]">
            <table class="w-full text-left text-xs text-slate-700">
                <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider sticky top-0"><tr>
                    <th class="p-3">Student</th><th class="p-3">Class</th><th class="p-3">Billed</th><th class="p-3">Paid</th><th class="p-3">Balance</th><th class="p-3"></th>
                </tr></thead>
                <tbody class="divide-y divide-slate-100">
                    ${students.map(s => `
                        <tr>
                            <td class="p-3 font-extrabold">${escapeHTML(s.name)}</td>
                            <td class="p-3">${escapeHTML(s.class)}</td>
                            <td class="p-3">${formatUGX(s.billed)}</td>
                            <td class="p-3 text-emerald-600 font-bold">${formatUGX(s.paid)}</td>
                            <td class="p-3 font-extrabold ${s.balance > 0 ? 'text-rose-600' : 'text-emerald-600'}">${formatUGX(s.balance)}</td>
                            <td class="p-3 whitespace-nowrap">
                                <button onclick="openFinancePaymentHistory('${s.id}', '${escapeHTML(s.name).replace(/'/g, "\\'")}')" class="text-slate-500 hover:text-teal-600 text-[11px] font-extrabold uppercase mr-3">History</button>
                                ${financeCanEdit() ? `<button onclick="openRecordFinancePaymentModal('${s.id}', '${escapeHTML(s.name).replace(/'/g, "\\'")}', '${escapeHTML(s.class).replace(/'/g, "\\'")}')" class="bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-extrabold uppercase py-1.5 px-3 rounded-lg transition">Record Payment</button>` : ''}
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
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

    body.innerHTML = `
        <div class="flex justify-end mb-3">
            <button onclick="printFinanceSummary()" style="background:var(--navy-900);" class="hover:opacity-90 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-print mr-1.5"></i>Print</button>
        </div>
        <div id="fin-summary-preview" class="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
            <div class="p-5 border-b border-slate-100">
                <h3 class="text-sm font-black text-slate-800 uppercase tracking-wide">Termly Financial Summary</h3>
                <p class="text-[11px] font-semibold text-slate-400">${escapeHTML(term)}, ${escapeHTML(String(year))}</p>
            </div>
            <table class="w-full text-left text-xs text-slate-700">
                <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider"><tr>
                    <th class="p-3">Class</th><th class="p-3">Students</th><th class="p-3">Fee/Student</th><th class="p-3">Billed</th><th class="p-3">Collected</th><th class="p-3">Outstanding</th>
                </tr></thead>
                <tbody class="divide-y divide-slate-100">
                    ${data.byClass.map(c => `
                        <tr>
                            <td class="p-3 font-extrabold">${escapeHTML(c.class)}</td>
                            <td class="p-3">${c.studentCount}</td>
                            <td class="p-3">${formatUGX(c.feePerStudent)}</td>
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
