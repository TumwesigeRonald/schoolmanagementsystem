/**
 * AI Teacher Toolbox — isolated add-on (see lcs-backend/routes/ai.routes.js
 * + config/aiTools/* for the four tools this drives: lesson_plan,
 * scheme_of_work, activity_of_integration, record_of_work).
 *
 * Only touches the DOM by injecting a sidebar link + rendering into
 * #tab-content, exactly like class-summaries.js. Talks to the backend
 * exclusively through AIToolboxAPI (api.js) so auth headers are attached
 * automatically.
 */

// One entry per backend tool_type. `fields` drives both the form and the
// request params — keys here must match each tool's requiredParams in
// lcs-backend/config/aiTools/*.
// `format` drives both the preview renderer and the Word export layout:
//   'table'    -> structured HTML table(s), exported in LANDSCAPE
//   'scenario' -> narrative sections (no table), exported in PORTRAIT
// `columns` (scheme_of_work only) is the exact, fixed 10-column header the
// backend's AI prompt (config/aiTools/schemeOfWork.js) must return rows for.
const SCHEME_COLUMNS = [
    "WEEK", "PERIODS", "THEME", "CHAPTER", "COMPETENCY", "LEARNING OUTCOMES",
    "TEACHING RESOURCES", "METHODOLOGY", "REFERENCE", "REMARKS"
];
// Maps each fixed column header -> the camelCase key the backend must use
// per row object (content.weeks[i][key]). Keep in sync with SCHEME_COLUMNS.
const SCHEME_COLUMN_KEYS = {
    WEEK: "week", PERIODS: "periods", THEME: "theme", CHAPTER: "chapter",
    COMPETENCY: "competency", "LEARNING OUTCOMES": "learningOutcomes",
    "TEACHING RESOURCES": "teachingResources", METHODOLOGY: "methodology",
    REFERENCE: "reference", REMARKS: "remarks"
};

const TOOLBOX_TOOLS = {
    lesson_plan: {
        label: "NCDC Lesson Plan",
        format: "table",
        fields: [
            { key: "class", label: "Class", type: "select", options: ["Senior One", "Senior Two", "Senior Three", "Senior Four", "Senior Five", "Senior Six"] },
            { key: "subject", label: "Subject", type: "text", placeholder: "e.g. Information and Communication Technology" },
            { key: "topic", label: "Topic", type: "text" },
            { key: "subtopic", label: "Sub-topic", type: "text" },
            { key: "duration", label: "Lesson duration (minutes)", type: "text", placeholder: "e.g. 40" },
            { key: "term", label: "Term", type: "select", options: ["Term 1", "Term 2", "Term 3"] },
            { key: "year", label: "Year", type: "text", placeholder: "e.g. 2026" }
        ]
    },
    scheme_of_work: {
        label: "Scheme of Work",
        format: "table",
        columns: SCHEME_COLUMNS,
        fields: [
            { key: "class", label: "Class", type: "select", options: ["Senior One", "Senior Two", "Senior Three", "Senior Four", "Senior Five", "Senior Six"] },
            { key: "subject", label: "Subject", type: "text" },
            { key: "term", label: "Term", type: "select", options: ["Term 1", "Term 2", "Term 3"] },
            { key: "year", label: "Year", type: "text", placeholder: "e.g. 2026" },
            { key: "weeksInTerm", label: "Teaching weeks this term", type: "text", placeholder: "e.g. 13" }
        ]
    },
    activity_of_integration: {
        label: "Activity of Integration & CAI",
        format: "scenario",
        fields: [
            { key: "class", label: "Class", type: "select", options: ["Senior One", "Senior Two", "Senior Three", "Senior Four", "Senior Five", "Senior Six"] },
            { key: "subject", label: "Subject", type: "text" },
            { key: "term", label: "Term", type: "select", options: ["Term 1", "Term 2", "Term 3"] },
            { key: "year", label: "Year", type: "text", placeholder: "e.g. 2026" },
            { key: "topicsCovered", label: "Topics/outcomes to integrate", type: "textarea" }
        ]
    },
    record_of_work: {
        label: "Record of Work",
        format: "table",
        fields: [
            { key: "class", label: "Class", type: "select", options: ["Senior One", "Senior Two", "Senior Three", "Senior Four", "Senior Five", "Senior Six"] },
            { key: "subject", label: "Subject", type: "text" },
            { key: "term", label: "Term", type: "select", options: ["Term 1", "Term 2", "Term 3"] },
            { key: "year", label: "Year", type: "text", placeholder: "e.g. 2026" },
            { key: "coveredSummary", label: "Rough notes on what was actually taught", type: "textarea" }
        ]
    }
};

