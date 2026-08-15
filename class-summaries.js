/* =========================================================
   CLASS SCORE SUMMARIES MODULE (class-summaries.js)
   ---------------------------------------------------------
   Fully isolated add-on feature. It does NOT define any new
   API endpoints, does NOT touch marksStorage/studentsList data,
   and does NOT modify any function that already exists in
   script.js/api.js. It only READS the same global state
   (studentsList, marksStorage, termSettings) that the rest of
   the dashboard already keeps in sync via syncAllRemoteData(),
   and re-uses the SAME grading helpers the Scores/Reports
   modules already use (calculateAOAverage, computeOLevelFinalTotal,
   formatAOScoreDisplay, formatWholeScoreDisplay, displayOrDash,
   escapeHTML, formatGeneratedTimestamp) so the numbers shown here
   can never drift from — or contradict — the official gradebook.

   Scope note: AO1 / E.O.T / Final Score (100) are the O-Level
   marks model used by this school (see oLevelSubjects / the
   Scores tab / O-Level report cards). A-Level uses a different
   Paper1/Paper2/Average/Points model, so this summary is scoped
   to O-Level classes (S.1-S.4) only, to avoid mislabeling A-Level
   marks under O-Level column headings.

   Wiring into the rest of the app required exactly 3 minimal,
   additive touch-points elsewhere (each clearly commented there):
     1. api.js        -> "classsummaries" appended to the Admin
                          and Teacher tabs[] permission arrays.
     2. script.js      -> one new sidebar nav item, one new tab id
                          in switchTab()'s allow-list/title/switch.
     3. index.html     -> this file (+ the PDF export libraries)
                          added as new <script> tags.
   No existing array element, function body, route, or DB model
   was changed to do this.
   ========================================================= */

// Only O-Level classes have an AO1 / E.O.T / Final(100) marks model.
const CLASS_SUMMARY_CLASSES = ['S.1', 'S.2', 'S.3', 'S.4'];

/* ---------------------------------------------------------
   MODULE MARKUP
   --------------------------------------------------------- */
