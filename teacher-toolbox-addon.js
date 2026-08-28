/**
 * Teacher Toolbox Addon for Luweero Community Secondary School Portal
 * Developed by Tumwesige Ronald
 */

document.addEventListener("DOMContentLoaded", () => {
    setTimeout(initTeacherToolboxModule, 600);
});

function initTeacherToolboxModule() {
    const userRoleTag = document.getElementById('user-role-tag');
    const roleText = userRoleTag ? userRoleTag.textContent.toLowerCase() : '';
    
    const isAuthorized = roleText.includes('teacher') || roleText.includes('admin') || 
                         window.currentUser?.role === 'teacher' || window.currentUser?.role === 'admin';

    if (!isAuthorized) return;

    const sidebarNav = document.getElementById('sidebar-nav');
    if (sidebarNav) {
        // Prevent duplicate injection if it already exists
        if (document.getElementById('sidebar-toolbox-link')) return;

        const toolboxLink = document.createElement('a');
        toolboxLink.id = 'sidebar-toolbox-link';
        toolboxLink.href = "#toolbox";
        toolboxLink.className = "flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-blue-50 hover:text-blue-600 rounded-xl font-medium transition text-sm";
        toolboxLink.innerHTML = `<i class="fa-solid fa-toolbox w-5"></i> Teacher Toolbox`;
        toolboxLink.onclick = (e) => {
            e.preventDefault();
            const pageTitle = document.getElementById('page-title');
            if (pageTitle) pageTitle.textContent = "AI Teacher Toolbox";
            
            renderTeacherToolboxUI(document.getElementById('tab-content'));
            
            const sidebar = document.getElementById('sidebar');
            const backdrop = document.getElementById('sidebar-backdrop');
            if (sidebar) sidebar.classList.add('-translate-x-full');
            if (backdrop) backdrop.classList.add('hidden');
        };
        sidebarNav.appendChild(toolboxLink);
    }
}

function renderTeacherToolboxUI(container) {
    if (!container) return;
    container.innerHTML = `
        <div class="space-y-6 max-w-7xl mx-auto py-2">
            <!-- Header Section -->
            <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h2 class="text-2xl font-bold text-slate-800 flex items-center gap-2">
                        <i class="fa-solid fa-toolbox text-blue-600"></i> AI Teacher Toolbox
                    </h2>
                    <p class="text-slate-500 text-sm mt-1">Generate NCDC-aligned lesson plans, schemes of work, and teaching aids instantly.</p>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="switchToolTab('generator')" id="btn-tab-generator" class="px-4 py-2 text-sm font-semibold rounded-xl bg-blue-600 text-white shadow-sm transition">Generate Content</button>
                    <button onclick="switchToolTab('saved')" id="btn-tab-saved" class="px-4 py-2 text-sm font-semibold rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 transition">Saved Items</button>
                </div>
            </div>

            <!-- Generator Workspace View -->
            <div id="toolbox-view-generator" class="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <!-- Input Control Form -->
                <div class="lg:col-span-5 bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                    <h3 class="text-lg font-semibold text-slate-800 border-b pb-3">Tool Parameters</h3>
                    
                    <div>
                        <label class="block text-xs font-bold uppercase text-slate-500 mb-1">Select Tool Type</label>
                        <select id="ai-tool-type" class="w-full rounded-xl border border-slate-300 p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                            <option value="ncdc_lesson_plan">NCDC-Aligned Lesson Plan</option>
                            <option value="scheme_of_work">Scheme of Work Expander</option>
                            <option value="exam_revision">Exam Revision Questions</option>
                        </select>
                    </div>

                    <div>
                        <label class="block text-xs font-bold uppercase text-slate-500 mb-1">Subject</label>
                        <input type="text" id="ai-subject" placeholder="e.g. Information and Communication Technology" class="w-full rounded-xl border border-slate-300 p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                    </div>

                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-xs font-bold uppercase text-slate-500 mb-1">Class Level</label>
                            <select id="ai-class-level" class="w-full rounded-xl border border-slate-300 p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                                <option value="Senior One">Senior One</option>
                                <option value="Senior Two">Senior Two</option>
                                <option value="Senior Three">Senior Three</option>
                                <option value="Senior Four">Senior Four</option>
                                <option value="Senior Five">Senior Five</option>
                                <option value="Senior Six">Senior Six</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-xs font-bold uppercase text-slate-500 mb-1">Term</label>
                            <select id="ai-term" class="w-full rounded-xl border border-slate-300 p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                                <option value="Term 1">Term 1</option>
                                <option value="Term 2">Term 2</option>
                                <option value="Term 3">Term 3</option>
                            </select>
                        </div>
                    </div>

                    <div>
                        <label class="block text-xs font-bold uppercase text-slate-500 mb-1">Topic / Specific Objective</label>
                        <textarea id="ai-topic" rows="3" placeholder="e.g. Introduction to Word Processing formatting tools..." class="w-full rounded-xl border border-slate-300 p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none"></textarea>
                    </div>

                    <button onclick="handleAIGenerate()" id="ai-generate-btn" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 rounded-xl shadow transition flex items-center justify-center gap-2">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> Generate Content
                    </button>
                </div>

                <!-- Preview and Edit Workspace -->
                <div class="lg:col-span-7 bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col">
                    <div class="flex justify-between items-center border-b pb-3 mb-4">
                        <h3 class="text-lg font-semibold text-slate-800">Preview & Edit Workspace</h3>
                        <div id="workspace-actions" class="hidden flex gap-2">
                            <button onclick="saveAIToolItem()" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg shadow transition">
                                <i class="fa-solid fa-floppy-disk"></i> Save to Records
                            </button>
                        </div>
                    </div>

                    <div id="ai-preview-container" class="flex-1 bg-slate-50 rounded-xl border border-dashed border-slate-300 p-6 flex flex-col items-center justify-center text-slate-400 min-h-[400px]">
                        <i class="fa-solid fa-file-lines text-4xl mb-3 text-slate-300"></i>
                        <p class="text-sm">Configure your parameters on the left and click generate to review content here before saving.</p>
                    </div>
                </div>
            </div>

            <!-- Saved Items View (Hidden by default) -->
            <div id="toolbox-view-saved" class="hidden bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                <h3 class="text-lg font-semibold text-slate-800 mb-4">Saved Teacher Records</h3>
                <div id="saved-items-list" class="space-y-3">
                    <p class="text-sm text-slate-500">Loading saved items...</p>
                </div>
            </div>
        </div>
    `;
}

