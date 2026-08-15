/* =========================================================
   GENERAL MARK SHEET MODULE (class-summaries.js)
   ---------------------------------------------------------
   Fully isolated add-on feature (formerly a single-subject
   "Class Score Summary", now a comprehensive General Mark
   Sheet with an O-Level / A-Level toggle). It does NOT define
   any new API endpoints, does NOT touch marksStorage/studentsList
   data, and does NOT modify any function that already exists in
   script.js/api.js. It only READS the same global state
   (studentsList, marksStorage, termSettings, oLevelSubjects,
   aLevelSubjects, subsidiarySubjects) that the rest of the
   dashboard already keeps in sync via syncAllRemoteData(), and
   re-uses the SAME grading helpers the Scores/Reports modules
   already use (calculateAOAverage, computeOLevelFinalTotal,
   computeALevelAvgMark, computeALevelGrade, formatAOScoreDisplay,
   formatWholeScoreDisplay, formatALevelSubjectDisplayName,
   displayOrDash, escapeHTML, formatGeneratedTimestamp) so the
   numbers shown here can never drift from — or contradict — the
   official gradebook.

   Scope note / why a toggle: O-Level uses the AO1 / AO2 / E.O.T /
   Final(100) marks model; A-Level uses a different Paper1 / Paper2
   / Average / Points (UACE-style) model (see oLevelSubjects vs
   aLevelSubjects, buildOLevelRow vs buildALevelRow, and
   computeOLevelFinalTotal vs computeALevelAvgMark/computeALevelGrade
   in script.js). Rather than force one column layout onto both,
   this page has two views behind an explicit Level toggle:
     - "O-Level" (S.1-S.4): subject columns are AO1 / AO2 / E.O.T /
       Final, and the overall rollup is a Total/Average of Final
       Scores.
     - "A-Level" (S.5-S.6): subject columns are P1 / P2 / Avg /
       Points, and the overall rollup is Total Points / Avg Mark
       (the standard UACE-style aggregate), with subsidiary
       subjects flagged exactly as the A-Level report card already
       flags them.
   Both views delegate 100% of their per-subject math to the exact
   same helper functions the Scores tab and report cards already
   use — this file adds no new grading rules for either level.

   Wiring into the rest of the app required exactly 3 minimal,
   additive touch-points elsewhere (each clearly commented there),
   UNCHANGED by this update:
     1. api.js        -> "classsummaries" appended to the Admin
                          and Teacher tabs[] permission arrays.
     2. script.js      -> one new sidebar nav item, one new tab id
                          in switchTab()'s allow-list/title/switch.
     3. index.html     -> this file (+ the PDF export libraries)
                          added as new <script> tags.
   No existing array element, function body, route, or DB model
   was changed to do this, then or now. All Landscape / matrix /
   PDF-pagination logic below lives entirely inside this file
   (including its own embedded <style> blocks for the on-screen
   matrix and the print/PDF layout) so nothing here can affect any
   other page's CSS, print output, or PDF export.
   ========================================================= */

/* ---------------------------------------------------------
   LEVEL CONFIG
   One config object per level drives class options, which
   subjects are pulled, the 4 sub-columns shown per subject, and
   the labels for the overall rollup columns. Everything else in
   this file reads from whichever config is currently selected —
   no level-specific logic is duplicated outside computeClassSummaryRows()
   and the two small per-level cell renderers.
   --------------------------------------------------------- */
const CLASS_SUMMARY_LEVELS = {
    'O-Level': {
        classes: ['S.1', 'S.2', 'S.3', 'S.4'],
        subjects: oLevelSubjects,
        subCols: ['AO1', 'AO2', 'E.O.T', 'Final'],
        totalLabel: 'Total',
        averageLabel: 'Average'
    },
    'A-Level': {
        classes: ['S.5', 'S.6'],
        subjects: aLevelSubjects,
        subCols: ['P1', 'P2', 'Avg', 'Points'],
        totalLabel: 'Total Points',
        averageLabel: 'Avg Mark'
    }
};
// Kept for backwards-compat readability elsewhere in this file (O-Level classes).
const CLASS_SUMMARY_CLASSES = CLASS_SUMMARY_LEVELS['O-Level'].classes;

/* ---------------------------------------------------------
   MODULE MARKUP
   --------------------------------------------------------- */