function renderClassSummariesModule() {
    const t = termSettings;
    return `
        <div class="space-y-6">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                <div class="flex flex-wrap items-end gap-4">
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Class</label>
                        <select id="css-class-select" onchange="onClassSummaryClassChange()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-extrabold text-slate-700 focus:ring-1 focus:ring-teal-500">
                            ${CLASS_SUMMARY_CLASSES.map(c => `<option value="${c}">${c}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Subject</label>
                        <select id="css-subject-select" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700"></select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Term</label>
                        <select id="css-term-select" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                            <option value="Term 1" ${t.term === 'Term 1' ? 'selected' : ''}>Term 1</option>
                            <option value="Term 2" ${t.term === 'Term 2' ? 'selected' : ''}>Term 2</option>
                            <option value="Term 3" ${t.term === 'Term 3' ? 'selected' : ''}>Term 3</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Year</label>
                        <input type="number" id="css-year-input" value="${t.year}" class="w-24 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700">
                    </div>
                    <button onclick="loadClassSummaryData()" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-magnifying-glass mr-1.5"></i>View Summary</button>
                </div>
                <div class="flex gap-2">
                    <button onclick="printClassSummary()" style="background:var(--navy-900);" class="hover:opacity-90 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-print mr-1.5"></i>Print</button>
                    <button onclick="exportClassSummaryPDF()" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-file-pdf mr-1.5"></i>Export to PDF</button>
                </div>
            </div>
            <p class="text-[11px] font-semibold text-slate-400 -mt-2">Marks are pulled live from the current gradebook (there is no separate historical record per term yet) &mdash; Term/Year here label the printed summary, the same way Report Cards do.</p>
            <div id="css-table-empty-state" class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium">
                Select a class and subject, then click &ldquo;View Summary&rdquo;.
            </div>
            <div id="css-table-wrapper" class="overflow-auto max-h-[65vh] bg-white border border-slate-200 rounded-2xl shadow-xs hidden">
                <table class="w-full text-left score-table">
                    <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider border-b border-slate-200">
                        <tr>
                            <th class="p-4">Student Name</th>
                            <th class="p-4 text-center">Class Position</th>
                            <th class="p-4 text-center">AO1 (3.0)</th>
                            <th class="p-4 text-center">E.O.T (80)</th>
                            <th class="p-4 text-center">Final Score (100)</th>
                        </tr>
                    </thead>
                    <tbody id="css-table-body" class="divide-y divide-slate-100 text-xs text-slate-700"></tbody>
                </table>
            </div>
        </div>
    `;
}
// Called from switchTab() right after the module markup is injected.
function initClassSummariesModule() {
    populateClassSummarySubjects();
}
function populateClassSummarySubjects() {
    const subjectSelect = document.getElementById('css-subject-select');
    if (!subjectSelect) return;
    // O-Level only (see CLASS_SUMMARY_CLASSES) — oLevelSubjects is the
    // same shared list the Scores tab already uses, read-only here.
    subjectSelect.innerHTML = oLevelSubjects.map(sub => `<option value="${sub}">${sub}</option>`).join('');
}
function onClassSummaryClassChange() {
    hideClassSummaryTable();
}
function hideClassSummaryTable() {
    const wrapper = document.getElementById('css-table-wrapper');
    const emptyState = document.getElementById('css-table-empty-state');
    if (wrapper) wrapper.classList.add('hidden');
    if (emptyState) emptyState.classList.remove('hidden');
}

/* ---------------------------------------------------------
   DATA / CALCULATIONS
   All grading math is delegated to the existing helpers
   (calculateAOAverage, computeOLevelFinalTotal) so this module
   can never compute a different Final Score than the Scores or
   Report Cards tabs do for the same student+subject.
   --------------------------------------------------------- */
function computeClassSummaryRows(selectedClass, selectedSubject) {
    return studentsList
        .filter(s => s.class === selectedClass)
        .map(student => {
            const recordKey = `${selectedSubject}_${student.id}`;
            // Same rule as buildOLevelRow(): an unrecorded subject is
            // { ao1: null, ao2: null, eot: null } — never defaulted to 0.
            const marks = marksStorage[recordKey] || { ao1: null, ao2: null, eot: null };
            const avScore = calculateAOAverage(marks.ao1, marks.ao2);
            const faScore = (avScore / 3.0) * 20;
            // null (not 0) when E.O.T hasn't been entered yet — matches
            // the exact same "no valid Final mark yet" rule the Scores
            // and Report Cards tabs already enforce.
            const finalTotal = computeOLevelFinalTotal(marks, faScore);
            return { student, marks, finalTotal, classPosition: null };
        });
}
// Standard "competition ranking" (1, 2, 2, 4, ...): tied Final Scores
// share the same position, and the next distinct score skips ahead
// accordingly. Students with no valid Final Score yet are left
// unranked (classPosition stays null) rather than being forced to a
// last-place number or treated as a 0.
function assignClassPositions(rows) {
    const ranked = rows
        .filter(r => r.finalTotal !== null)
        .sort((a, b) => b.finalTotal - a.finalTotal);
    let position = 0;
    let lastScore = null;
    ranked.forEach((r, idx) => {
        if (r.finalTotal !== lastScore) {
            position = idx + 1;
            lastScore = r.finalTotal;
        }
        r.classPosition = position;
    });
    return rows;
}
// Ranked students first (best position first), then any students still
// awaiting a Final Score, alphabetically — so an empty state never gets
// buried or mistaken for a real last place.
function sortClassSummaryRowsForDisplay(rows) {
    const ranked = rows.filter(r => r.classPosition !== null).sort((a, b) => a.classPosition - b.classPosition);
    const unranked = rows.filter(r => r.classPosition === null).sort((a, b) => a.student.name.localeCompare(b.student.name));
    return [...ranked, ...unranked];
}
function ordinalSuffix(n) {
    const rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
    switch (n % 10) {
        case 1: return `${n}st`;
        case 2: return `${n}nd`;
        case 3: return `${n}rd`;
        default: return `${n}th`;
    }
}
function getSelectedClassSummaryRows() {
    const classSelect = document.getElementById('css-class-select');
    const subjectSelect = document.getElementById('css-subject-select');
    if (!classSelect || !subjectSelect) return null;
    if (subjectSelect.options.length === 0) populateClassSummarySubjects();
    const selectedClass = classSelect.value;
    const selectedSubject = subjectSelect.value;
    let rows = computeClassSummaryRows(selectedClass, selectedSubject);
    rows = assignClassPositions(rows);
    rows = sortClassSummaryRowsForDisplay(rows);
    return { selectedClass, selectedSubject, rows };
}

/* ---------------------------------------------------------
   ON-SCREEN TABLE
   --------------------------------------------------------- */
function loadClassSummaryData() {
    const data = getSelectedClassSummaryRows();
    const tbody = document.getElementById('css-table-body');
    const wrapper = document.getElementById('css-table-wrapper');
    const emptyState = document.getElementById('css-table-empty-state');
    if (!data || !tbody) return;
    if (wrapper) wrapper.classList.remove('hidden');
    if (emptyState) emptyState.classList.add('hidden');

    if (data.rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-slate-400 text-xs font-medium">No students registered in ${escapeHTML(data.selectedClass)} yet. Add them in the Students tab first.</td></tr>`;
        return;
    }
    tbody.innerHTML = data.rows.map(r => `
        <tr class="hover:bg-slate-50 transition">
            <td class="p-4 font-bold text-slate-900">${escapeHTML(r.student.name)}</td>
            <td class="p-4 text-center font-extrabold text-teal-700">${r.classPosition !== null ? ordinalSuffix(r.classPosition) : '-'}</td>
            <td class="p-4 text-center">${formatAOScoreDisplay(r.marks.ao1, '-')}</td>
            <td class="p-4 text-center">${formatWholeScoreDisplay(r.marks.eot, '-')}</td>
            <td class="p-4 text-center font-extrabold text-slate-800">${displayOrDash(r.finalTotal, '-')}</td>
        </tr>
    `).join('');
}