// Set by handleAIGenerate; read by exportToolboxToWord so the export
// button doesn't need to re-request the AI or re-serialize form fields.
let lastGenerated = null;

const escHtml = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const toLabel = (key) => key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());

const observer = new MutationObserver(injectTeacherToolbox);
observer.observe(document.body, { childList: true, subtree: true });
document.addEventListener("DOMContentLoaded", injectTeacherToolbox);
window.addEventListener("load", injectTeacherToolbox);

function injectTeacherToolbox() {
    // Teacher/Administrator only — mirrors the backend's requireRole('Teacher', 'Administrator').
    if (typeof currentUser === "undefined" || !["Teacher", "Administrator"].includes(currentUser.role)) return;

    const sidebarNav = document.getElementById('sidebar-nav');
    if (!sidebarNav || document.getElementById('sidebar-toolbox-link')) return;

    const link = document.createElement('a');
    link.id = 'sidebar-toolbox-link';
    link.href = "#toolbox";
    link.className = "flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-blue-50 hover:text-blue-600 rounded-xl font-medium transition text-sm";
    link.innerHTML = `<i class="fa-solid fa-toolbox w-5"></i> Teacher Toolbox`;
    link.onclick = (e) => {
        e.preventDefault();
        const pageTitle = document.getElementById('page-title');
        if (pageTitle) pageTitle.textContent = "Teacher Toolbox";
        renderToolboxUI(document.getElementById('tab-content'));
        const sidebar = document.getElementById('sidebar');
        const backdrop = document.getElementById('sidebar-backdrop');
        if (sidebar) sidebar.classList.add('-translate-x-full');
        if (backdrop) backdrop.classList.add('hidden');
    };
    sidebarNav.appendChild(link);
}

function renderToolboxUI(container) {
    if (!container) return;
    const toolOptions = Object.entries(TOOLBOX_TOOLS)
        .map(([value, tool]) => `<option value="${value}">${tool.label}</option>`).join('');

    container.innerHTML = `
        <div class="space-y-6 max-w-7xl mx-auto py-2">
            <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h2 class="text-2xl font-bold text-slate-800 flex items-center gap-2">
                        <i class="fa-solid fa-toolbox text-blue-600"></i> Teacher Toolbox
                    </h2>
                    <p class="text-slate-500 text-sm mt-1">Generate NCDC-aligned lesson plans, schemes of work, and teaching aids instantly.</p>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="switchToolTab('generator')" id="btn-tab-generator" class="px-4 py-2 text-sm font-semibold rounded-xl bg-blue-600 text-white shadow-sm transition">Generate</button>
                    <button onclick="switchToolTab('saved')" id="btn-tab-saved" class="px-4 py-2 text-sm font-semibold rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 transition">Saved Items</button>
                </div>
            </div>

            <div id="toolbox-view-generator" class="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div class="lg:col-span-5 bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                    <h3 class="text-lg font-semibold text-slate-800 border-b pb-3">Tool Parameters</h3>
                    <div>
                        <label class="block text-xs font-bold uppercase text-slate-500 mb-1">Teacher Name <span class="normal-case font-normal text-slate-400">(printed on the exported Word doc)</span></label>
                        <input type="text" id="ai-teacher-name" placeholder="e.g. Tumwesige Ronald" value="${escHtml((typeof currentUser !== 'undefined' && (currentUser.fullName || currentUser.name)) || '')}" class="w-full rounded-xl border border-slate-300 p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                    </div>
                    <div>
                        <label class="block text-xs font-bold uppercase text-slate-500 mb-1">Select Tool</label>
                        <select id="ai-tool-type" onchange="renderToolboxFields()" class="w-full rounded-xl border border-slate-300 p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                            ${toolOptions}
                        </select>
                    </div>
                    <div id="ai-tool-fields" class="space-y-4"></div>
                    <button onclick="handleAIGenerate()" id="ai-generate-btn" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 rounded-xl shadow transition flex items-center justify-center gap-2">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> Generate Content
                    </button>
                </div>

                <div class="lg:col-span-7 bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col">
                    <h3 class="text-lg font-semibold text-slate-800 border-b pb-3 mb-4">Preview</h3>
                    <div id="ai-preview-container" class="flex-1 bg-slate-50 rounded-xl border border-dashed border-slate-300 p-6 flex flex-col items-center justify-center text-slate-400 min-h-[400px]">
                        <i class="fa-solid fa-file-lines text-4xl mb-3 text-slate-300"></i>
                        <p class="text-sm">Fill in the parameters on the left and click generate. Content is saved to your records automatically.</p>
                    </div>
                </div>
            </div>

            <div id="toolbox-view-saved" class="hidden bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                <h3 class="text-lg font-semibold text-slate-800 mb-4">Saved Teacher Records</h3>
                <div id="saved-items-list" class="space-y-3"><p class="text-sm text-slate-500">Loading saved items...</p></div>
            </div>
        </div>
    `;
    renderToolboxFields();
}