function renderClassSummariesModule() {
    const t = termSettings;
    const defaultLevel = 'O-Level';
    return `
        <div class="space-y-6">
            <style>${getClassSummaryScreenStyles()}</style>
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
                <div class="flex flex-wrap items-end gap-4">
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Level</label>
                        <select id="css-level-select" onchange="onClassSummaryLevelChange()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-extrabold text-slate-700 focus:ring-1 focus:ring-teal-500">
                            <option value="O-Level" ${defaultLevel === 'O-Level' ? 'selected' : ''}>O-Level (S.1&ndash;S.4)</option>
                            <option value="A-Level" ${defaultLevel === 'A-Level' ? 'selected' : ''}>A-Level (S.5&ndash;S.6)</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1">Class</label>
                        <select id="css-class-select" onchange="onClassSummaryClassChange()" class="p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-extrabold text-slate-700 focus:ring-1 focus:ring-teal-500">
                            ${CLASS_SUMMARY_LEVELS[defaultLevel].classes.map(c => `<option value="${c}">${c}</option>`).join('')}
                        </select>
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
                    <button onclick="loadClassSummaryData()" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-magnifying-glass mr-1.5"></i>View Mark Sheet</button>
                </div>
                <div class="flex gap-2">
                    <button onclick="printClassSummary()" style="background:var(--navy-900);" class="hover:opacity-90 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-print mr-1.5"></i>Print</button>
                    <button onclick="exportClassSummaryPDF()" class="bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider py-2.5 px-4 rounded-xl transition shadow-xs"><i class="fa-solid fa-file-pdf mr-1.5"></i>Export to PDF</button>
                </div>
            </div>
            <p class="text-[11px] font-semibold text-slate-400 -mt-2">General Mark Sheet &mdash; every subject for the selected class and level, side-by-side. O-Level shows AO1, AO2, E.O.T and Final Score per subject; A-Level shows P1, P2, Avg and Points per subject (subsidiary subjects flagged). Marks are pulled live from the current gradebook (there is no separate historical record per term yet) &mdash; Term/Year here label the printed sheet, the same way Report Cards do. Printing / exporting uses Landscape orientation to fit every subject.</p>
            <div id="css-table-empty-state" class="bg-white border border-slate-200 rounded-2xl shadow-xs p-10 text-center text-slate-400 text-xs font-medium">
                Select a level and class, then click &ldquo;View Mark Sheet&rdquo;.
            </div>
            <div id="css-table-wrapper" class="overflow-auto max-h-[70vh] bg-white border border-slate-200 rounded-2xl shadow-xs hidden">
                <table class="w-full text-left gms-matrix-table">
                    <thead id="css-table-head" class="bg-slate-50 text-slate-500 uppercase text-[10px] font-extrabold tracking-wider border-b border-slate-200"></thead>
                    <tbody id="css-table-body" class="divide-y divide-slate-100 text-xs text-slate-700"></tbody>
                </table>
            </div>
        </div>
    `;
}
// Called from switchTab() right after the module markup is injected.
function initClassSummariesModule() {
    // Class dropdown for the default level ("O-Level") is already rendered
    // inline in renderClassSummariesModule() above; this just keeps it in
    // sync defensively (e.g. if this module is ever re-initialized without
    // a full re-render).
    populateClassSummaryClassOptions(getSelectedClassSummaryLevel());
}
function getSelectedClassSummaryLevel() {
    const levelSelect = document.getElementById('css-level-select');
    const level = levelSelect ? levelSelect.value : 'O-Level';
    return CLASS_SUMMARY_LEVELS[level] ? level : 'O-Level';
}
function populateClassSummaryClassOptions(level) {
    const classSelect = document.getElementById('css-class-select');
    if (!classSelect) return;
    const config = CLASS_SUMMARY_LEVELS[level];
    classSelect.innerHTML = config.classes.map(c => `<option value="${c}">${c}</option>`).join('');
}
function onClassSummaryLevelChange() {
    populateClassSummaryClassOptions(getSelectedClassSummaryLevel());
    hideClassSummaryTable();
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
   All grading math is delegated to the existing helpers so this
   module can never compute a different Final Score/Points than
   the Scores or Report Cards tabs do for the same student+subject.
   The overall Total/Average rollups are a pure additive summary on
   top of those same per-subject values — no new grading logic.
   --------------------------------------------------------- */
// O-Level: subjects[subject] = { marks, finalTotal }. Overall = sum/average
// of each subject's Final Score (same convention as the single-subject
// summary this page used to be).
function computeOLevelSummaryRow(student, subjects) {
    const subjectData = {};
    let total = 0;
    let countedSubjects = 0;
    subjects.forEach(subject => {
        const recordKey = `${subject}_${student.id}`;
        // Same rule as buildOLevelRow(): an unrecorded subject is
        // { ao1: null, ao2: null, eot: null } — never defaulted to 0.
        const marks = marksStorage[recordKey] || { ao1: null, ao2: null, eot: null };
        const avScore = calculateAOAverage(marks.ao1, marks.ao2);
        const faScore = (avScore / 3.0) * 20;
        // null (not 0) when E.O.T hasn't been entered yet — matches the
        // exact same "no valid Final mark yet" rule the Scores and Report
        // Cards tabs already enforce.
        const finalTotal = computeOLevelFinalTotal(marks, faScore);
        subjectData[subject] = { marks, finalTotal };
        if (finalTotal !== null) {
            total += finalTotal;
            countedSubjects++;
        }
    });
    const overallTotal = countedSubjects > 0 ? total : null;
    const overallAverage = countedSubjects > 0 ? (total / countedSubjects) : null;
    return { subjects: subjectData, overallTotal, overallAverage };
}
// A-Level: subjects[subject] = { marks, avgMark, grade, descriptor, points,
// isSubsidiary }. Overall = Total Points (the standard UACE-style
// aggregate used to rank A-Level students) plus an Avg Mark rollup, both
// built purely from the same computeALevelAvgMark()/computeALevelGrade()
// the Scores tab and A-Level report card already use.
function computeALevelSummaryRow(student, subjects) {
    const subjectData = {};
    let totalPoints = 0;
    let totalMarks = 0;
    let gradedSubjects = 0;
    subjects.forEach(subject => {
        const recordKey = `${subject}_${student.id}`;
        // Same rule as buildALevelRow(): an unrecorded subject is
        // { p1: null, p2: null } — never defaulted to 0.
        const marks = marksStorage[recordKey] || { p1: null, p2: null };
        const isSubsidiary = subsidiarySubjects.includes(subject);
        const avgMark = computeALevelAvgMark(marks);
        const gradeInfo = computeALevelGrade(avgMark, isSubsidiary);
        subjectData[subject] = { marks, avgMark, isSubsidiary, ...gradeInfo };
        if (avgMark !== null) {
            totalPoints += gradeInfo.points;
            totalMarks += avgMark;
            gradedSubjects++;
        }
    });
    const overallTotal = gradedSubjects > 0 ? totalPoints : null;
    const overallAverage = gradedSubjects > 0 ? (totalMarks / gradedSubjects) : null;
    return { subjects: subjectData, overallTotal, overallAverage };
}
function computeClassSummaryRows(selectedClass, level) {
    const config = CLASS_SUMMARY_LEVELS[level];
    const computeRow = level === 'A-Level' ? computeALevelSummaryRow : computeOLevelSummaryRow;
    return studentsList
        .filter(s => s.class === selectedClass)
        .map(student => {
            const { subjects, overallTotal, overallAverage } = computeRow(student, config.subjects);
            return {
                student,
                subjects,
                overallTotal,
                overallAverage,
                // Named `finalTotal` (not `overallTotal`) so the ranking
                // helpers below stay a single, level-agnostic implementation
                // — they just rank on whichever "overall" number applies
                // (Final-Score total for O-Level, Points total for A-Level).
                finalTotal: overallTotal,
                classPosition: null
            };
        });
}
// Standard "competition ranking" (1, 2, 2, 4, ...): tied overall totals
// share the same position, and the next distinct score skips ahead
// accordingly. Students with no valid graded subject yet are left
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
// awaiting a graded subject, alphabetically — so an empty state never gets
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
    if (!classSelect) return null;
    const level = getSelectedClassSummaryLevel();
    const config = CLASS_SUMMARY_LEVELS[level];
    const selectedClass = classSelect.value;
    let rows = computeClassSummaryRows(selectedClass, level);
    rows = assignClassPositions(rows);
    rows = sortClassSummaryRowsForDisplay(rows);
    return { selectedClass, level, config, subjects: config.subjects, rows };
}