/* ---------------------------------------------------------
   PRINT (reuses the app's existing #print-area mechanism —
   see printOwnReportCard()/printReportCards() in script.js.
   #dashboard-section is already hidden and #print-area is
   already the only thing shown during @media print, in the
   pre-existing global CSS rule in styles.css, so no new CSS
   is needed to hide the sidebar/header/buttons when printing.)
   --------------------------------------------------------- */
function buildClassSummaryPrintHTML(selectedClass, selectedSubject, rows, term, year) {
    const rowsHtml = rows.length > 0 ? rows.map(r => `
        <tr>
            <td class="rc-subj">${escapeHTML(r.student.name)}</td>
            <td class="rc-num">${r.classPosition !== null ? ordinalSuffix(r.classPosition) : '-'}</td>
            <td class="rc-num">${formatAOScoreDisplay(r.marks.ao1, '-')}</td>
            <td class="rc-num">${formatWholeScoreDisplay(r.marks.eot, '-')}</td>
            <td class="rc-final">${displayOrDash(r.finalTotal, '-')}</td>
        </tr>
    `).join('') : `<tr><td colspan="5" class="rc-empty">No students registered in this class yet.</td></tr>`;

    // Re-uses the existing .report-page / .rc-* classes from styles.css
    // (already print-tuned for report cards) — no new CSS required.
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
            </div>
            <div class="rc-report-title">CLASS SCORE SUMMARY</div>
            <div class="rc-learner-row">
                <div><span>CLASS:</span><span class="rc-tag">${escapeHTML(selectedClass)}</span></div>
                <div><span>SUBJECT:</span><span class="rc-tag">${escapeHTML(selectedSubject)}</span></div>
                <div><span>TERM:</span><span class="rc-tag">${escapeHTML(term)}</span></div>
                <div><span>YEAR:</span><span class="rc-tag">${escapeHTML(String(year))}</span></div>
            </div>
            <table class="rc-table">
                <thead>
                    <tr>
                        <th>Student Name</th>
                        <th>Class Position</th>
                        <th>AO1</th>
                        <th>E.O.T</th>
                        <th>Final Score (100)</th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
            <p class="rc-print-meta" style="margin-top:10px;">Printed on ${formatGeneratedTimestamp()} &middot; via Luweero Community SS Management System</p>
        </div>
    `;
}
function getSelectedClassSummaryTermLabel() {
    const termSelect = document.getElementById('css-term-select');
    const yearInput = document.getElementById('css-year-input');
    return {
        term: termSelect ? termSelect.value : termSettings.term,
        year: yearInput ? yearInput.value : termSettings.year
    };
}
function printClassSummary() {
    const data = getSelectedClassSummaryRows();
    const printArea = document.getElementById('print-area');
    if (!data || !printArea) return;
    const { term, year } = getSelectedClassSummaryTermLabel();
    printArea.innerHTML = buildClassSummaryPrintHTML(data.selectedClass, data.selectedSubject, data.rows, term, year);
    // Same "temporarily rename the tab for the Save-as-PDF filename" trick
    // already used by printReportCards() in script.js.
    const suggestedName = `${data.selectedClass}_${data.selectedSubject}_ClassSummary_${term.replace(/\s+/g, '')}_${year}`.replace(/[^\w-]/g, '');
    const originalTitle = document.title;
    document.title = suggestedName;
    window.print();
    document.title = originalTitle;
}

/* ---------------------------------------------------------
   EXPORT TO PDF (direct download button, separate from Print).
   Uses html2canvas + jsPDF, loaded via new <script> tags in
   index.html (see the comment there) — purely additive
   dependencies, only used by this module.
   --------------------------------------------------------- */
async function exportClassSummaryPDF() {
    const data = getSelectedClassSummaryRows();
    if (!data) return;
    if (typeof html2canvas === 'undefined' || !window.jspdf) {
        alert('PDF export couldn\'t load its required library (no internet connection?). Please use the Print button and choose "Save as PDF" instead.');
        return;
    }
    const { term, year } = getSelectedClassSummaryTermLabel();
    const html = buildClassSummaryPrintHTML(data.selectedClass, data.selectedSubject, data.rows, term, year);

    // Render off-screen (not display:none — html2canvas needs real layout)
    // so this never touches the visible DOM the user is looking at.
    const holder = document.createElement('div');
    holder.style.position = 'fixed';
    holder.style.top = '0';
    holder.style.left = '-10000px';
    holder.style.background = '#ffffff';
    holder.innerHTML = html;
    document.body.appendChild(holder);

    const exportBtn = document.querySelector('[onclick="exportClassSummaryPDF()"]');
    const originalBtnHTML = exportBtn ? exportBtn.innerHTML : null;
    if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Preparing PDF&hellip;';
    }

    try {
        const target = holder.querySelector('.report-page');
        const canvas = await html2canvas(target, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
        const imgData = canvas.toDataURL('image/png');
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pageWidth = 210;
        const pageHeight = (canvas.height * pageWidth) / canvas.width;
        pdf.addImage(imgData, 'PNG', 0, 0, pageWidth, pageHeight);
        const fileName = `${data.selectedClass}_${data.selectedSubject}_ClassSummary_${term.replace(/\s+/g, '')}_${year}`.replace(/[^\w-]/g, '');
        pdf.save(`${fileName}.pdf`);
    } catch (err) {
        console.error('Class Score Summary PDF export failed:', err);
        alert('Could not generate the PDF. Please try the Print button instead, then choose "Save as PDF".');
    } finally {
        document.body.removeChild(holder);
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.innerHTML = originalBtnHTML;
        }
    }
}