function renderToolboxFields() {
    const toolType = document.getElementById('ai-tool-type').value;
    const fieldsContainer = document.getElementById('ai-tool-fields');
    const tool = TOOLBOX_TOOLS[toolType];

    fieldsContainer.innerHTML = tool.fields.map(f => {
        const id = `ai-field-${f.key}`;
        if (f.type === 'select') {
            return `<div><label class="block text-xs font-bold uppercase text-slate-500 mb-1">${f.label}</label>
                <select id="${id}" class="w-full rounded-xl border border-slate-300 p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                    ${f.options.map(o => `<option value="${o}">${o}</option>`).join('')}
                </select></div>`;
        }
        if (f.type === 'textarea') {
            return `<div><label class="block text-xs font-bold uppercase text-slate-500 mb-1">${f.label}</label>
                <textarea id="${id}" rows="3" placeholder="${f.placeholder || ''}" class="w-full rounded-xl border border-slate-300 p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none"></textarea></div>`;
        }
        return `<div><label class="block text-xs font-bold uppercase text-slate-500 mb-1">${f.label}</label>
            <input type="text" id="${id}" placeholder="${f.placeholder || ''}" class="w-full rounded-xl border border-slate-300 p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none"></div>`;
    }).join('');
}

function switchToolTab(tab) {
    const genView = document.getElementById('toolbox-view-generator');
    const savedView = document.getElementById('toolbox-view-saved');
    const btnGen = document.getElementById('btn-tab-generator');
    const btnSaved = document.getElementById('btn-tab-saved');
    const active = 'px-4 py-2 text-sm font-semibold rounded-xl bg-blue-600 text-white shadow-sm transition';
    const inactive = 'px-4 py-2 text-sm font-semibold rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 transition';

    if (tab === 'generator') {
        genView.classList.remove('hidden');
        savedView.classList.add('hidden');
        btnGen.className = active;
        btnSaved.className = inactive;
    } else {
        genView.classList.add('hidden');
        savedView.classList.remove('hidden');
        btnSaved.className = active;
        btnGen.className = inactive;
        loadSavedToolItems();
    }
}