/* ---------------------------------------------------------
   ON-SCREEN TABLE (matrix: every subject side-by-side, with the
   level-appropriate 4 sub-columns under each, plus the overall
   rollup columns). Header spans two rows; styles come from
   getClassSummaryScreenStyles() embedded above in the module
   markup, scoped to .gms-matrix-table only.
   --------------------------------------------------------- */
function subjectHeaderLabel(subject, level) {
    if (level !== 'A-Level') return escapeHTML(subject);
    const isSubsidiary = subsidiarySubjects.includes(subject);
    return `${escapeHTML(formatALevelSubjectDisplayName(subject))}${isSubsidiary ? ' <span class="gms-sub-tag">SUB</span>' : ''}`;
}
function buildClassSummaryTableHead(subjects, level) {
    const config = CLASS_SUMMARY_LEVELS[level];
    return `
        <tr>
            <th class="p-3 gms-sticky-col" rowspan="2">Student Name</th>
            <th class="p-3 text-center" rowspan="2">Position</th>
            ${subjects.map(subj => `<th class="p-2 text-center gms-subject-head" colspan="4">${subjectHeaderLabel(subj, level)}</th>`).join('')}
            <th class="p-3 text-center" rowspan="2">${escapeHTML(config.totalLabel)}</th>
            <th class="p-3 text-center" rowspan="2">${escapeHTML(config.averageLabel)}</th>
        </tr>
        <tr>
            ${subjects.map(() => config.subCols.map(label => `<th class="p-2 text-center gms-sub-head">${escapeHTML(label)}</th>`).join('')).join('')}
        </tr>
    `;
}
function buildOLevelCellsForSubject(s) {
    return `
        <td class="p-2 text-center">${formatAOScoreDisplay(s.marks.ao1, '-')}</td>
        <td class="p-2 text-center">${formatAOScoreDisplay(s.marks.ao2, '-')}</td>
        <td class="p-2 text-center">${formatWholeScoreDisplay(s.marks.eot, '-')}</td>
        <td class="p-2 text-center font-bold">${displayOrDash(s.finalTotal, '-')}</td>
    `;
}
function buildALevelCellsForSubject(s) {
    return `
        <td class="p-2 text-center">${formatWholeScoreDisplay(s.marks.p1, '-')}</td>
        <td class="p-2 text-center">${formatWholeScoreDisplay(s.marks.p2, '-')}</td>
        <td class="p-2 text-center">${displayOrDash(s.avgMark, '-')}</td>
        <td class="p-2 text-center font-bold">${displayOrDash(s.points, '-')}</td>
    `;
}
function buildClassSummaryRowCells(r, subjects, level) {
    const cellBuilder = level === 'A-Level' ? buildALevelCellsForSubject : buildOLevelCellsForSubject;
    return subjects.map(subj => cellBuilder(r.subjects[subj])).join('');
}
function loadClassSummaryData() {
    const data = getSelectedClassSummaryRows();
    const thead = document.getElementById('css-table-head');
    const tbody = document.getElementById('css-table-body');
    const wrapper = document.getElementById('css-table-wrapper');
    const emptyState = document.getElementById('css-table-empty-state');
    if (!data || !tbody || !thead) return;
    if (wrapper) wrapper.classList.remove('hidden');
    if (emptyState) emptyState.classList.add('hidden');

    thead.innerHTML = buildClassSummaryTableHead(data.subjects, data.level);

    if (data.rows.length === 0) {
        const colCount = 4 + (data.subjects.length * 4);
        tbody.innerHTML = `<tr><td colspan="${colCount}" class="p-8 text-center text-slate-400 text-xs font-medium">No students registered in ${escapeHTML(data.selectedClass)} yet. Add them in the Students tab first.</td></tr>`;
        return;
    }
    tbody.innerHTML = data.rows.map(r => `
        <tr class="hover:bg-slate-50 transition">
            <td class="p-3 font-bold text-slate-900 gms-sticky-col">${escapeHTML(r.student.name)}</td>
            <td class="p-3 text-center font-extrabold text-teal-700">${r.classPosition !== null ? ordinalSuffix(r.classPosition) : '-'}</td>
            ${buildClassSummaryRowCells(r, data.subjects, data.level)}
            <td class="p-3 text-center font-extrabold text-slate-800">${displayOrDash(r.overallTotal, '-')}</td>
            <td class="p-3 text-center font-extrabold text-slate-800">${r.overallAverage !== null ? r.overallAverage.toFixed(1) : '-'}</td>
        </tr>
    `).join('');
}
// Scoped purely to .gms-matrix-table / .gms-sticky-col / .gms-sub-tag so
// this can never affect the on-screen look of any other table elsewhere
// in the app.
function getClassSummaryScreenStyles() {
    return `
        .gms-matrix-table { border-collapse: collapse; font-size: 11px; white-space: nowrap; }
        .gms-matrix-table th, .gms-matrix-table td { border: 1px solid #e2e8f0; }
        .gms-subject-head { border-left: 2px solid #cbd5e1 !important; white-space: normal; }
        .gms-sub-head { font-size: 9px; }
        .gms-sticky-col { position: sticky; left: 0; background: inherit; z-index: 1; box-shadow: 1px 0 0 #e2e8f0; }
        thead .gms-sticky-col { background: #f8fafc; }
        .gms-sub-tag { display: inline-block; font-size: 8px; font-weight: 800; background: #fef3c7; color: #92400e; border-radius: 4px; padding: 1px 4px; margin-left: 3px; vertical-align: middle; }
    `;
}

