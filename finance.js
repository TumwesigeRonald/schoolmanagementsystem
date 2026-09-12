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

   Roles: Admin, Bursar, Human Resource, and Director can all record
   payments and set fee structures (EDIT_ROLES, enforced server-side too
   — see finance.routes.js). Teacher gets the same views but every edit
   control is hidden/disabled, since the backend would reject the write
   anyway.
   ========================================================= */

const FINANCE_CLASSES = ['S.1', 'S.2', 'S.3', 'S.4', 'S.5', 'S.6'];
let financeReceiptCache = {}; // paymentId -> { payment, student } — populated whenever a receipt could be printed from, so print buttons don't need to re-fetch
let financeActiveSection = 'payments'; // 'payments' | 'fees' | 'summary' | 'defaulters'
let financeActiveCategory = null; // 'fees' | 'payroll' | 'ledger' — set on first render by getFinanceCategories()
let financePaymentsCache = []; // last-fetched balances list for the active class/term/year, so the search box can filter instantly without refetching
let financeCollectedChart = null; // Chart.js instances — kept so each canvas can be destroyed and redrawn
let financeMethodChart = null;    // cleanly whenever its section reloads (term/year change), instead of
let financeFlowChart = null;      // Chart.js throwing on a re-init of a canvas still attached to a chart.
let financeExpenseCatChart = null;
let financeRevenueCatChart = null;
let financeSummaryDataCache = null; // last-fetched getSummary() result, kept only so exportFinanceSummaryPDF() can rebuild the report without refetching
let financeSummaryFlowCache = null; // last-fetched getFinanceFlow() result, same reason (null if it failed/had nothing to show)

// Small fixed color set for chart series — kept in one place so every
// donut/pie on the finance pages reads the same palette.
const FINANCE_CHART_COLORS = ['#0f766e', '#2563eb', '#f59e0b', '#a855f7', '#ec4899', '#64748b', '#22c55e', '#eab308'];

// Suggested categories (via <datalist>, not enforced) for the Expenses and
// Revenues forms — kept as free text like fee_payments.method, so a school
// isn't blocked from entering something that isn't on this list.
const FINANCE_EXPENSE_CATEGORIES = ['Salaries', 'Utilities', 'Maintenance & Repairs', 'Transport', 'Teaching Supplies', 'Boarding & Meals', 'Administration', 'Other'];
const FINANCE_REVENUE_CATEGORIES = ['Donations', 'Grants', 'Rent Income', 'Fundraising', 'Other Income'];