async function handleAIGenerate() {
    const toolType = document.getElementById('ai-tool-type').value;
    const tool = TOOLBOX_TOOLS[toolType];
    const previewContainer = document.getElementById('ai-preview-container');
    const generateBtn = document.getElementById('ai-generate-btn');

    const params = {};
    for (const f of tool.fields) {
        params[f.key] = document.getElementById(`ai-field-${f.key}`).value.trim();
    }
    const missing = tool.fields.filter(f => !params[f.key]).map(f => f.label);
    if (missing.length) {
        alert(`Please fill in: ${missing.join(', ')}`);
        return;
    }

    generateBtn.disabled = true;
    generateBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Generating...`;
    previewContainer.className = 'flex-1 bg-white rounded-xl border border-slate-200 p-6 flex items-center justify-center text-slate-500 min-h-[400px]';
    previewContainer.innerHTML = `<div class="text-center space-y-3">
        <i class="fa-solid fa-circle-notch fa-spin text-3xl text-blue-600"></i>
        <p class="text-sm font-medium text-slate-600">Generating your ${tool.label.toLowerCase()}...</p>
    </div>`;

    try {
        const saved = await AIToolboxAPI.generate(toolType, params, true);
        lastGenerated = { toolType, params, content: saved.content };
        previewContainer.className = 'flex-1 bg-white rounded-xl border border-slate-200 p-4 overflow-y-auto max-h-[600px]';
        previewContainer.innerHTML = renderPreviewWrapper(toolType, saved.content);
    } catch (err) {
        previewContainer.className = 'flex-1 bg-white rounded-xl border border-slate-200 p-6 flex items-center justify-center min-h-[400px]';
        previewContainer.innerHTML = `<p class="text-red-500 text-sm">Error: ${err.message}</p>`;
    } finally {
        generateBtn.disabled = false;
        generateBtn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Content`;
    }
}

// Preview wrapper: adds the Export-to-Word action above whichever layout
// renderToolContent() produces for this tool.
function renderPreviewWrapper(toolType, content) {
    return `
        <div class="flex justify-end mb-3">
            <button onclick="exportToolboxToWord()" class="px-4 py-2 text-sm font-semibold rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition flex items-center gap-2">
                <i class="fa-solid fa-file-word"></i> Export to Word
            </button>
        </div>
        ${renderToolContent(toolType, content)}
    `;
}

// Dispatches to the correct layout for this tool's `format`.
// - 'scenario' (Activity of Integration & CAI): narrative sections, no table.
// - 'table', scheme_of_work specifically: fixed 10-column matrix.
// - 'table', everything else (lesson_plan, record_of_work): generic
//   key/value + sub-array tables, since their AI schemas vary more.
function renderToolContent(toolType, content) {
    const tool = TOOLBOX_TOOLS[toolType];
    if (tool.format === 'scenario') return renderScenarioContent(content);
    if (toolType === 'scheme_of_work') return renderSchemeOfWorkTable(content);
    return renderGenericTable(content);
}

// Scheme of Work: exact 10-column table (WEEK ... REMARKS). Web preview is
// wrapped in a horizontally-scrolling, min-width container so the wide
// table stays legible ("landscape" behaviour in-browser); the real
// landscape page orientation is set on the exported .doc itself.
function renderSchemeOfWorkTable(content) {
    const rows = Array.isArray(content) ? content : (content.weeks || content.rows || []);
    const head = SCHEME_COLUMNS.map(c => `<th>${c}</th>`).join('');
    const body = rows.map(row => `<tr>${
        SCHEME_COLUMNS.map(col => `<td>${escHtml(row[SCHEME_COLUMN_KEYS[col]] ?? '')}</td>`).join('')
    }</tr>`).join('');
    return `
        <div class="overflow-x-auto -mx-2 px-2">
            <table class="toolbox-table min-w-[1300px] w-full text-xs border-collapse">
                <thead><tr>${head}</tr></thead>
                <tbody>${body}</tbody>
            </table>
        </div>`;
}