function switchToolTab(tab) {
    const genView = document.getElementById('toolbox-view-generator');
    const savedView = document.getElementById('toolbox-view-saved');
    const btnGen = document.getElementById('btn-tab-generator');
    const btnSaved = document.getElementById('btn-tab-saved');

    if (tab === 'generator') {
        genView.classList.remove('hidden');
        savedView.classList.add('hidden');
        btnGen.className = 'px-4 py-2 text-sm font-semibold rounded-xl bg-blue-600 text-white shadow-sm transition';
        btnSaved.className = 'px-4 py-2 text-sm font-semibold rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 transition';
    } else {
        genView.classList.add('hidden');
        savedView.classList.remove('hidden');
        btnSaved.className = 'px-4 py-2 text-sm font-semibold rounded-xl bg-blue-600 text-white shadow-sm transition';
        btnGen.className = 'px-4 py-2 text-sm font-semibold rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 transition';
        loadSavedToolItems();
    }
}

async function handleAIGenerate() {
    const toolType = document.getElementById('ai-tool-type').value;
    const subject = document.getElementById('ai-subject').value;
    const classLevel = document.getElementById('ai-class-level').value;
    const term = document.getElementById('ai-term').value;
    const topic = document.getElementById('ai-topic').value;
    const previewContainer = document.getElementById('ai-preview-container');
    const workspaceActions = document.getElementById('workspace-actions');
    const generateBtn = document.getElementById('ai-generate-btn');

    if (!subject || !topic) {
        alert('Please fill out both the subject and topic fields.');
        return;
    }

    generateBtn.disabled = true;
    generateBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Generating...`;
    previewContainer.className = 'flex-1 bg-white rounded-xl border border-slate-200 p-6 flex flex-col items-center justify-center text-slate-500 min-h-[400px]';
    previewContainer.innerHTML = `
        <div class="text-center space-y-3">
            <i class="fa-solid fa-circle-notch fa-spin text-3xl text-blue-600"></i>
            <p class="text-sm font-medium text-slate-600">Synthesizing NCDC curriculum parameters...</p>
        </div>
    `;

    try {
        const response = await fetch('/api/ai/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toolType, subject, classLevel, term, topic })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Failed to generate content');

        previewContainer.className = 'flex-1 bg-white rounded-xl border border-slate-200 p-4 overflow-y-auto max-h-[500px]';
        previewContainer.innerHTML = `
            <textarea id="ai-generated-content-editable" class="w-full h-full min-h-[380px] p-3 text-sm text-slate-700 bg-slate-50 rounded-lg border border-slate-200 focus:bg-white focus:ring-2 focus:ring-blue-500 outline-none">${data.content || data.result}</textarea>
        `;
        workspaceActions.classList.remove('hidden');
    } catch (err) {
        previewContainer.innerHTML = `<p class="text-red-500 text-sm">Error: ${err.message}</p>`;
    } finally {
        generateBtn.disabled = false;
        generateBtn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Content`;
    }
}

async function saveAIToolItem() {
    const content = document.getElementById('ai-generated-content-editable').value;
    const toolType = document.getElementById('ai-tool-type').value;
    const subject = document.getElementById('ai-subject').value;

    try {
        const response = await fetch('/api/ai/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toolType, subject, content })
        });

        if (!response.ok) throw new Error('Failed to persist item.');
        alert('Tool item successfully saved to records!');
    } catch (err) {
        alert(`Error saving item: ${err.message}`);
    }
}

async function loadSavedToolItems() {
    const listContainer = document.getElementById('saved-items-list');
    try {
        const response = await fetch('/api/ai/items');
        const items = await response.json();

        if (!items.length) {
            listContainer.innerHTML = `<p class="text-sm text-slate-400">No saved records found.</p>`;
            return;
        }

        listContainer.innerHTML = items.map(item => `
            <div class="p-4 rounded-xl border border-slate-200 bg-slate-50 flex justify-between items-center">
                <div>
                    <span class="text-xs font-bold px-2.5 py-1 bg-blue-100 text-blue-700 rounded-full">${item.tool_type}</span>
                    <h4 class="text-sm font-semibold text-slate-800 mt-1">${item.subject}</h4>
                    <p class="text-xs text-slate-500 mt-0.5">Created on: ${new Date(item.created_at || Date.now()).toLocaleDateString()}</p>
                </div>
                <button onclick="deleteSavedItem('${item.id}')" class="text-red-500 hover:text-red-700 p-2 text-sm"><i class="fa-solid fa-trash"></i></button>
            </div>
        `).join('');
    } catch (err) {
        listContainer.innerHTML = `<p class="text-sm text-red-500">Could not load saved items.</p>`;
    }
}

async function deleteSavedItem(id) {
    if (!confirm('Are you sure you want to delete this record?')) return;
    try {
        await fetch(`/api/ai/items/${id}`, { method: 'DELETE' });
        loadSavedToolItems();
    } catch (err) {
        alert('Failed to delete item.');
    }
}