/* ---------------------------------------------------------
   PRINT (Landscape). Deliberately does NOT reuse the shared
   .report-page / .rc-* classes (those are hard-fixed to a single
   210x297mm portrait A4 page with overflow:hidden, tuned for a
   one-page report card). A General Mark Sheet is much wider
   (every subject side-by-side) and can be much taller (many
   students), so it needs its own Landscape, multi-page-capable
   layout. Everything below — including the Landscape @page rule —
   is a self-contained <style> block embedded directly in the
   HTML this function returns, so it only ever exists in the DOM
   for the moment this module's own content occupies #print-area,
   and is fully replaced/discarded whenever any other part of the
   app (e.g. printReportCards()) writes its own content into that
   same shared #print-area. It therefore cannot affect any other
   page's print or PDF-export layout.
   --------------------------------------------------------- */
function getClassSummaryPrintStyles() {
    return `
        @page { size: A4 landscape; margin: 10mm; }
        .gms-print-page { width: 100%; font-family: Arial, Helvetica, sans-serif; color: #111; }
        .gms-print-header { display: flex; align-items: center; gap: 12px; border-bottom: 3px solid #0f172a; padding-bottom: 6px; margin-bottom: 8px; }
        .gms-print-logo { width: 46px; height: 46px; border-radius: 50%; object-fit: cover; border: 2px solid #c9a227; flex-shrink: 0; }
        .gms-print-school { flex: 1; text-align: center; }
        .gms-print-school h1 { font-size: 16px; margin: 0 0 2px; letter-spacing: 0.02em; color: #0f172a; }
        .gms-print-school p { font-size: 8px; margin: 1px 0; color: #333; font-weight: 600; }
        .gms-print-motto { font-style: italic; font-weight: 700; color: #0f766e; }
        .gms-print-title { text-align: center; font-weight: 800; font-size: 12px; letter-spacing: 0.08em; margin: 6px 0; padding: 4px 0; border-top: 1px solid #cbd5e1; border-bottom: 1px solid #cbd5e1; }
        .gms-print-meta-row { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 9px; font-weight: 700; background: #f1f5f9; border-radius: 6px; padding: 6px 10px; margin-bottom: 8px; }
        .gms-print-meta-row span:first-child { color: #64748b; margin-right: 4px; }
        .gms-print-table { width: 100%; border-collapse: collapse; font-size: 7.2px; }
        .gms-print-table th, .gms-print-table td { border: 1px solid #94a3b8; padding: 2.5px 3px; text-align: center; }
        .gms-print-table thead th { background: #0f172a; color: #fff; font-size: 6.6px; text-transform: uppercase; letter-spacing: 0.02em; }
        .gms-print-table .gms-name-col { text-align: left; font-weight: 700; white-space: nowrap; }
        .gms-print-table .gms-final-cell { font-weight: 800; }
        .gms-print-table .gms-total-cell { font-weight: 800; background: #f8fafc; }
        .gms-print-table tbody tr:nth-child(even) { background: #f8fafc; }
        .gms-print-table thead { display: table-header-group; } /* repeat header on every printed page */
        .gms-print-table tr { page-break-inside: avoid; break-inside: avoid; }
        .gms-print-empty { padding: 16px; text-align: center; color: #64748b; font-size: 10px; }
        .gms-print-footer { margin-top: 8px; font-size: 8px; color: #555; }
        .gms-print-sub-tag { font-size: 6px; font-weight: 800; background: #fef3c7; color: #92400e; border-radius: 3px; padding: 0 3px; margin-left: 2px; }
    `;
}
function printSubjectHeaderLabel(subject, level) {
    if (level !== 'A-Level') return escapeHTML(subject);
    const isSubsidiary = subsidiarySubjects.includes(subject);
    return `${escapeHTML(formatALevelSubjectDisplayName(subject))}${isSubsidiary ? ' <span class="gms-print-sub-tag">SUB</span>' : ''}`;
}
function printOLevelCellsForSubject(s) {
    return `
        <td>${formatAOScoreDisplay(s.marks.ao1, '-')}</td>
        <td>${formatAOScoreDisplay(s.marks.ao2, '-')}</td>
        <td>${formatWholeScoreDisplay(s.marks.eot, '-')}</td>
        <td class="gms-final-cell">${displayOrDash(s.finalTotal, '-')}</td>
    `;
}
function printALevelCellsForSubject(s) {
    return `
        <td>${formatWholeScoreDisplay(s.marks.p1, '-')}</td>
        <td>${formatWholeScoreDisplay(s.marks.p2, '-')}</td>
        <td>${displayOrDash(s.avgMark, '-')}</td>
        <td class="gms-final-cell">${displayOrDash(s.points, '-')}</td>
    `;
}
function buildClassSummaryPrintHTML(selectedClass, level, subjects, rows, term, year) {
    const config = CLASS_SUMMARY_LEVELS[level];
    const cellBuilder = level === 'A-Level' ? printALevelCellsForSubject : printOLevelCellsForSubject;
    const colCount = 4 + (subjects.length * 4);
    const rowsHtml = rows.length > 0 ? rows.map(r => `
        <tr>
            <td class="gms-name-col">${escapeHTML(r.student.name)}</td>
            <td>${r.classPosition !== null ? ordinalSuffix(r.classPosition) : '-'}</td>
            ${subjects.map(subj => cellBuilder(r.subjects[subj])).join('')}
            <td class="gms-total-cell">${displayOrDash(r.overallTotal, '-')}</td>
            <td class="gms-total-cell">${r.overallAverage !== null ? r.overallAverage.toFixed(1) : '-'}</td>
        </tr>
    `).join('') : `<tr><td colspan="${colCount}" class="gms-print-empty">No students registered in this class yet.</td></tr>`;

    return `
        <style>${getClassSummaryPrintStyles()}</style>
        <div class="gms-print-page">
            <div class="gms-print-header">
                <img src="school_badge.jpg" class="gms-print-logo" alt="School Badge">
                <div class="gms-print-school">
                    <h1>LUWEERO COMMUNITY SECONDARY SCHOOL</h1>
                    <p>P.O BOX 29540, KAMPALA-UGANDA</p>
                    <p>TEL: 0772620552 / 0782572120 / 0740773771</p>
                    <p class="gms-print-motto">&ldquo;BE KNOWN BY DEEDS&rdquo;</p>
                </div>
            </div>
            <div class="gms-print-title">GENERAL MARK SHEET</div>
            <div class="gms-print-meta-row">
                <div><span>LEVEL:</span>${escapeHTML(level)}</div>
                <div><span>CLASS:</span>${escapeHTML(selectedClass)}</div>
                <div><span>TERM:</span>${escapeHTML(term)}</div>
                <div><span>YEAR:</span>${escapeHTML(String(year))}</div>
                <div><span>SUBJECTS:</span>${subjects.length}</div>
            </div>
            <table class="gms-print-table">
                <thead>
                    <tr>
                        <th rowspan="2" class="gms-name-col">Student Name</th>
                        <th rowspan="2">Pos.</th>
                        ${subjects.map(subj => `<th colspan="4">${printSubjectHeaderLabel(subj, level)}</th>`).join('')}
                        <th rowspan="2">${escapeHTML(config.totalLabel)}</th>
                        <th rowspan="2">${escapeHTML(config.averageLabel)}</th>
                    </tr>
                    <tr>
                        ${subjects.map(() => config.subCols.map(label => `<th>${escapeHTML(label)}</th>`).join('')).join('')}
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
            <p class="gms-print-footer">Printed on ${formatGeneratedTimestamp()} &middot; via Luweero Community SS Management System</p>
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
    printArea.innerHTML = buildClassSummaryPrintHTML(data.selectedClass, data.level, data.subjects, data.rows, term, year);
    // Same "temporarily rename the tab for the Save-as-PDF filename" trick
    // already used by printReportCards() in script.js.
    const suggestedName = `${data.selectedClass}_${data.level}_GeneralMarkSheet_${term.replace(/\s+/g, '')}_${year}`.replace(/[^\w-]/g, '');
    const originalTitle = document.title;
    document.title = suggestedName;
    window.print();
    document.title = originalTitle;
}

/* ---------------------------------------------------------
   EXPORT TO PDF (direct download button, separate from Print).
   Uses html2canvas + jsPDF, loaded via new <script> tags in
   index.html (see the comment there) — purely additive
   dependencies, only used by this module. Landscape A4, and
   (since a General Mark Sheet can be much taller than one page
   once every subject is laid out) the tall source canvas is
   sliced into successive Landscape-A4-height strips, one PDF
   page per strip, instead of being crushed onto a single page.
   --------------------------------------------------------- */
async function exportClassSummaryPDF() {
    const data = getSelectedClassSummaryRows();
    if (!data) return;
    if (typeof html2canvas === 'undefined' || !window.jspdf) {
        alert('PDF export couldn\'t load its required library (no internet connection?). Please use the Print button and choose "Save as PDF" instead.');
        return;
    }
    const { term, year } = getSelectedClassSummaryTermLabel();
    const html = buildClassSummaryPrintHTML(data.selectedClass, data.level, data.subjects, data.rows, term, year);

    // Render off-screen (not display:none — html2canvas needs real layout)
    // so this never touches the visible DOM the user is looking at.
    const holder = document.createElement('div');
    holder.style.position = 'fixed';
    holder.style.top = '0';
    holder.style.left = '-10000px';
    holder.style.width = '1400px'; // wide off-screen canvas so the many subject columns stay readable
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
        const target = holder.querySelector('.gms-print-page');
        const canvas = await html2canvas(target, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('l', 'mm', 'a4'); // Landscape A4
        const pageWidth = 297;
        const pageHeight = 210;
        const imgFullHeight = (canvas.height * pageWidth) / canvas.width; // total mm height if drawn at full width
        const pxPerPage = Math.floor((pageHeight / imgFullHeight) * canvas.height);

        if (imgFullHeight <= pageHeight || pxPerPage <= 0) {
            // Fits on one Landscape page.
            const imgData = canvas.toDataURL('image/png');
            pdf.addImage(imgData, 'PNG', 0, 0, pageWidth, imgFullHeight);
        } else {
            // Slice the tall source canvas into successive full-width,
            // page-height strips — one PDF page per strip — so a long
            // class list is paginated instead of clipped or squashed.
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
                const sliceImgData = sliceCanvas.toDataURL('image/png');
                const sliceHeightMM = (sliceHeightPx * pageWidth) / canvas.width;
                if (pageIndex > 0) pdf.addPage();
                pdf.addImage(sliceImgData, 'PNG', 0, 0, pageWidth, sliceHeightMM);
                renderedPx += sliceHeightPx;
                pageIndex++;
            }
        }

        const fileName = `${data.selectedClass}_${data.level}_GeneralMarkSheet_${term.replace(/\s+/g, '')}_${year}`.replace(/[^\w-]/g, '');
        pdf.save(`${fileName}.pdf`);
    } catch (err) {
        console.error('General Mark Sheet PDF export failed:', err);
        alert('Could not generate the PDF. Please try the Print button instead, then choose "Save as PDF".');
    } finally {
        document.body.removeChild(holder);
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.innerHTML = originalBtnHTML;
        }
    }
}