// Lesson Plan / Record of Work: flat fields (including array-of-strings,
// rendered as a bullet list) become a Field/Value table; any
// array-of-objects field (e.g. lessonPlan's "lessonFlow", recordOfWork's
// "entries") becomes its own sub-table with columns derived from that
// array's own keys.
function renderGenericTable(content) {
    const isArrayOfObjects = (v) => Array.isArray(v) && v.length && typeof v[0] === 'object';
    const scalarEntries = Object.entries(content).filter(([, v]) => !isArrayOfObjects(v));
    const arrayEntries = Object.entries(content).filter(([, v]) => isArrayOfObjects(v));

    const scalarValueHtml = (v) => Array.isArray(v)
        ? `<ul class="list-disc list-inside space-y-1">${v.map(item => `<li>${escHtml(item)}</li>`).join('')}</ul>`
        : escHtml(v);

    let html = '';
    if (scalarEntries.length) {
        html += `<table class="toolbox-table w-full text-sm border-collapse mb-4">
            <tbody>${scalarEntries.map(([k, v]) => `
                <tr><th class="text-left w-1/3">${toLabel(k)}</th><td>${scalarValueHtml(v)}</td></tr>
            `).join('')}</tbody>
        </table>`;
    }
    arrayEntries.forEach(([key, rows]) => {
        const cols = Object.keys(rows[0]);
        html += `<h4 class="font-semibold text-slate-700 text-sm mb-2 mt-4">${toLabel(key)}</h4>
            <table class="toolbox-table w-full text-xs border-collapse mb-4">
                <thead><tr>${cols.map(c => `<th>${toLabel(c)}</th>`).join('')}</tr></thead>
                <tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${escHtml(r[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
            </table>`;
    });
    return `<div>${html}</div>`;
}

// Activity of Integration & CAI: descriptive scenario layout, no top-level
// table — backend content shape (config/aiTools/activityOfIntegration.js):
// { scenario, taskInstructions: string[], integratedOutcomes: string[],
//   rubric: [{ criterion, basic, moderate, outstanding }] }.
function renderScenarioContent(content) {
    const section = (title, bodyHtml) => {
        if (!bodyHtml) return '';
        return `<div class="scenario-section mb-4">
            <h4 class="font-semibold text-blue-800 text-sm uppercase tracking-wide mb-1">${title}</h4>
            <div class="text-sm text-slate-700 leading-relaxed">${bodyHtml}</div>
        </div>`;
    };
    const textOrList = (val) => {
        if (val === undefined || val === null || val === '') return '';
        return Array.isArray(val)
            ? `<ul class="list-disc list-inside space-y-1">${val.map(v => `<li>${escHtml(v)}</li>`).join('')}</ul>`
            : `<p>${escHtml(val)}</p>`;
    };
    const rubricTable = (rows) => {
        if (!Array.isArray(rows) || !rows.length) return '';
        return `<table class="toolbox-table w-full text-xs border-collapse">
            <thead><tr><th>Criterion</th><th>Basic</th><th>Moderate</th><th>Outstanding</th></tr></thead>
            <tbody>${rows.map(r => `<tr>
                <td>${escHtml(r.criterion)}</td><td>${escHtml(r.basic)}</td>
                <td>${escHtml(r.moderate)}</td><td>${escHtml(r.outstanding)}</td>
            </tr>`).join('')}</tbody>
        </table>`;
    };
    return `<div class="scenario-layout">
        ${section('Scenario / Context', textOrList(content.scenario))}
        ${section('Task Description', textOrList(content.taskInstructions))}
        ${section('Competencies Assessed', textOrList(content.integratedOutcomes))}
        ${section('Scoring / Rubric Guidelines', rubricTable(content.rubric))}
    </div>`;
}

