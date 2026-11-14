/* =========================================================
   marks-approval.js — DOS approval of marks + Marks Audit Trail
   (isolated add-on, same pattern as class-summaries.js)

   What this file provides
   - Teacher side (Scores tab): a status bar under the marks table showing
     how many rows are Draft / Submitted / Verified / Returned, a
     "Submit to DOS" button, and the DOS's reason when marks are returned.
   - DOS (Administrator) side:
       * "Marks Approval" tab — everything waiting for approval; open a
         class+subject, check the marks, then Verify or Return with a reason.
       * "Marks Audit Trail" tab — who entered/changed/deleted/submitted/
         verified which mark, when, from which IP, old value -> new value.
   - A red count on the "Marks Approval" nav item while marks are waiting.

   Depends on (all defined by api.js / script.js, loaded before this file):
   ScoresAPI, ENDPOINTS, apiRequest, currentUser, marksStorage,
   studentsList, getViewedTermYear, escapeHTML, showToast,
   hasRecordedScore, loadScoreSheetData, refreshScoresList.
   ========================================================= */

/* ---------------------------------------------------------
   Shared bits
   --------------------------------------------------------- */
const SCORE_STATUS_META = {
    draft:     { label: 'Draft',     chip: 'bg-slate-100 text-slate-600 border-slate-300' },
    submitted: { label: 'Submitted', chip: 'bg-amber-50 text-amber-700 border-amber-300' },
    verified:  { label: 'Verified',  chip: 'bg-emerald-50 text-emerald-700 border-emerald-300' },
    rejected:  { label: 'Returned',  chip: 'bg-rose-50 text-rose-700 border-rose-300' }
};
const MARK_FIELD_LABELS = { ao1: 'AO1', ao2: 'AO2', eot: 'EOT', p1: 'Paper 1', p2: 'Paper 2' };

function scoreStatusChip(status) {
    const meta = SCORE_STATUS_META[status] || SCORE_STATUS_META.draft;
    return `<span class="inline-block px-2 py-0.5 rounded-full border text-[10px] font-extrabold uppercase tracking-wider ${meta.chip}">${meta.label}</span>`;
}

// A Teacher can't edit marks once they're submitted or verified (the server
// enforces this too — this just keeps the UI honest instead of letting them
// type into a box that will be refused).
function isScoreLockedForCurrentUser(marks) {
    if (!marks || currentUser.role !== 'Teacher') return false;
    return marks.status === 'submitted' || marks.status === 'verified';
}
function scoreLockAttr(marks) {
    if (!isScoreLockedForCurrentUser(marks)) return '';
    const why = marks.status === 'verified'
        ? 'Verified by the DOS — locked. Ask the DOS to return it if it needs correcting.'
        : 'Submitted to the DOS — locked while awaiting approval.';
    return ` disabled title="${why}"`;
}
// Small status chip next to the student's name in the marks table. Only
// shown once the row actually holds a mark.
function scoreStatusBadge(marks) {
    if (!marks || !marks.status || typeof hasRecordedScore !== 'function' || !hasRecordedScore(marks)) return '';
    return ` ${scoreStatusChip(marks.status)}`;
}