// All four Finance-gated roles get full read/write on Student Fees (see
// EDIT_ROLES in finance.routes.js) — Payroll is one place Bursar is
// excluded (see payrollCanAccess() in payroll.js); Expenses/Revenues is
// another (see below) — those two exclusions are independent of each
// other (HR/Director have both; Bursar has neither).
// All four Finance-gated roles get full read/write on Student Fees (see
// EDIT_ROLES in finance.routes.js) — Payroll is one place Bursar is
// excluded (see payrollCanAccess() in payroll.js); Expenses/Revenues is
// another (see below) — those two exclusions are independent of each
// other (HR/Director have both; Bursar has neither).
function financeCanEdit() {
    return [ROLES.ADMIN, ROLES.BURSAR, ROLES.HR, ROLES.DIRECTOR].includes(currentUser.role);
}
// Bursar is deliberately NOT in this list — matches EXPENSE_REVENUE_ROLES
// in finance.routes.js exactly. Blocks VIEW too, not just edit, so the
// Expenses/Revenue tabs (and the Financial Overview cards derived from
// the same data) are hidden rather than shown read-only.
function financeCanViewExpensesRevenues() {
    return [ROLES.ADMIN, ROLES.HR, ROLES.DIRECTOR].includes(currentUser.role);
}
// Matches SALARY_ADVANCE_ROLES in payroll.routes.js — the one payroll-
// adjacent capability Bursar DOES get, despite payrollCanAccess() (the
// general Payroll tab) being false for them.
function financeCanAccessSalaryAdvances() {
    return [ROLES.ADMIN, ROLES.BURSAR, ROLES.HR, ROLES.DIRECTOR].includes(currentUser.role);
}
// Part-Time Weekly Payroll is a SEPARATE track from the general Payroll
// tab (see routes/part-time-payroll.routes.js) — Full-Time staff are
// paid monthly by Admin/HR/Director (unchanged, payrollCanAccess());
// Part-Time staff are paid weekly at the Bursar's office with no
// HR/Director approval step. All four finance roles can VIEW this tab
// (matches VIEW_ROLES server-side); only Admin/Bursar can record
// entries or mark them paid (matches EDIT_ROLES server-side) — HR/
// Director get read-only oversight, same principle as Teacher's old
// view-only tier elsewhere in this file.
function partTimePayrollCanEdit() {
    return [ROLES.ADMIN, ROLES.BURSAR].includes(currentUser.role);
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
   SHELL — overview metrics + term/year selector + section tabs,
   shared by all views (including Payroll).
   --------------------------------------------------------- */
/* ---------------------------------------------------------
   HYBRID NAVIGATION — category tabs (top level, 2-3 per role) with an
   accordion section list inside each category. Replaces the old flat
   row of up to 9 tabs. Two problems this solves at once:

   1. CLUTTER — Bursar now sees 2 category tabs instead of 5 flat ones;
      Admin/HR/Director see 3 instead of up to 8. Every existing
      section (Fees & Payments, Fee Structure, etc.) still exists
      exactly as before — nothing lost, just grouped.

   2. LAYOUT JUMPING — switching sections used to also silently re-run
      loadFinanceOverviewMetrics(), wiping the metric cards back to
      "…" and refetching them on every single tab click (see the
      removed call in loadFinanceActiveSection() below) — that was a
      real, unnecessary source of top-of-page flicker. It's now called
      only on initial mount and on term/year change (see
      handleFinanceTermYearChange()). Combined with a reserved
      min-height on the accordion panel and an intentional scroll-into-
      view on every nav action (see switchFinanceCategory/
      switchFinanceSection), navigating the module no longer produces
      an unpredictable jump.

   load values below are wrapped in arrow functions (`() => fn()`)
   rather than bare function references on purpose: finance.js loads
   BEFORE payroll.js (see index.html), so a bare reference to
   loadFinancePayrollSection here would be undefined at the time this
   object is constructed. Wrapping defers the lookup until the button
   is actually clicked, by which point every script has loaded.
   --------------------------------------------------------- */
const FINANCE_SECTION_META = {
    payments:        { label: 'Fees &amp; Payments',   load: () => loadFinancePayments() },
    fees:            { label: 'Fee Structure',         load: () => loadFinanceFeeStructure() },
    summary:         { label: 'Termly Summary',        load: () => loadFinanceSummary() },
    defaulters:      { label: 'Defaulters',            load: () => loadFinanceDefaulters() },
    payroll:         { label: 'Payroll',               load: () => loadFinancePayrollSection() },
    parttimepayroll: { label: 'Part-Time Payroll',     load: () => loadFinancePartTimePayrollSection() },
    advances:        { label: 'Salary Advances',       load: () => loadFinanceSalaryAdvancesSection() },
    expenses:        { label: 'Expenses',              load: () => loadFinanceLedger('expense') },
    revenue:         { label: 'Revenue',               load: () => loadFinanceLedger('revenue') }
};

// Rebuilt on every render rather than cached — role can't change
// mid-session, but this keeps the logic self-contained and easy to
// read. A category with zero visible sections for the current role is
// dropped entirely (e.g. "Ledger" never appears for Bursar).
function getFinanceCategories() {
    const categories = [
        { id: 'fees', label: 'Student Fees', icon: 'fa-sack-dollar', sections: ['payments', 'fees', 'summary', 'defaulters'] },
        {
            id: 'payroll', label: 'Payroll', icon: 'fa-money-check-dollar',
            sections: [
                ...(payrollCanAccess() ? ['payroll'] : []),
                'parttimepayroll',
                // Salary Advances only gets its own accordion row for Bursar —
                // Admin/HR/Director already reach the same screen via the
                // Staff Detail modal inside the Payroll section (payroll.js).
                ...(currentUser.role === ROLES.BURSAR && financeCanAccessSalaryAdvances() ? ['advances'] : [])
            ]
        },
        {
            id: 'ledger', label: 'Ledger', icon: 'fa-book',
            sections: financeCanViewExpensesRevenues() ? ['expenses', 'revenue'] : []
        }
    ];
    return categories.filter(c => c.sections.length > 0);
}

// Renders the category tab row + the accordion for whichever category
// is active. Also resolves financeActiveCategory/financeActiveSection
// to a valid pair if either is stale (e.g. leftover state from before
// a role check changed which sections exist).
function renderFinanceCategoryNav() {
    const categories = getFinanceCategories();
    if (!financeActiveCategory || !categories.find(c => c.id === financeActiveCategory)) {
        financeActiveCategory = categories.length ? categories[0].id : null;
    }
    const currentCategory = categories.find(c => c.id === financeActiveCategory);
    if (currentCategory && !currentCategory.sections.includes(financeActiveSection)) {
        financeActiveSection = currentCategory.sections[0];
    }

    return `
        <div class="fin-category-tabs">
            ${categories.map(c => `
                <button type="button" onclick="switchFinanceCategory('${c.id}')" id="fin-category-${c.id}" class="fin-category-tab ${c.id === financeActiveCategory ? 'active' : ''}">
                    <i class="fa-solid ${c.icon}"></i><span>${c.label}</span>
                </button>
            `).join('')}
        </div>
        <div class="fin-accordion">
            ${currentCategory ? currentCategory.sections.map(sectionId => `
                <div class="fin-accordion-item">
                    <button type="button" class="fin-accordion-header ${sectionId === financeActiveSection ? 'open' : ''}" onclick="switchFinanceSection('${sectionId}')">
                        <span>${FINANCE_SECTION_META[sectionId].label}</span>
                        <i class="fa-solid fa-chevron-down fin-accordion-chevron"></i>
                    </button>
                    <div class="fin-accordion-panel ${sectionId === financeActiveSection ? 'open' : ''}">
                        ${sectionId === financeActiveSection ? '<div id="fin-section-body"></div>' : ''}
                    </div>
                </div>
            `).join('') : '<p class="text-slate-400 text-xs font-medium p-4">No sections available for your role.</p>'}
        </div>
    `;
}

function rerenderFinanceNav() {
    const wrapper = document.getElementById('fin-nav-wrapper');
    if (wrapper) wrapper.innerHTML = renderFinanceCategoryNav();
}

// Intentional, controlled scroll on every nav action — rather than
// leaving the browser's natural (unpredictable) scroll position after
// content height changes, which is what produced the disorienting
// "jump" when a shorter section replaced a taller one.
function scrollFinanceNavIntoView() {
    const wrapper = document.getElementById('fin-nav-wrapper');
    if (wrapper && wrapper.scrollIntoView) wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function switchFinanceCategory(categoryId) {
    if (categoryId === financeActiveCategory) return;
    financeActiveCategory = categoryId;
    const categories = getFinanceCategories();
    const cat = categories.find(c => c.id === categoryId);
    financeActiveSection = (cat && cat.sections[0]) || financeActiveSection;
    rerenderFinanceNav();
    loadFinanceActiveSection();
    scrollFinanceNavIntoView();
}

function switchFinanceSection(sectionId) {
    if (sectionId === financeActiveSection) return;
    financeActiveSection = sectionId;
    const owner = getFinanceCategories().find(c => c.sections.includes(sectionId));
    if (owner) financeActiveCategory = owner.id;
    rerenderFinanceNav();
    loadFinanceActiveSection();
    scrollFinanceNavIntoView();
}

function renderFinanceModule() {
    const t = termSettings;
    return `
        <div class="space-y-6">

            <!-- Financial Overview Dashboard — note: deliberately NOT using the
                 dashboard's .metrics-grid/.metric-card classes here, even though
                 they look identical. script.js's updateDashboardStats() does a
                 document.querySelector('.metrics-grid') and hides whatever it
                 finds whenever currentTabName !== 'dashboard', which runs after
                 almost every data change app-wide — reusing that class would
                 make these cards randomly disappear while viewing Finance.

                 Bursar gets a trimmed 2-card version (Fees Collected +
                 Outstanding/Defaulters) instead of the full 4-card grid —
                 Total Expenses and Net Balance are both derived from the
                 Expenses/Revenues tables via GET /finance-flow, which is
                 blocked for Bursar server-side (EXPENSE_REVENUE_ROLES in
                 finance.routes.js); showing those cards would either 403 or
                 leak a number Bursar isn't supposed to see, so
                 loadFinanceOverviewMetrics() never even calls getFinanceFlow
                 for Bursar — see the role check there. -->
                 make these cards randomly disappear while viewing Finance.

                 Bursar gets a trimmed 2-card version (Fees Collected +
                 Outstanding/Defaulters) instead of the full 4-card grid —
                 Total Expenses and Net Balance are both derived from the
                 Expenses/Revenues tables via GET /finance-flow, which is
                 blocked for Bursar server-side (EXPENSE_REVENUE_ROLES in
                 finance.routes.js); showing those cards would either 403 or
                 leak a number Bursar isn't supposed to see, so
                 loadFinanceOverviewMetrics() never even calls getFinanceFlow
                 for Bursar — see the role check there. -->
            <div class="fin-metrics-grid" id="fin-overview-metrics">
                ${financeCanViewExpensesRevenues() ? `
                ${financeCanViewExpensesRevenues() ? `
                <div class="fin-metric-card">
                    <div class="fin-metric-label">Revenue Collected</div>
                    <div class="fin-metric-row">
                        <span class="fin-metric-value" id="fin-metric-revenue">&hellip;</span>
                        <span class="fin-metric-icon"><i class="fa-solid fa-sack-dollar"></i></span>
                    </div>
                    <p class="text-[11px] font-bold text-emerald-600 mt-2"><i class="fa-solid fa-arrow-trend-up mr-1"></i>Year to date</p>
                </div>
                <div class="fin-metric-card">
                    <div class="fin-metric-label">Total Expenses</div>
                    <div class="fin-metric-row">
                        <span class="fin-metric-value" id="fin-metric-expenses">&hellip;</span>
                        <span class="fin-metric-icon fin-metric-icon-navy"><i class="fa-solid fa-receipt"></i></span>
                    </div>
                    <p class="text-[11px] font-bold text-slate-400 mt-2">Year to date</p>
                </div>
                <div class="fin-metric-card">
                    <div class="fin-metric-label">Outstanding / Defaulters</div>
                    <div class="fin-metric-row">
                        <span class="fin-metric-value text-rose-600" id="fin-metric-outstanding">&hellip;</span>
                        <span class="fin-metric-icon fin-metric-icon-danger"><i class="fa-solid fa-triangle-exclamation"></i></span>
                    </div>
                    <p class="text-[11px] font-bold text-slate-400 mt-2"><span id="fin-metric-defaulters-count">&hellip;</span> &middot; selected term</p>
                </div>
                <div class="fin-metric-card">
                    <div class="fin-metric-label">Net Balance</div>
                    <div class="fin-metric-row">
                        <span class="fin-metric-value" id="fin-metric-net">&hellip;</span>
                        <span class="fin-metric-icon fin-metric-icon-success"><i class="fa-solid fa-scale-balanced"></i></span>
                    </div>
                    <p class="text-[11px] font-bold text-slate-400 mt-2">Revenue minus expenses, year to date</p>
                </div>
                ` : `
                <div class="fin-metric-card">
                    <div class="fin-metric-label">Fees Collected</div>
                    <div class="fin-metric-row">
                        <span class="fin-metric-value" id="fin-metric-revenue">&hellip;</span>
                        <span class="fin-metric-icon"><i class="fa-solid fa-sack-dollar"></i></span>
                    </div>
                    <p class="text-[11px] font-bold text-emerald-600 mt-2"><i class="fa-solid fa-arrow-trend-up mr-1"></i>Selected term</p>
                </div>
                <div class="fin-metric-card">
                    <div class="fin-metric-label">Outstanding / Defaulters</div>
                    <div class="fin-metric-row">
                        <span class="fin-metric-value text-rose-600" id="fin-metric-outstanding">&hellip;</span>
                        <span class="fin-metric-icon fin-metric-icon-danger"><i class="fa-solid fa-triangle-exclamation"></i></span>
                    </div>
                    <p class="text-[11px] font-bold text-slate-400 mt-2"><span id="fin-metric-defaulters-count">&hellip;</span> &middot; selected term</p>
                </div>
                `}
                ` : `
                <div class="fin-metric-card">
                    <div class="fin-metric-label">Fees Collected</div>
                    <div class="fin-metric-row">
                        <span class="fin-metric-value" id="fin-metric-revenue">&hellip;</span>
                        <span class="fin-metric-icon"><i class="fa-solid fa-sack-dollar"></i></span>
                    </div>
                    <p class="text-[11px] font-bold text-emerald-600 mt-2"><i class="fa-solid fa-arrow-trend-up mr-1"></i>Selected term</p>
                </div>
                <div class="fin-metric-card">
                    <div class="fin-metric-label">Outstanding / Defaulters</div>
                    <div class="fin-metric-row">
                        <span class="fin-metric-value text-rose-600" id="fin-metric-outstanding">&hellip;</span>
                        <span class="fin-metric-icon fin-metric-icon-danger"><i class="fa-solid fa-triangle-exclamation"></i></span>
                    </div>
                    <p class="text-[11px] font-bold text-slate-400 mt-2"><span id="fin-metric-defaulters-count">&hellip;</span> &middot; selected term</p>
                </div>
                `}
            </div>

            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                <div class="flex flex-wrap items-end gap-4">
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Term</label>
                        <select id="fin-term-select" onchange="handleFinanceTermYearChange()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                            <option value="Term 1" ${t.term === 'Term 1' ? 'selected' : ''}>Term 1</option>
                            <option value="Term 2" ${t.term === 'Term 2' ? 'selected' : ''}>Term 2</option>
                            <option value="Term 3" ${t.term === 'Term 3' ? 'selected' : ''}>Term 3</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Year</label>
                        <input type="number" id="fin-year-input" value="${t.year}" onchange="handleFinanceTermYearChange()" class="w-24 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                    </div>
                </div>
                <label class="fin-lock-toggle" title="Lock Finance and return to the main dashboard">
                    <span class="text-xs font-extrabold uppercase tracking-wider text-slate-500">Lock Finance</span>
                    <span class="fin-lock-switch" onclick="lockFinancePanel()">
                        <i class="fa-solid fa-lock-open"></i>
                    </span>
                </label>
            </div>

            <!-- HYBRID NAV: category tabs + accordion, built by
                 renderFinanceCategoryNav() (see above renderFinanceModule).
                 This wrapper's own content never gets replaced by
                 renderFinanceModule() again after the initial mount —
                 only rerenderFinanceNav() touches it from here on, which
                 keeps the rest of the panel (metrics, term/year, lock
                 toggle) completely undisturbed while navigating. -->
            <div id="fin-nav-wrapper"></div>
            <style>
                /* Still used by payroll.js's own internal sub-tabs (Staff
                   Profiles / Payroll Runs, inside the Payroll accordion
                   panel) — NOT used by the top-level nav above anymore
                   (that's .fin-category-tab / .fin-accordion-header now). */
                .finance-section-tab { padding: 10px 16px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; border-bottom: 2px solid transparent; transition: all .15s; white-space: nowrap; }
                .finance-section-tab:hover { color: #0f766e; }
                .finance-section-tab.active { color: #0f766e; border-bottom-color: #0f766e; }

                .fin-category-tabs { display: flex; gap: 8px; overflow-x: auto; flex-wrap: wrap; margin-bottom: 14px; }
                .fin-category-tab {
                    display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px;
                    font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em;
                    color: #64748b; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;
                    white-space: nowrap; transition: all .15s;
                }
                .fin-category-tab:hover { color: #0f766e; border-color: #99f6e4; }
                .fin-category-tab.active { color: #fff; background: #0f766e; border-color: #0f766e; }
                .fin-category-tab i { font-size: 12px; }

                .fin-accordion { border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; background: #fff; }
                .fin-accordion-item { border-bottom: 1px solid #e2e8f0; }
                .fin-accordion-item:last-child { border-bottom: none; }
                .fin-accordion-header {
                    width: 100%; display: flex; align-items: center; justify-content: space-between;
                    padding: 14px 18px; font-size: 12px; font-weight: 800; color: #334155;
                    background: #fff; text-align: left; transition: background .12s;
                }
                .fin-accordion-header:hover { background: #f8fafc; }
                .fin-accordion-header.open { color: #0f766e; background: #f0fdfa; }
                .fin-accordion-chevron { transition: transform .15s ease; color: #94a3b8; }
                .fin-accordion-header.open .fin-accordion-chevron { transform: rotate(180deg); color: #0f766e; }
                .fin-accordion-panel { display: none; padding: 16px; border-top: 1px solid #e2e8f0; }
                .fin-accordion-panel.open {
                    display: block;
                    /* Reserves space so the brief "loading…" tick right after
                       a section is opened doesn't collapse this panel to
                       near-zero height and then snap back once data
                       arrives — a direct fix for the layout-jump report. */
                    min-height: 220px;
                }

                /* Financial Overview Dashboard — self-contained styles (see the
                   comment above #fin-overview-metrics for why these aren't the
                   shared .metrics-grid/.metric-card dashboard classes). Reuses
                   the same design tokens (--slate-100/--navy-900/--font-display)
                   already defined in styles.css so it still matches the rest of
                   the app pixel-for-pixel. */
                .fin-metrics-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
                @media (max-width: 900px) { .fin-metrics-grid { grid-template-columns: repeat(2, 1fr); } }
                @media (max-width: 560px) { .fin-metrics-grid { grid-template-columns: 1fr; } }
                .fin-metric-card { background: #fff; border: 1px solid var(--slate-100); border-radius: 16px; padding: 18px 20px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
                .fin-metric-label { font-size: 10.5px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: #1d4ed8; }
                .fin-metric-row { display: flex; align-items: baseline; justify-content: space-between; margin-top: 10px; }
                .fin-metric-value { font-family: var(--font-display); font-size: 28px; color: var(--navy-900); }
                .fin-metric-icon {
                    width: 32px; height: 32px; border-radius: 10px; background: #eff6ff;
                    border: 1px solid #dbeafe; color: #2563eb;
                    display: flex; align-items: center; justify-content: center; font-size: 12px;
                }
                .fin-metric-icon-navy { background: #f4f4f5; border-color: #e4e4e7; color: #3f3f46; }
                .fin-metric-icon-danger { background: #fef2f2; border-color: #fee2e2; color: #dc2626; }
                .fin-metric-icon-success { background: #f0fdf4; border-color: #dcfce7; color: #16a34a; }
                @media (max-width: 560px) { .fin-metric-value { font-size: 22px; } .fin-metric-card { padding: 14px 16px; } }

                .fin-lock-toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
                .fin-lock-switch {
                    width: 42px; height: 24px; border-radius: 999px; background: #e4e4e7; border: 1px solid #d4d4d8;
                    display: flex; align-items: center; justify-content: flex-start; padding: 0 5px;
                    color: #71717a; font-size: 10px; transition: background .15s ease;
                }
                .fin-lock-switch:hover { background: #fee2e2; color: #dc2626; border-color: #fecaca; }
            </style>
        </div>
    `;
}

function initFinanceModule() {
    loadFinanceOverviewMetrics();
    rerenderFinanceNav();
    loadFinanceActiveSection();
}

// Term/Year change affects BOTH the overview metrics and whichever
// section is open, so this is the only place that still calls both —
// switchFinanceCategory()/switchFinanceSection() deliberately do NOT,
// to stop the metric cards flickering back to "…" on every nav click.
function handleFinanceTermYearChange() {
    loadFinanceOverviewMetrics();
    loadFinanceActiveSection();
}

function loadFinanceActiveSection() {
    const meta = FINANCE_SECTION_META[financeActiveSection];
    if (meta) return meta.load();
    return loadFinancePayments();
}

// Financial Overview Dashboard — headline metric cards shown above every
// Finance section. For Admin/HR/Director: Revenue/Expenses/Net come from
// FinanceAPI.getFinanceFlow (calendar-year totals, same source as the
// Termly Summary flow chart). For Bursar: getFinanceFlow is never called
// at all — it's blocked server-side (EXPENSE_REVENUE_ROLES in
// finance.routes.js) — "Fees Collected" instead comes from
// FinanceAPI.getSummary for the selected term/year, the same fees-only
// totals the Termly Summary tab uses. Outstanding/Defaulters comes from
// FinanceAPI.getPayments for the currently selected term either way
// (same data loadFinanceDefaulters() uses), since student fee balances
// are term-scoped rather than year-scoped.
// Financial Overview Dashboard — headline metric cards shown above every
// Finance section. For Admin/HR/Director: Revenue/Expenses/Net come from
// FinanceAPI.getFinanceFlow (calendar-year totals, same source as the
// Termly Summary flow chart). For Bursar: getFinanceFlow is never called
// at all — it's blocked server-side (EXPENSE_REVENUE_ROLES in
// finance.routes.js) — "Fees Collected" instead comes from
// FinanceAPI.getSummary for the selected term/year, the same fees-only
// totals the Termly Summary tab uses. Outstanding/Defaulters comes from
// FinanceAPI.getPayments for the currently selected term either way
// (same data loadFinanceDefaulters() uses), since student fee balances
// are term-scoped rather than year-scoped.
async function loadFinanceOverviewMetrics() {
    const grid = document.getElementById('fin-overview-metrics');
    if (!grid) return;
    const { term, year } = getFinanceViewedTermYear();
    const canViewExpensesRevenues = financeCanViewExpensesRevenues();

    try {
        if (canViewExpensesRevenues) {
            const [flow, students] = await Promise.all([
                FinanceAPI.getFinanceFlow(year),
                FinanceAPI.getPayments({ term, year })
            ]);
            const defaulters = students.filter(s => s.balance > 0);
            const outstanding = defaulters.reduce((sum, s) => sum + s.balance, 0);
        if (canViewExpensesRevenues) {
            const [flow, students] = await Promise.all([
                FinanceAPI.getFinanceFlow(year),
                FinanceAPI.getPayments({ term, year })
            ]);
            const defaulters = students.filter(s => s.balance > 0);
            const outstanding = defaulters.reduce((sum, s) => sum + s.balance, 0);

            document.getElementById('fin-metric-revenue').textContent = formatUGX(flow.totals.revenue);
            document.getElementById('fin-metric-expenses').textContent = formatUGX(flow.totals.expenses);
            document.getElementById('fin-metric-net').textContent = formatUGX(flow.totals.net);
            document.getElementById('fin-metric-outstanding').textContent = formatUGX(outstanding);
            document.getElementById('fin-metric-defaulters-count').textContent =
                `${defaulters.length} student${defaulters.length === 1 ? '' : 's'}`;
        } else {
            const [summary, students] = await Promise.all([
                FinanceAPI.getSummary(term, year),
                FinanceAPI.getPayments({ term, year })
            ]);
            const defaulters = students.filter(s => s.balance > 0);
            const outstanding = defaulters.reduce((sum, s) => sum + s.balance, 0);

            document.getElementById('fin-metric-revenue').textContent = formatUGX(summary.totals.collected);
            document.getElementById('fin-metric-outstanding').textContent = formatUGX(outstanding);
            document.getElementById('fin-metric-defaulters-count').textContent =
                `${defaulters.length} student${defaulters.length === 1 ? '' : 's'}`;
        }
            document.getElementById('fin-metric-revenue').textContent = formatUGX(flow.totals.revenue);
            document.getElementById('fin-metric-expenses').textContent = formatUGX(flow.totals.expenses);
            document.getElementById('fin-metric-net').textContent = formatUGX(flow.totals.net);
            document.getElementById('fin-metric-outstanding').textContent = formatUGX(outstanding);
            document.getElementById('fin-metric-defaulters-count').textContent =
                `${defaulters.length} student${defaulters.length === 1 ? '' : 's'}`;
        } else {
            const [summary, students] = await Promise.all([
                FinanceAPI.getSummary(term, year),
                FinanceAPI.getPayments({ term, year })
            ]);
            const defaulters = students.filter(s => s.balance > 0);
            const outstanding = defaulters.reduce((sum, s) => sum + s.balance, 0);

            document.getElementById('fin-metric-revenue').textContent = formatUGX(summary.totals.collected);
            document.getElementById('fin-metric-outstanding').textContent = formatUGX(outstanding);
            document.getElementById('fin-metric-defaulters-count').textContent =
                `${defaulters.length} student${defaulters.length === 1 ? '' : 's'}`;
        }
    } catch (err) {
        // Non-fatal — the active section below still loads/shows its own
        // error state; the overview cards just stay blank on failure.
        ['fin-metric-revenue', 'fin-metric-expenses', 'fin-metric-net', 'fin-metric-outstanding'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = '—';
        });
        const countEl = document.getElementById('fin-metric-defaulters-count');
        if (countEl) countEl.textContent = '—';
    }
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
    financeSummaryDataCache = data;
    financeSummaryFlowCache = flowData;

    body.innerHTML = `
        <div class="flex justify-end gap-2 mb-3">
            <button id="fin-summary-export-btn" onclick="exportFinanceSummaryPDF()" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-file-pdf mr-1.5"></i>Export PDF</button>
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
   EXPORT TERMLY SUMMARY TO PDF (direct download, separate from
   Print). Same html2canvas + jsPDF technique as
   class-summaries.js -> exportClassSummaryPDF(): render a
   letterheaded report off-screen, rasterize it, slice it into
   successive Portrait-A4-height pages if it's taller than one page.
   Chart images are grabbed via canvas.toDataURL() straight off the
   already-rendered on-screen Chart.js canvases (financeSummaryDataCache/
   financeSummaryFlowCache + those canvases are only available while the
   Termly Summary section is on screen, which is exactly when this
   button is visible) rather than re-created off-screen.
   --------------------------------------------------------- */
async function exportFinanceSummaryPDF() {
    if (!financeSummaryDataCache) return;
    if (typeof html2canvas === 'undefined' || !window.jspdf) {
        alert('PDF export couldn\'t load its required library (no internet connection?). Please use the Print button and choose "Save as PDF" instead.');
        return;
    }
    const data = financeSummaryDataCache;
    const flowData = financeSummaryFlowCache;
    const { term, year } = getFinanceViewedTermYear();
    const collectionRate = data.totals.billed > 0 ? (data.totals.collected / data.totals.billed) * 100 : 0;

    const grabChart = (id) => {
        const el = document.getElementById(id);
        try { return el ? el.toDataURL('image/png') : null; } catch (e) { return null; }
    };
    const charts = {
        collected: grabChart('fin-collected-chart'),
        method: grabChart('fin-method-chart'),
        flow: grabChart('fin-flow-chart'),
        expenseCat: grabChart('fin-expense-cat-chart'),
        revenueCat: grabChart('fin-revenue-cat-chart')
    };

    const html = buildFinanceSummaryReportHTML(data, flowData, collectionRate, term, year, charts);

    const holder = document.createElement('div');
    holder.style.position = 'fixed';
    holder.style.top = '0';
    holder.style.left = '-10000px';
    holder.style.width = '900px';
    holder.style.background = '#ffffff';
    holder.innerHTML = html;
    document.body.appendChild(holder);

    const exportBtn = document.getElementById('fin-summary-export-btn');
    const originalBtnHTML = exportBtn ? exportBtn.innerHTML : null;
    if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Preparing PDF&hellip;';
    }

    try {
        const target = holder.querySelector('.fin-report-page');
        const canvas = await html2canvas(target, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('p', 'mm', 'a4'); // Portrait A4
        const pageWidth = 210;
        const pageHeight = 297;
        const imgFullHeight = (canvas.height * pageWidth) / canvas.width;
        const pxPerPage = Math.floor((pageHeight / imgFullHeight) * canvas.height);

        if (imgFullHeight <= pageHeight || pxPerPage <= 0) {
            pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, pageWidth, imgFullHeight);
        } else {
            // Report is taller than one page (lots of chart panels) —
            // slice into successive full-width, page-height strips, one
            // PDF page per strip, same as the General Mark Sheet export.
            let renderedPx = 0;
            let pageIndex = 0;
            while (renderedPx < canvas.height) {
                const sliceHeightPx = Math.min(pxPerPage, canvas.height - renderedPx);
                const sliceCanvas = document.createElement('canvas');
                sliceCanvas.width = canvas.width;
                sliceCanvas.height = sliceHeightPx;
                const ctx = sliceCanvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
                ctx.drawImage(canvas, 0, renderedPx, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx);
                const sliceHeightMM = (sliceHeightPx * pageWidth) / canvas.width;
                if (pageIndex > 0) pdf.addPage();
                pdf.addImage(sliceCanvas.toDataURL('image/png'), 'PNG', 0, 0, pageWidth, sliceHeightMM);
                renderedPx += sliceHeightPx;
                pageIndex++;
            }
        }

        const fileName = `TermlySummary_${term}_${year}`.replace(/\s+/g, '').replace(/[^\w-]/g, '');
        pdf.save(`${fileName}.pdf`);
    } catch (err) {
        console.error('Termly Summary PDF export failed:', err);
        alert('Could not generate the PDF. Please try the Print button instead, then choose "Save as PDF".');
    } finally {
        document.body.removeChild(holder);
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.innerHTML = originalBtnHTML;
        }
    }
}

// Letterheaded report body for exportFinanceSummaryPDF() — plain CSS
// (not Tailwind utility classes) via an embedded <style> block, same
// choice class-summaries.js's buildClassSummaryPrintHTML() makes, so
// nothing here depends on the Tailwind CDN's runtime class scanner
// having seen these class names before this off-screen render.
function buildFinanceSummaryReportHTML(data, flowData, collectionRate, term, year, charts) {
    const chartPanel = (title, dataUrl) => dataUrl ? `
        <div class="fin-report-chart-box">
            <p class="fin-report-chart-title">${escapeHTML(title)}</p>
            <img src="${dataUrl}" class="fin-report-chart-img">
        </div>` : '';
    const now = new Date();

    return `
        <style>
            .fin-report-page { width: 900px; padding: 40px; font-family: Arial, Helvetica, sans-serif; color: #1e293b; background: #fff; }
            .fin-report-header { text-align: center; border-bottom: 3px solid #0f766e; padding-bottom: 14px; margin-bottom: 20px; }
            .fin-report-header img { height: 64px; margin-bottom: 8px; }
            .fin-report-header h1 { margin: 0; font-size: 18px; letter-spacing: 0.03em; }
            .fin-report-header p { margin: 2px 0; font-size: 11px; color: #475569; }
            .fin-report-title { text-align: center; margin: 0 0 4px; font-size: 15px; letter-spacing: 0.06em; text-transform: uppercase; }
            .fin-report-subtitle { text-align: center; margin: 0 0 20px; font-size: 12px; color: #64748b; }
            .fin-report-stats { display: flex; gap: 12px; margin-bottom: 22px; }
            .fin-report-stat { flex: 1; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; text-align: center; }
            .fin-report-stat .val { font-size: 18px; font-weight: 800; color: #0f172a; }
            .fin-report-stat .lbl { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-top: 3px; }
            .fin-report-charts-row { display: flex; gap: 14px; margin-bottom: 18px; }
            .fin-report-chart-box { flex: 1; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; }
            .fin-report-chart-title { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin: 0 0 6px; }
            .fin-report-chart-img { width: 100%; display: block; }
            .fin-report-table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 4px; }
            .fin-report-table th { background: #f8fafc; color: #64748b; text-transform: uppercase; font-size: 9px; font-weight: 800; letter-spacing: 0.05em; text-align: left; padding: 8px; border-bottom: 1px solid #e2e8f0; }
            .fin-report-table td { padding: 8px; border-bottom: 1px solid #f1f5f9; }
            .fin-report-table tfoot td { font-weight: 800; background: #f8fafc; border-top: 2px solid #e2e8f0; }
            .fin-report-footer { margin-top: 24px; font-size: 9px; color: #94a3b8; text-align: center; }
        </style>
        <div class="fin-report-page">
            <div class="fin-report-header">
                <img src="school_badge.jpg" alt="School Badge">
                <h1>LUWEERO COMMUNITY SECONDARY SCHOOL</h1>
                <p>P.O BOX 29540, KAMPALA-UGANDA</p>
                <p>TEL: 0772620552 / 0782572120 / 0740773771</p>
            </div>
            <p class="fin-report-title">Termly Financial Summary</p>
            <p class="fin-report-subtitle">${escapeHTML(term)}, ${escapeHTML(String(year))}</p>

            <div class="fin-report-stats">
                <div class="fin-report-stat"><div class="val">${formatUGX(data.totals.billed)}</div><div class="lbl">Expected (Billed)</div></div>
                <div class="fin-report-stat"><div class="val">${formatUGX(data.totals.collected)}</div><div class="lbl">Collected</div></div>
                <div class="fin-report-stat"><div class="val">${formatUGX(data.totals.outstanding)}</div><div class="lbl">Outstanding</div></div>
                <div class="fin-report-stat"><div class="val">${collectionRate.toFixed(1)}%</div><div class="lbl">Collection Rate</div></div>
            </div>

            ${(charts.collected || charts.method) ? `
            <div class="fin-report-charts-row">
                ${chartPanel('Fees Collected vs Outstanding', charts.collected)}
                ${chartPanel('Collections by Payment Method', charts.method)}
            </div>` : ''}

            ${charts.flow ? `
            <div class="fin-report-charts-row">
                <div class="fin-report-chart-box" style="flex:1;">
                    <p class="fin-report-chart-title">Finance Flow &mdash; ${year}${flowData ? ` (Net: ${formatUGX(flowData.totals.net)})` : ''}</p>
                    <img src="${charts.flow}" class="fin-report-chart-img">
                </div>
            </div>` : ''}

            ${(charts.expenseCat || charts.revenueCat) ? `
            <div class="fin-report-charts-row">
                ${chartPanel(`Expenses by Category (${year})`, charts.expenseCat)}
                ${chartPanel(`Other Revenue by Category (${year})`, charts.revenueCat)}
            </div>` : ''}

            <table class="fin-report-table">
                <thead><tr>
                    <th>Class</th><th>Students</th><th>Avg Fee/Student</th><th>Billed</th><th>Collected</th><th>Outstanding</th>
                </tr></thead>
                <tbody>
                    ${data.byClass.map(c => `
                        <tr>
                            <td><strong>${escapeHTML(c.class)}</strong></td>
                            <td>${c.studentCount}</td>
                            <td>${formatUGX(c.studentCount ? c.billed / c.studentCount : 0)}</td>
                            <td>${formatUGX(c.billed)}</td>
                            <td>${formatUGX(c.collected)}</td>
                            <td>${formatUGX(c.outstanding)}</td>
                        </tr>
                    `).join('')}
                </tbody>
                <tfoot><tr>
                    <td colspan="3">TOTAL</td>
                    <td>${formatUGX(data.totals.billed)}</td>
                    <td>${formatUGX(data.totals.collected)}</td>
                    <td>${formatUGX(data.totals.outstanding)}</td>
                </tr></tfoot>
            </table>

            <p class="fin-report-footer">Generated on ${escapeHTML(now.toLocaleString())} by ${escapeHTML((currentUser && currentUser.username) || '')} &mdash; system-generated, not valid without an official school stamp.</p>
        </div>
    `;
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

/* ---------------------------------------------------------
   SALARY ADVANCES (Bursar-facing) — see the "advances" accordion row
   above, only ever rendered for Bursar (financeCanAccessSalaryAdvances()
   is also true for Admin/HR/Director, but they already reach the same
   capability via the Staff Detail modal inside the Payroll tab —
   payroll.js's openStaffDetailModal()/renderStaffDetailModal() — so
   there's no separate top-level tab for them here).

   Deliberately built on ONLY two endpoints, both allowed for Bursar
   server-side (SALARY_ADVANCE_ROLES in payroll.routes.js):
     - GET  /finance/payroll/advance-lookup  (id/name/roleType only)
     - GET/POST /finance/payroll/staff/:staffId/advances
   This screen never calls PayrollAPI.listStaff()/getStaff() — those
   hit PAYROLL_EDIT_ROLES-only endpoints that include base salary, so
   Bursar's browser never even requests that data, let alone displays it.
   --------------------------------------------------------- */
let financeAdvancesSelectedStaff = null; // { id, name, roleType } | null

async function loadFinanceSalaryAdvancesSection() {
    const body = document.getElementById('fin-section-body');
    if (!body) return;
    body.innerHTML = `
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div class="lg:col-span-1 bg-white border border-slate-200 rounded-2xl shadow-xs p-4">
                <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">Find a Staff Member</h4>
                <input type="text" id="fin-advance-search" oninput="searchFinanceAdvanceStaff(this.value)" placeholder="Search by name&hellip;" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700 mb-3">
                <div id="fin-advance-staff-list" class="space-y-1.5 max-h-96 overflow-y-auto"></div>
            </div>
            <div class="lg:col-span-2" id="fin-advance-detail">
                <div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium">
                    Search for a staff member on the left to view or issue a salary advance.
                </div>
            </div>
        </div>
    `;
    searchFinanceAdvanceStaff('');
}

let financeAdvanceSearchDebounce = null;
function searchFinanceAdvanceStaff(search) {
    clearTimeout(financeAdvanceSearchDebounce);
    financeAdvanceSearchDebounce = setTimeout(async () => {
        const listEl = document.getElementById('fin-advance-staff-list');
        if (!listEl) return;
        listEl.innerHTML = `<p class="text-center text-slate-400 text-xs font-medium py-4"><i class="fa-solid fa-circle-notch fa-spin mr-1.5"></i>Searching&hellip;</p>`;
        let staff;
        try {
            staff = await PayrollAPI.lookupAdvanceStaff(search.trim());
        } catch (err) {
            listEl.innerHTML = `<p class="text-center text-rose-500 text-xs font-semibold py-4">${escapeHTML(err.message || "Couldn't load staff.")}</p>`;
            return;
        }
        if (!staff.length) {
            listEl.innerHTML = `<p class="text-center text-slate-400 text-xs font-medium py-4">No active staff match that search.</p>`;
            return;
        }
        listEl.innerHTML = staff.map(s => `
            <button onclick="selectFinanceAdvanceStaff(${s.id}, '${escapeHTML(s.name)}', '${escapeHTML(s.roleType)}')"
                class="w-full text-left p-2.5 rounded-xl border ${financeAdvancesSelectedStaff && financeAdvancesSelectedStaff.id === s.id ? 'border-teal-400 bg-teal-50' : 'border-slate-200 hover:bg-slate-50'} transition-colors">
                <p class="text-xs font-bold text-slate-800">${escapeHTML(s.name)}</p>
                <p class="text-[10px] font-semibold text-slate-400 uppercase">${escapeHTML(s.roleType)}</p>
            </button>
        `).join('');
    }, 250);
}

async function selectFinanceAdvanceStaff(id, name, roleType) {
    financeAdvancesSelectedStaff = { id, name, roleType };
    // Re-render the left list so the selected row highlights.
    const searchInput = document.getElementById('fin-advance-search');
    searchFinanceAdvanceStaff(searchInput ? searchInput.value : '');
    await loadFinanceAdvanceDetail();
}

async function loadFinanceAdvanceDetail() {
    const detailEl = document.getElementById('fin-advance-detail');
    if (!detailEl || !financeAdvancesSelectedStaff) return;
    const staff = financeAdvancesSelectedStaff;
    detailEl.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading&hellip;</div>`;

    let advances;
    try {
        advances = await PayrollAPI.getAdvances(staff.id);
    } catch (err) {
        detailEl.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-rose-500 text-xs font-semibold">${escapeHTML(err.message || "Couldn't load salary advances.")}</div>`;
        return;
    }

    const activeAdvance = advances.find(a => a.status === 'active');
    detailEl.innerHTML = `
        <div class="bg-white border border-slate-200 rounded-2xl shadow-xs p-5">
            <h4 class="text-sm font-black text-slate-900 mb-0.5">${escapeHTML(staff.name)}</h4>
            <p class="text-[11px] font-semibold text-slate-400 uppercase mb-4">${escapeHTML(staff.roleType)}</p>

            <h5 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">Salary Advance History</h5>
            ${advances.length ? `
                <div class="overflow-x-auto mb-4">
                    <table class="w-full text-left text-xs text-slate-700">
                        <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider"><tr>
                            <th class="p-2">Requested</th><th class="p-2">Repay/mo</th><th class="p-2">Balance</th><th class="p-2">Status</th><th class="p-2">Date</th>
                        </tr></thead>
                        <tbody class="divide-y divide-slate-100">
                            ${advances.map(a => `
                                <tr>
                                    <td class="p-2 font-bold">${formatUGX(a.requestedAmount)}</td>
                                    <td class="p-2">${formatUGX(a.repaymentAmountPerMonth)}</td>
                                    <td class="p-2">${formatUGX(a.balanceRemaining)}</td>
                                    <td class="p-2"><span class="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-lg ${a.status === 'active' ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}">${escapeHTML(a.status)}</span></td>
                                    <td class="p-2 text-slate-400">${a.requestDate ? new Date(a.requestDate).toLocaleDateString() : '—'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            ` : `<p class="text-xs text-slate-400 mb-4">No salary advances on record for this staff member yet.</p>`}

            ${activeAdvance ? `
                <p class="text-[11px] text-amber-600 font-semibold mb-2"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Already has an active advance — issuing another will deduct both every payroll run.</p>
            ` : ''}
            <h5 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">Issue a New Advance</h5>
            <div class="flex flex-wrap gap-2 items-start">
                <input type="number" min="1" id="fin-advance-amount" placeholder="Requested amount" class="w-36 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                <input type="number" min="1" id="fin-advance-repayment" placeholder="Repay / month" class="w-36 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                <button onclick="issueFinanceSalaryAdvance(${staff.id})" class="bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-extrabold uppercase py-2.5 px-4 rounded-xl transition">Issue Advance</button>
            </div>
            <p id="fin-advance-error" class="text-rose-600 text-[11px] font-bold mt-1.5 hidden"></p>
        </div>
    `;
}

async function issueFinanceSalaryAdvance(staffId) {
    const requestedAmount = Number(document.getElementById('fin-advance-amount').value);
    const repaymentAmountPerMonth = Number(document.getElementById('fin-advance-repayment').value);
    const errEl = document.getElementById('fin-advance-error');
    if (errEl) errEl.classList.add('hidden');

    if (!requestedAmount || requestedAmount <= 0 || !repaymentAmountPerMonth || repaymentAmountPerMonth <= 0) {
        if (errEl) { errEl.textContent = 'Enter a valid requested amount and monthly repayment.'; errEl.classList.remove('hidden'); }
        return;
    }
    if (!confirm(`Issue an advance of ${formatUGX(requestedAmount)}, repaid at ${formatUGX(repaymentAmountPerMonth)}/month? This takes effect immediately, starting with the next payroll run.`)) return;

    try {
        await PayrollAPI.issueAdvance(staffId, { requestedAmount, repaymentAmountPerMonth });
    } catch (err) {
        if (errEl) { errEl.textContent = err.message || "Couldn't issue that advance."; errEl.classList.remove('hidden'); }
        return;
    }
    loadFinanceAdvanceDetail();
}

/* ---------------------------------------------------------
   PART-TIME WEEKLY PAYROLL — separate track from the general Payroll
   tab (payroll.js), talking only to PartTimePayrollAPI (api.js), which
   itself talks to routes/part-time-payroll.routes.js. Visible to all
   four Finance-gated roles (server-side VIEW_ROLES); record-entry,
   mark-paid, and delete controls only render/work for Admin/Bursar
   (server-side EDIT_ROLES) — HR/Director see the same table read-only,
   same principle finance.js already uses for Teacher's old view-only
   tier: financeCanEdit() gates markup, the backend is the real guard.
   --------------------------------------------------------- */
let financePartTimePayrollWeek = null; // 'YYYY-MM-DD' (a Monday) | null until first load

function getFinanceCurrentWeekStartISO() {
    const d = new Date();
    const day = d.getDay(); // 0=Sun..6=Sat
    const diffToMonday = (day === 0 ? -6 : 1) - day;
    d.setDate(d.getDate() + diffToMonday);
    return d.toISOString().slice(0, 10);
}

function loadFinancePartTimePayrollSection() {
    if (!financePartTimePayrollWeek) financePartTimePayrollWeek = getFinanceCurrentWeekStartISO();
    const body = document.getElementById('fin-section-body');
    if (!body) return;
    const canEdit = partTimePayrollCanEdit();

    body.innerHTML = `
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white border border-slate-200 rounded-2xl shadow-xs p-4 mb-4">
            <div>
                <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Week Starting (Monday)</label>
                <input type="date" id="fin-ptp-week" value="${financePartTimePayrollWeek}" onchange="changeFinancePartTimePayrollWeek(this.value)" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
            </div>
            ${canEdit ? `<button onclick="toggleFinancePartTimePayrollForm()" class="w-full md:w-auto bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-plus mr-2"></i>Record Payment</button>` : ''}
        </div>

        ${canEdit ? `
        <div id="fin-ptp-form-container" class="hidden bg-white border border-slate-200 rounded-2xl shadow-xs p-5 mb-4">
            <h4 class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-3">Record a Part-Time Payment for the Selected Week</h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div class="sm:col-span-2">
                    <input type="text" id="fin-ptp-staff-search" oninput="searchFinancePartTimeStaff(this.value)" placeholder="Search for a part-time staff member&hellip;" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
                    <div id="fin-ptp-staff-results" class="mt-1.5 space-y-1"></div>
                </div>
                <input type="number" min="0" id="fin-ptp-amount" placeholder="Amount (UGX)" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold">
                <input type="text" id="fin-ptp-note" placeholder="Note (optional)" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold">
            </div>
            <p id="fin-ptp-selected-staff" class="text-[11px] font-bold text-teal-700 mt-2 hidden"></p>
            <p id="fin-ptp-form-error" class="text-rose-600 text-[11px] font-bold mt-1.5 hidden"></p>
            <div class="flex justify-end gap-2 mt-3">
                <button type="button" onclick="toggleFinancePartTimePayrollForm()" class="text-xs font-extrabold uppercase tracking-wider text-slate-500 hover:text-slate-700 py-2 px-4 rounded-xl">Cancel</button>
                <button onclick="submitFinancePartTimePayrollEntry()" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase py-2 px-4 rounded-xl transition">Save Entry</button>
            </div>
        </div>` : ''}

        <div class="overflow-x-auto bg-white border border-slate-200 rounded-2xl shadow-xs">
            <table class="w-full text-left border-collapse">
                <thead>
                    <tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider border-b border-slate-200">
                        <th class="p-4">Staff Member</th><th class="p-4 text-right">Amount</th><th class="p-4">Status</th><th class="p-4">Note</th>
                        ${canEdit ? '<th class="p-4 text-center">Actions</th>' : ''}
                    </tr>
                </thead>
                <tbody id="fin-ptp-table-body" class="divide-y divide-slate-100 text-xs text-slate-700"></tbody>
            </table>
        </div>
    `;
    financePartTimeSelectedStaff = null;
    loadFinancePartTimePayrollRecords();
}

function changeFinancePartTimePayrollWeek(value) {
    financePartTimePayrollWeek = value;
    loadFinancePartTimePayrollRecords();
}

async function loadFinancePartTimePayrollRecords() {
    const tbody = document.getElementById('fin-ptp-table-body');
    if (!tbody) return;
    const canEdit = partTimePayrollCanEdit();
    tbody.innerHTML = `<tr><td colspan="${canEdit ? 5 : 4}" class="p-6 text-center text-slate-400 text-xs font-medium"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading&hellip;</td></tr>`;

    let records;
    try {
        records = await PartTimePayrollAPI.getRecords({ weekStart: financePartTimePayrollWeek });
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="${canEdit ? 5 : 4}" class="p-6 text-center text-rose-500 text-xs font-semibold">${escapeHTML(err.message || "Couldn't load payroll records.")}</td></tr>`;
        return;
    }
    if (!records.length) {
        tbody.innerHTML = `<tr><td colspan="${canEdit ? 5 : 4}" class="p-6 text-center text-slate-400 text-xs font-medium">No part-time payroll entries recorded for this week yet.</td></tr>`;
        return;
    }
    tbody.innerHTML = records.map(r => `
        <tr>
            <td class="p-4 font-bold text-slate-800">${escapeHTML(r.staffName)}</td>
            <td class="p-4 text-right font-extrabold">${formatUGX(r.amount)}</td>
            <td class="p-4"><span class="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-lg ${r.status === 'paid' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}">${escapeHTML(r.status)}</span></td>
            <td class="p-4 text-slate-500">${r.note ? escapeHTML(r.note) : '&mdash;'}</td>
            ${canEdit ? `
            <td class="p-4 text-center space-x-2">
                ${r.status === 'pending' ? `<button onclick="markFinancePartTimePayrollPaid(${r.id})" class="text-emerald-700 hover:text-emerald-800 text-[11px] font-extrabold uppercase tracking-wider bg-emerald-50 hover:bg-emerald-100 px-3 py-1.5 rounded-lg border border-emerald-200 transition-colors"><i class="fa-solid fa-check mr-1"></i>Mark Paid</button>
                <button onclick="deleteFinancePartTimePayrollRecord(${r.id})" class="text-rose-600 hover:text-rose-700 text-[11px] font-extrabold uppercase tracking-wider bg-rose-50 hover:bg-rose-100 px-3 py-1.5 rounded-lg border border-rose-200 transition-colors"><i class="fa-solid fa-trash mr-1"></i>Delete</button>` : '&mdash;'}
            </td>` : ''}
        </tr>
    `).join('');
}

function toggleFinancePartTimePayrollForm() {
    const el = document.getElementById('fin-ptp-form-container');
    if (el) el.classList.toggle('hidden');
}

let financePartTimeSelectedStaff = null; // { id, name } | null
let financePartTimeSearchDebounce = null;
function searchFinancePartTimeStaff(search) {
    clearTimeout(financePartTimeSearchDebounce);
    financePartTimeSearchDebounce = setTimeout(async () => {
        const resultsEl = document.getElementById('fin-ptp-staff-results');
        if (!resultsEl) return;
        if (!search.trim()) { resultsEl.innerHTML = ''; return; }
        let staff;
        try {
            staff = await PartTimePayrollAPI.lookupStaff(search.trim());
        } catch (err) {
            resultsEl.innerHTML = `<p class="text-rose-500 text-[11px] font-semibold">${escapeHTML(err.message || "Couldn't search staff.")}</p>`;
            return;
        }
        if (!staff.length) {
            resultsEl.innerHTML = `<p class="text-slate-400 text-[11px] font-medium">No active part-time staff match that search.</p>`;
            return;
        }
        resultsEl.innerHTML = staff.map(s => `
            <button type="button" onclick="selectFinancePartTimeStaff(${s.id}, '${escapeHTML(s.name)}')" class="block w-full text-left p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-700">${escapeHTML(s.name)}</button>
        `).join('');
    }, 250);
}

function selectFinancePartTimeStaff(id, name) {
    financePartTimeSelectedStaff = { id, name };
    const label = document.getElementById('fin-ptp-selected-staff');
    if (label) { label.textContent = `Selected: ${name}`; label.classList.remove('hidden'); }
    const resultsEl = document.getElementById('fin-ptp-staff-results');
    if (resultsEl) resultsEl.innerHTML = '';
    const searchInput = document.getElementById('fin-ptp-staff-search');
    if (searchInput) searchInput.value = name;
}

async function submitFinancePartTimePayrollEntry() {
    const errEl = document.getElementById('fin-ptp-form-error');
    if (errEl) errEl.classList.add('hidden');
    const amount = Number(document.getElementById('fin-ptp-amount').value);
    const note = document.getElementById('fin-ptp-note').value.trim();

    if (!financePartTimeSelectedStaff) {
        if (errEl) { errEl.textContent = 'Search for and select a staff member first.'; errEl.classList.remove('hidden'); }
        return;
    }
    if (!amount || amount <= 0) {
        if (errEl) { errEl.textContent = 'Enter a valid amount.'; errEl.classList.remove('hidden'); }
        return;
    }

    try {
        await PartTimePayrollAPI.addRecord({
            staffId: financePartTimeSelectedStaff.id,
            weekStartDate: financePartTimePayrollWeek,
            amount,
            note: note || undefined
        });
    } catch (err) {
        if (errEl) { errEl.textContent = err.message || "Couldn't save that entry."; errEl.classList.remove('hidden'); }
        return;
    }
    toggleFinancePartTimePayrollForm();
    financePartTimeSelectedStaff = null;
    const searchInput = document.getElementById('fin-ptp-staff-search');
    if (searchInput) searchInput.value = '';
    const amountInput = document.getElementById('fin-ptp-amount');
    if (amountInput) amountInput.value = '';
    const noteInput = document.getElementById('fin-ptp-note');
    if (noteInput) noteInput.value = '';
    const label = document.getElementById('fin-ptp-selected-staff');
    if (label) label.classList.add('hidden');
    loadFinancePartTimePayrollRecords();
}

async function markFinancePartTimePayrollPaid(id) {
    if (!confirm('Mark this part-time payroll entry as paid? This logs a matching expense entry and cannot be undone.')) return;
    try {
        await PartTimePayrollAPI.markPaid(id);
    } catch (err) {
        alert(err.message || "Couldn't mark that entry paid.");
        return;
    }
    loadFinancePartTimePayrollRecords();
}

async function deleteFinancePartTimePayrollRecord(id) {
    if (!confirm('Delete this part-time payroll entry?')) return;
    try {
        await PartTimePayrollAPI.deleteRecord(id);
    } catch (err) {
        alert(err.message || "Couldn't delete that entry.");
        return;
    }
    loadFinancePartTimePayrollRecords();
}