// Builds and downloads a .doc (MS Word HTML format) with the official
// school header + the same table/scenario layout as the preview. Word
// orientation is controlled purely via the @page CSS below — 'table'
// tools open landscape (needed for the 10-column scheme), 'scenario'
// tools open portrait.
function exportToolboxToWord() {
    if (!lastGenerated) return;
    const { toolType, params, content } = lastGenerated;
    const tool = TOOLBOX_TOOLS[toolType];
    const orientation = tool.format === 'scenario' ? 'portrait' : 'landscape';
    const pageSize = orientation === 'landscape' ? '842.0pt 595.0pt' : '595.0pt 842.0pt';
    const nameInput = document.getElementById('ai-teacher-name');
    const teacherName = (nameInput && nameInput.value.trim())
        || (typeof currentUser !== 'undefined' && (currentUser.fullName || currentUser.name))
        || 'Tumwesige Ronald';

    const headerHtml = `
        <div style="text-align:center; margin-bottom:16pt;">
            <h2 style="margin:0;">LUWEERO COMMUNITY SECONDARY SCHOOL</h2>
            <p style="margin:2pt 0 12pt; font-weight:bold; text-transform:uppercase;">${escHtml(tool.label)}</p>
        </div>
        <table style="width:100%; border:none; margin-bottom:14pt; font-size:11pt;">
            <tr>
                <td style="border:none;"><strong>Class:</strong> ${escHtml(params.class || '')}</td>
                <td style="border:none;"><strong>Term:</strong> ${escHtml(params.term || '')}</td>
                <td style="border:none;"><strong>Year:</strong> ${escHtml(params.year || '')}</td>
            </tr>
            <tr>
                <td style="border:none;"><strong>Teacher Name:</strong> ${escHtml(teacherName)}</td>
                <td colspan="2" style="border:none;"><strong>Subject:</strong> ${escHtml(params.subject || '')}</td>
            </tr>
        </table>`;

    const bodyHtml = renderToolContent(toolType, content);

    const docHtml = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head>
<meta charset="utf-8">
<title>${escHtml(tool.label)}</title>
<!--[if gte mso 9]><xml>
<w:WordDocument><w:View>Print</w:View><w:Zoom>90</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument>
</xml><![endif]-->
<style>
@page Section1 { size: ${pageSize}; mso-page-orientation: ${orientation}; margin: 1.5cm 1.2cm; }
div.Section1 { page: Section1; }
body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; }
table.toolbox-table { border-collapse: collapse; width: 100%; margin-bottom: 10pt; }
table.toolbox-table th, table.toolbox-table td { border: 1px solid #333; padding: 6pt; font-size: 10pt; vertical-align: top; }
table.toolbox-table th { background: #dbeafe; font-weight: bold; text-align: left; }
h4 { margin: 10pt 0 4pt; }
</style>
</head>
<body>
<div class="Section1">${headerHtml}${bodyHtml}</div>
</body>
</html>`;

    const blob = new Blob(['\ufeff', docHtml], { type: 'application/msword' });
    const safe = (s) => String(s || '').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
    const filename = `${safe(tool.label)}_${safe(params.class)}_${safe(params.term)}.doc`;

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

async function loadSavedToolItems() {
    const listContainer = document.getElementById('saved-items-list');
    try {
        const items = await AIToolboxAPI.list();
        if (!items.length) {
            listContainer.innerHTML = `<p class="text-sm text-slate-400">No saved records found.</p>`;
            return;
        }
        listContainer.innerHTML = items.map(item => `
            <div class="p-4 rounded-xl border border-slate-200 bg-slate-50 flex justify-between items-center">
                <div>
                    <span class="text-xs font-bold px-2.5 py-1 bg-blue-100 text-blue-700 rounded-full">${TOOLBOX_TOOLS[item.toolType]?.label || item.toolType}</span>
                    <h4 class="text-sm font-semibold text-slate-800 mt-1">${item.title}</h4>
                    <p class="text-xs text-slate-500 mt-0.5">${item.class || ''} ${item.subject ? '· ' + item.subject : ''} · ${new Date(item.createdAt).toLocaleDateString()}</p>
                </div>
                <button onclick="deleteSavedItem('${item.id}')" class="text-red-500 hover:text-red-700 p-2 text-sm"><i class="fa-solid fa-trash"></i></button>
            </div>
        `).join('');
    } catch (err) {
        listContainer.innerHTML = `<p class="text-sm text-red-500">Could not load saved items: ${err.message}</p>`;
    }
}

async function deleteSavedItem(id) {
    if (!confirm('Are you sure you want to delete this record?')) return;
    try {
        await AIToolboxAPI.remove(id);
        loadSavedToolItems();
    } catch (err) {
        alert(`Failed to delete item: ${err.message}`);
    }
}