function formatApprovalTimestamp(value) {
    const d = new Date(value);
    if (isNaN(d)) return value || '-';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
        ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function isALevelClass(classLevel) { return classLevel === 'S.5' || classLevel === 'S.6'; }

/* ---------------------------------------------------------
   Teacher side: status bar + Submit to DOS (Scores tab)
   --------------------------------------------------------- */
function refreshScoreApprovalBar() {
    const bar = document.getElementById('score-approval-bar');
    const classSelect = document.getElementById('score-class-select');
    const subjectSelect = document.getElementById('score-subject-select');
    const wrapper = document.getElementById('score-table-wrapper');
    if (!bar || !classSelect || !subjectSelect) return;
    if (!wrapper || wrapper.classList.contains('hidden')) { bar.classList.add('hidden'); return; }

    const classLevel = classSelect.value;
    const subject = subjectSelect.value;
    const { term, year } = getViewedTermYear();
    const counts = { draft: 0, submitted: 0, verified: 0, rejected: 0 };
    const rejectedNotes = new Set();
    studentsList.filter(s => s.class === classLevel).forEach(s => {
        const m = marksStorage[buildScoreRecordKey(subject, s.id, term, year)];
        if (!m || !m.touched || !hasRecordedScore(m)) return;
        const st = counts[m.status] !== undefined ? m.status : 'draft';
        counts[st]++;
        if (st === 'rejected' && m.reviewNote) rejectedNotes.add(m.reviewNote);
    });
    const total = counts.draft + counts.submitted + counts.verified + counts.rejected;
    const submittable = counts.draft + counts.rejected;

    const chips = ['draft', 'submitted', 'verified', 'rejected']
        .filter(k => counts[k] > 0)
        .map(k => `${scoreStatusChip(k)} <span class="text-xs font-extrabold text-slate-700 mr-3">${counts[k]}</span>`)
        .join('');

    const canSubmit = currentUser.role === 'Teacher' || currentUser.role === 'Administrator';
    const submitBtn = (canSubmit && submittable > 0)
        ? `<button onclick="submitMarksToDOS(this)" class="bg-teal-700 hover:bg-teal-800 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-paper-plane mr-1.5"></i>Submit ${submittable} to DOS for approval</button>`
        : '';
    const notes = rejectedNotes.size
        ? `<div class="w-full text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3"><i class="fa-solid fa-triangle-exclamation mr-1.5"></i>Returned by the DOS: ${Array.from(rejectedNotes).map(escapeHTML).join(' &middot; ')}. Correct the marks, then submit again.</div>`
        : '';
    const hint = total === 0
        ? 'No marks entered for this subject yet.'
        : (submittable > 0
            ? 'Marks you enter are saved as drafts. Parents/students and report cards only see them after the DOS verifies them.'
            : (counts.submitted > 0 ? 'Waiting for the DOS to verify.' : 'All marks verified by the DOS.'));

    bar.innerHTML = `
        <div class="flex flex-wrap items-center gap-2 w-full">
            <span class="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mr-2">DOS Approval</span>
            ${chips}
            <span class="text-[11px] text-slate-400 font-medium flex-1 min-w-[12rem]">${hint}</span>
            ${submitBtn}
        </div>
        ${notes}`;
    bar.classList.remove('hidden');
}

async function submitMarksToDOS(btn) {
    const classLevel = document.getElementById('score-class-select')?.value;
    const subject = document.getElementById('score-subject-select')?.value;
    if (!classLevel || !subject) return;
    if (typeof unsavedScoreRows !== 'undefined' && unsavedScoreRows.size > 0) {
        alert('Some marks have not saved to the server yet (highlighted in red). Click "Save Marks Entry" first, then submit.');
        return;
    }
    if (!confirm(`Submit ${subject} (${classLevel}) marks to the DOS for approval?\n\nOnce submitted you will not be able to change them unless the DOS returns them.`)) return;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Submitting...'; }
    try {
        const result = await ScoresAPI.submit(classLevel, subject, getViewedTermYear());
        showToast(`${result.submitted} mark${result.submitted === 1 ? '' : 's'} submitted to the DOS.`, 'success');
    } catch (err) {
        showToast(err.message || 'Could not submit marks. Please try again.', 'error');
    }
    await refreshScoresList();
    loadScoreSheetData();
}

/* ---------------------------------------------------------
   DOS side: nav badge
   --------------------------------------------------------- */
async function refreshApprovalNavBadge() {
    if (currentUser.role !== 'Administrator') return;
    const btn = document.getElementById('nav-marksapproval');
    if (!btn) return;
    let waiting = 0;
    try {
        const data = await ScoresAPI.review(getViewedTermYear());
        waiting = (data.batches || []).reduce((sum, b) => sum + (b.submitted || 0), 0);
    } catch (e) { return; }
    const old = btn.querySelector('.approval-badge');
    if (old) old.remove();
    if (waiting > 0) {
        const span = document.createElement('span');
        span.className = 'approval-badge ml-auto bg-rose-500 text-white text-[10px] font-extrabold rounded-full px-2 py-0.5';
        span.textContent = waiting;
        span.title = `${waiting} mark${waiting === 1 ? '' : 's'} waiting for your approval`;
        btn.appendChild(span);
    }
}

/* ---------------------------------------------------------
   DOS side: Marks Approval tab
   --------------------------------------------------------- */
let approvalOpenBatch = null; // { classLevel, subject }
let approvalDetailRows = [];

function renderMarksApprovalModule() {
    const { term, year } = getViewedTermYear();
    return `
        <div class="space-y-6">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                <div>
                    <p class="text-sm font-extrabold text-slate-800">Marks waiting for your approval &mdash; ${escapeHTML(term)} ${escapeHTML(year)}</p>
                    <p class="text-xs font-semibold text-slate-500 mt-1">Teachers submit a class and subject when they finish entering marks. Check them, then verify or return them with a reason. Only verified marks appear on report cards and to students.</p>
                </div>
                <button onclick="loadMarksApprovalData()" class="bg-slate-100 hover:bg-slate-200 text-teal-700 text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl border border-slate-300 transition"><i class="fa-solid fa-rotate-right mr-1.5"></i>Refresh</button>
            </div>
            <div class="overflow-x-auto bg-white border border-slate-200 rounded-2xl shadow-xs">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider border-b border-slate-200">
                            <th class="p-4">Class</th><th class="p-4">Subject</th>
                            <th class="p-4 text-center">Draft</th><th class="p-4 text-center">Submitted</th>
                            <th class="p-4 text-center">Verified</th><th class="p-4 text-center">Returned</th>
                            <th class="p-4">Last submitted</th><th class="p-4"></th>
                        </tr>
                    </thead>
                    <tbody id="approval-batches-body" class="divide-y divide-slate-100 text-xs text-slate-700">
                        <tr><td colspan="8" class="p-6 text-center text-slate-400 font-medium">Loading&hellip;</td></tr>
                    </tbody>
                </table>
            </div>
            <div id="approval-detail" class="hidden"></div>
        </div>`;
}

async function loadMarksApprovalData() {
    const tbody = document.getElementById('approval-batches-body');
    if (!tbody) return;
    let data;
    try {
        data = await ScoresAPI.review(getViewedTermYear());
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="8" class="p-6 text-center text-rose-500 font-semibold">${escapeHTML(err.message || 'Could not load marks for approval.')}</td></tr>`;
        return;
    }
    const batches = data.batches || [];
    if (!batches.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="p-6 text-center text-slate-400 font-medium">No marks have been entered for this term yet.</td></tr>`;
    } else {
        tbody.innerHTML = batches.map(b => `
            <tr class="hover:bg-slate-50 transition-colors${b.submitted > 0 ? ' bg-amber-50/40' : ''}">
                <td class="p-4 font-bold text-slate-900">${escapeHTML(b.classLevel)}</td>
                <td class="p-4 font-bold text-slate-800">${escapeHTML(b.subject)}</td>
                <td class="p-4 text-center">${b.draft || '-'}</td>
                <td class="p-4 text-center font-extrabold ${b.submitted ? 'text-amber-700' : ''}">${b.submitted || '-'}</td>
                <td class="p-4 text-center">${b.verified || '-'}</td>
                <td class="p-4 text-center ${b.rejected ? 'text-rose-600 font-extrabold' : ''}">${b.rejected || '-'}</td>
                <td class="p-4 text-slate-500 font-semibold">${b.submittedAt ? escapeHTML(b.submittedBy || '') + '<br><span class="text-[11px]">' + formatApprovalTimestamp(b.submittedAt) + '</span>' : '-'}</td>
                <td class="p-4 text-right"><button data-class="${escapeHTML(b.classLevel)}" data-subject="${escapeHTML(b.subject)}" onclick="openApprovalBatch(this.dataset.class, this.dataset.subject)" class="btn-neu-light text-[11px] font-extrabold uppercase tracking-wider py-2 px-3 rounded-xl transition shadow-xs">Review</button></td>
            </tr>`).join('');
    }
    if (approvalOpenBatch) openApprovalBatch(approvalOpenBatch.classLevel, approvalOpenBatch.subject, true);
    refreshApprovalNavBadge();
}

async function openApprovalBatch(classLevel, subject, silent) {
    const panel = document.getElementById('approval-detail');
    if (!panel) return;
    approvalOpenBatch = { classLevel, subject };
    if (!silent) panel.innerHTML = '<div class="bg-white border border-slate-200 rounded-2xl p-6 text-center text-slate-400 text-xs font-medium">Loading marks&hellip;</div>';
    panel.classList.remove('hidden');
    let data;
    try {
        data = await ScoresAPI.reviewDetail(classLevel, subject, getViewedTermYear());
    } catch (err) {
        panel.innerHTML = `<div class="bg-white border border-rose-200 rounded-2xl p-6 text-center text-rose-500 text-xs font-semibold">${escapeHTML(err.message || 'Could not load these marks.')}</div>`;
        return;
    }
    approvalDetailRows = data.rows || [];
    const aLevel = isALevelClass(classLevel);
    const cols = aLevel ? ['p1', 'p2'] : ['ao1', 'ao2', 'eot'];
    const fmt = (v) => (v === null || v === undefined || v === '') ? '-' : Number(v);

    const body = approvalDetailRows.map((r, i) => {
        const actionable = r.status !== 'draft';
        const flag = r.editsAfterSubmit > 0
            ? `<span class="text-rose-600 font-extrabold" title="Changed ${r.editsAfterSubmit} time(s) after it was submitted">&#9888; edited after submit</span>`
            : (r.editCount > 2 ? `<span class="text-amber-600 font-bold" title="Changed several times">edited ${r.editCount}&times;</span>` : (r.editCount > 1 ? `<span class="text-slate-400">edited ${r.editCount}&times;</span>` : ''));
        return `
            <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-3"><input type="checkbox" class="approval-row-check" data-key="${escapeHTML(r.recordKey)}" ${r.status === 'submitted' ? 'checked' : ''} ${actionable ? '' : 'disabled'}></td>
                <td class="p-3 font-bold text-slate-900">${escapeHTML(r.studentName || r.studentId)}<div class="text-[10px] text-slate-400 font-semibold">${escapeHTML(r.studentId)}</div></td>
                ${cols.map(c => `<td class="p-3 text-center font-extrabold text-slate-800">${fmt(r[c])}</td>`).join('')}
                <td class="p-3">${scoreStatusChip(r.status)}${r.status === 'rejected' && r.reviewNote ? `<div class="text-[10px] text-rose-600 font-semibold mt-1 max-w-[14rem]">${escapeHTML(r.reviewNote)}</div>` : ''}</td>
                <td class="p-3 text-slate-500 font-semibold">${escapeHTML(r.lastEditedBy || '-')}</td>
                <td class="p-3 text-[11px]">${flag}</td>
            </tr>`;
    }).join('');

    const counts = approvalDetailRows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
    panel.innerHTML = `
        <div class="bg-white border border-slate-200 rounded-2xl shadow-xs">
            <div class="flex flex-col md:flex-row md:items-center justify-between gap-3 p-5 border-b border-slate-200">
                <div>
                    <p class="text-sm font-extrabold text-slate-800">${escapeHTML(subject)} &mdash; ${escapeHTML(classLevel)}</p>
                    <p class="text-xs font-semibold text-slate-500 mt-0.5">${counts.submitted || 0} submitted &middot; ${counts.verified || 0} verified &middot; ${counts.rejected || 0} returned &middot; ${counts.draft || 0} still draft</p>
                </div>
                <div class="flex flex-wrap gap-2">
                    <button onclick="verifySelectedMarks()" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-circle-check mr-1.5"></i>Verify selected</button>
                    <button onclick="returnSelectedMarks()" class="bg-white hover:bg-rose-50 text-rose-600 border border-rose-300 text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-rotate-left mr-1.5"></i>Return to teacher</button>
                    <button onclick="closeApprovalBatch()" class="bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-extrabold uppercase tracking-wider py-2.5 px-3 rounded-xl border border-slate-300 transition">Close</button>
                </div>
            </div>
            <div class="overflow-auto max-h-[60vh]">
                <table class="w-full text-left">
                    <thead>
                        <tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider border-b border-slate-200">
                            <th class="p-3"><input type="checkbox" onchange="toggleApprovalSelectAll(this.checked)" title="Select all"></th>
                            <th class="p-3">Student</th>
                            ${cols.map(c => `<th class="p-3 text-center">${MARK_FIELD_LABELS[c]}</th>`).join('')}
                            <th class="p-3">Status</th><th class="p-3">Last edited by</th><th class="p-3">History</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100 text-xs text-slate-700">${body || `<tr><td colspan="${cols.length + 5}" class="p-6 text-center text-slate-400 font-medium">No marks entered for this subject.</td></tr>`}</tbody>
                </table>
            </div>
            <p class="p-4 text-[11px] text-slate-400 font-medium border-t border-slate-100">Tip: you can only verify rows that are <b>Submitted</b>. A <b>Verified</b> row can be returned if a mistake is found later. Every decision is recorded in the Marks Audit Trail.</p>
        </div>`;
}

function closeApprovalBatch() {
    approvalOpenBatch = null;
    const panel = document.getElementById('approval-detail');
    if (panel) { panel.classList.add('hidden'); panel.innerHTML = ''; }
}
function toggleApprovalSelectAll(checked) {
    document.querySelectorAll('.approval-row-check:not(:disabled)').forEach(cb => { cb.checked = checked; });
}
function getSelectedApprovalKeys(statuses) {
    return Array.from(document.querySelectorAll('.approval-row-check:checked'))
        .map(cb => cb.dataset.key)
        .filter(key => {
            const row = approvalDetailRows.find(r => r.recordKey === key);
            return row && statuses.includes(row.status);
        });
}

async function verifySelectedMarks() {
    if (!approvalOpenBatch) return;
    const keys = getSelectedApprovalKeys(['submitted']);
    if (!keys.length) { alert('Tick at least one Submitted row to verify.'); return; }
    if (!confirm(`Verify ${keys.length} mark${keys.length === 1 ? '' : 's'} for ${approvalOpenBatch.subject} (${approvalOpenBatch.classLevel})?\n\nThey will be locked and become visible on report cards and to students.`)) return;
    try {
        const r = await ScoresAPI.verify(approvalOpenBatch.classLevel, approvalOpenBatch.subject, keys, getViewedTermYear());
        showToast(`${r.verified} mark${r.verified === 1 ? '' : 's'} verified.`, 'success');
    } catch (err) {
        showToast(err.message || 'Could not verify these marks.', 'error');
    }
    await loadMarksApprovalData();
    if (typeof refreshScoresList === 'function') refreshScoresList();
}

async function returnSelectedMarks() {
    if (!approvalOpenBatch) return;
    const keys = getSelectedApprovalKeys(['submitted', 'verified']);
    if (!keys.length) { alert('Tick at least one Submitted or Verified row to return.'); return; }
    const reason = prompt(`Why are you returning ${keys.length} mark${keys.length === 1 ? '' : 's'}? The teacher will see this reason.`);
    if (reason === null) return;
    if (reason.trim().length < 3) { alert('Please type a reason so the teacher knows what to correct.'); return; }
    try {
        const r = await ScoresAPI.reject(approvalOpenBatch.classLevel, approvalOpenBatch.subject, keys, reason.trim(), getViewedTermYear());
        showToast(`${r.rejected} mark${r.rejected === 1 ? '' : 's'} returned to the teacher.`, 'success');
    } catch (err) {
        showToast(err.message || 'Could not return these marks.', 'error');
    }
    await loadMarksApprovalData();
    if (typeof refreshScoresList === 'function') refreshScoresList();
}

/* ---------------------------------------------------------
   DOS side: Marks Audit Trail tab
   --------------------------------------------------------- */
let auditRowsCache = [];
const AUDIT_ACTION_META = {
    CREATE: { label: 'Entered',   chip: 'bg-sky-50 text-sky-700 border-sky-300' },
    UPDATE: { label: 'Changed',   chip: 'bg-amber-50 text-amber-700 border-amber-300' },
    DELETE: { label: 'Deleted',   chip: 'bg-rose-50 text-rose-700 border-rose-300' },
    SUBMIT: { label: 'Submitted', chip: 'bg-indigo-50 text-indigo-700 border-indigo-300' },
    VERIFY: { label: 'Verified',  chip: 'bg-emerald-50 text-emerald-700 border-emerald-300' },
    REJECT: { label: 'Returned',  chip: 'bg-rose-50 text-rose-700 border-rose-300' }
};

function renderMarksAuditModule() {
    const input = 'p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700 focus:outline-none focus:ring-1 focus:ring-teal-500';
    const label = 'block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1';
    return `
        <div class="space-y-6">
            <div class="bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                <p class="text-xs font-semibold text-slate-500 mb-4">Every mark entered, changed, deleted, submitted or verified is recorded here with who did it, when and from where. This record cannot be edited or cleared from the portal.</p>
                <div class="flex flex-wrap items-end gap-3">
                    <div><label class="${label}">Term</label>
                        <select id="audit-filter-scope" class="${input}"><option value="current">Viewed term</option><option value="all">All terms</option></select></div>
                    <div><label class="${label}">Class</label>
                        <select id="audit-filter-class" class="${input}"><option value="">All</option>${['S.1', 'S.2', 'S.3', 'S.4', 'S.5', 'S.6'].map(c => `<option>${c}</option>`).join('')}</select></div>
                    <div><label class="${label}">Subject</label>
                        <input id="audit-filter-subject" type="text" placeholder="e.g. MATHEMATICS" class="${input} w-40 uppercase"></div>
                    <div><label class="${label}">Student</label>
                        <input id="audit-filter-student" type="text" placeholder="ID or name" class="${input} w-36"></div>
                    <div><label class="${label}">Teacher / user</label>
                        <input id="audit-filter-actor" type="text" placeholder="username" class="${input} w-32"></div>
                    <div><label class="${label}">Action</label>
                        <select id="audit-filter-action" class="${input}"><option value="">All</option>${Object.keys(AUDIT_ACTION_META).map(k => `<option value="${k}">${AUDIT_ACTION_META[k].label}</option>`).join('')}</select></div>
                    <button onclick="loadMarksAuditData()" class="btn-neu-light text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-magnifying-glass mr-1.5"></i>Search</button>
                    <button onclick="downloadMarksAuditCsv()" class="bg-slate-100 hover:bg-slate-200 text-teal-700 text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl border border-slate-300 transition"><i class="fa-solid fa-file-csv mr-1.5"></i>Download CSV</button>
                </div>
            </div>
            <div class="overflow-x-auto bg-white border border-slate-200 rounded-2xl shadow-xs">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider border-b border-slate-200">
                            <th class="p-4">When</th><th class="p-4">Who</th><th class="p-4">Action</th><th class="p-4">Student</th>
                            <th class="p-4">Subject</th><th class="p-4">What changed</th><th class="p-4">Status</th><th class="p-4">IP</th>
                        </tr>
                    </thead>
                    <tbody id="marks-audit-body" class="divide-y divide-slate-100 text-xs text-slate-700">
                        <tr><td colspan="8" class="p-6 text-center text-slate-400 font-medium">Loading&hellip;</td></tr>
                    </tbody>
                </table>
            </div>
            <p id="marks-audit-count" class="text-[11px] text-slate-400 font-medium"></p>
        </div>`;
}

function describeAuditChange(e) {
    const oldV = e.oldValues || {}, newV = e.newValues || {};
    const fmt = (v) => (v === null || v === undefined) ? 'blank' : v;
    if (e.action === 'UPDATE') {
        return Object.keys(newV).map(f => `<b>${MARK_FIELD_LABELS[f] || f}</b>: ${fmt(oldV[f])} &rarr; ${fmt(newV[f])}`).join('<br>');
    }
    if (e.action === 'CREATE') {
        const parts = Object.keys(newV).filter(f => newV[f] !== null).map(f => `<b>${MARK_FIELD_LABELS[f] || f}</b>: ${newV[f]}`);
        return parts.join(', ') || '-';
    }
    if (e.action === 'DELETE') {
        const parts = Object.keys(oldV).filter(f => oldV[f] !== null).map(f => `<b>${MARK_FIELD_LABELS[f] || f}</b>: ${oldV[f]}`);
        return 'Removed marks &mdash; ' + (parts.join(', ') || 'none recorded');
    }
    const parts = Object.keys(newV).filter(f => newV[f] !== null).map(f => `${MARK_FIELD_LABELS[f] || f} ${newV[f]}`);
    const snapshot = parts.length ? `<span class="text-slate-400">${parts.join(', ')}</span>` : '';
    const note = e.note ? `<div class="text-rose-600 font-semibold">&ldquo;${escapeHTML(e.note)}&rdquo;</div>` : '';
    return note + snapshot;
}

async function loadMarksAuditData() {
    const tbody = document.getElementById('marks-audit-body');
    if (!tbody) return;
    const val = (id) => (document.getElementById(id)?.value || '').trim();
    const params = new URLSearchParams();
    if (val('audit-filter-scope') !== 'all') {
        const { term, year } = getViewedTermYear();
        params.set('term', term); params.set('year', year);
    }
    if (val('audit-filter-class')) params.set('class', val('audit-filter-class'));
    if (val('audit-filter-subject')) params.set('subject', val('audit-filter-subject').toUpperCase());
    if (val('audit-filter-student')) params.set('student', val('audit-filter-student'));
    if (val('audit-filter-actor')) params.set('actor', val('audit-filter-actor'));
    if (val('audit-filter-action')) params.set('action', val('audit-filter-action'));
    params.set('limit', '500');

    let rows;
    try {
        rows = await ScoresAPI.audit(params);
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="8" class="p-6 text-center text-rose-500 font-semibold">${escapeHTML(err.message || 'Could not load the audit trail.')}</td></tr>`;
        return;
    }
    auditRowsCache = Array.isArray(rows) ? rows : [];
    const count = document.getElementById('marks-audit-count');
    if (count) count.textContent = auditRowsCache.length ? `Showing the ${auditRowsCache.length} most recent matching entr${auditRowsCache.length === 1 ? 'y' : 'ies'}.` : '';
    if (!auditRowsCache.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="p-6 text-center text-slate-400 font-medium">No marks activity matches these filters.</td></tr>`;
        return;
    }
    tbody.innerHTML = auditRowsCache.map(e => {
        const meta = AUDIT_ACTION_META[e.action] || { label: e.action, chip: 'bg-slate-100 text-slate-600 border-slate-300' };
        return `
            <tr class="hover:bg-slate-50 transition-colors align-top">
                <td class="p-4 text-slate-600 font-semibold whitespace-nowrap">${formatApprovalTimestamp(e.createdAt)}</td>
                <td class="p-4"><div class="font-bold text-slate-900">${escapeHTML(e.actorName || e.actorUsername)}</div><div class="text-[10px] text-slate-400 font-semibold">${escapeHTML(e.actorUsername)} &middot; ${escapeHTML(e.actorRole || '')}</div></td>
                <td class="p-4"><span class="inline-block px-2 py-0.5 rounded-full border text-[10px] font-extrabold uppercase tracking-wider ${meta.chip}">${meta.label}</span></td>
                <td class="p-4 font-semibold"><div class="text-slate-900">${escapeHTML(e.studentName || e.studentId)}</div><div class="text-[10px] text-slate-400">${escapeHTML(e.studentId)}</div></td>
                <td class="p-4 font-semibold">${escapeHTML(e.subject)}<div class="text-[10px] text-slate-400">${escapeHTML(e.classLevel || '')} &middot; ${escapeHTML(e.term)} ${escapeHTML(e.year)}</div></td>
                <td class="p-4">${describeAuditChange(e)}</td>
                <td class="p-4 text-[11px] text-slate-500 font-semibold whitespace-nowrap">${e.oldStatus || e.newStatus ? `${escapeHTML(e.oldStatus || '-')} &rarr; ${escapeHTML(e.newStatus || '-')}` : '-'}</td>
                <td class="p-4 font-mono text-[11px] text-slate-500">${escapeHTML(e.ipAddress || '-')}</td>
            </tr>`;
    }).join('');
}

function downloadMarksAuditCsv() {
    if (!auditRowsCache.length) { alert('Nothing to download — run a search first.'); return; }
    const q = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
    const header = ['When', 'User', 'Name', 'Role', 'Action', 'Student ID', 'Student', 'Class', 'Subject', 'Term', 'Year', 'Old values', 'New values', 'Old status', 'New status', 'Note', 'IP'];
    const lines = auditRowsCache.map(e => [
        e.createdAt, e.actorUsername, e.actorName, e.actorRole, e.action, e.studentId, e.studentName, e.classLevel,
        e.subject, e.term, e.year, e.oldValues ? JSON.stringify(e.oldValues) : '', e.newValues ? JSON.stringify(e.newValues) : '',
        e.oldStatus, e.newStatus, e.note, e.ipAddress
    ].map(q).join(','));
    const blob = new Blob([[header.map(q).join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `marks-audit-trail-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
