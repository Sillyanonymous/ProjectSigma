import * as CoreAPI from './core-api.js';
import { runCommand } from './ext-registry.js';


let isInitialized = false;
let tagCounts = new Map();       // exact tag name -> carrier count
let tagIndexError = null;        // why the last /tags read failed; null once one answered
let activeTab = 'library';
let runInProgress = false;
let runAborted = false;
let showingDupes = false;
let sortMode = 'name';           // 'name' | 'count'

// ========================================
// TAG INDEX
// ========================================

// the tag index IS the server's tags table (names + carrier counts), walked a page at a time, most used first
async function buildTagIndex() {
    try {
        const rows = await CoreAPI.fetchAllPages('/tags', { count: 'false' });
        // a stable sort: the walk's name order stays among equal counts
        rows.sort((a, b) => b.count - a.count);
        tagCounts = new Map(rows.map(r => [r.name, r.count]));
        tagIndexError = null;
    } catch (e) {
        console.error('[TagsManager] tag index load failed:', e);
        // unknown is not empty: the counts stay as last read and every reader of them says the read failed
        tagIndexError = e?.message || 'network error';
    }
}

// A verb that quotes or acts on the counts refuses while they could not be read, and asks again
// so the next press can run
function tagIndexUnread() {
    if (!tagIndexError) return false;
    CoreAPI.showToast('Your tags could not be read; try again', 'error');
    retryTagIndex();
    return true;
}

function retryTagIndex() {
    buildTagIndex().then(() => {
        if (!document.getElementById('tagsManagerModal')?.classList.contains('visible')) return;
        // a field being typed in keeps its text; its blur repaints
        if (fieldBeingTyped()) { _repaintWanted = true; return; }
        switchTab(activeTab);
    });
}

// Groups of tags that differ only by case/whitespace
function findCaseDupeGroups() {
    const groups = new Map();
    for (const [name, count] of tagCounts) {
        const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ name, count });
    }
    const result = [];
    for (const variants of groups.values()) {
        if (variants.length < 2) continue;
        variants.sort((a, b) => b.count - a.count);
        result.push(variants);
    }
    result.sort((a, b) => b[0].count - a[0].count);
    return result;
}

// spacer virtualization so the scrollbar shows the REAL count; onscroll is re-attached in set() since the dupe review nulls it
function makeVirtualList(container, buildRow, { overscan = 12 } = {}) {
    const state = { items: [], rowH: 0, start: -1, end: -1, raf: 0, remeasured: false };
    const top = document.createElement('div');
    const host = document.createElement('div');
    const bottom = document.createElement('div');
    // Spacers must survive a flex-column container, or they shrink to zero and the
    // scrollbar collapses (the rules list was the live case)
    top.style.flexShrink = '0';
    host.style.flexShrink = '0';
    bottom.style.flexShrink = '0';

    const renderWindow = (force) => {
        const n = state.items.length;
        if (n === 0) return;
        if (!state.rowH) {
            host.innerHTML = '';
            host.appendChild(buildRow(state.items[0], 0));
            state.rowH = host.firstElementChild.getBoundingClientRect().height || 36;
        }
        // The modal opens animated, so the first pass can see a near-zero clientHeight;
        // a minimum window keeps the list populated until the ResizeObserver corrects it
        const viewH = Math.max(container.clientHeight, 240);
        const start = Math.max(0, Math.floor(container.scrollTop / state.rowH) - overscan);
        const end = Math.min(n, Math.ceil((container.scrollTop + viewH) / state.rowH) + overscan);
        if (!force && start === state.start && end === state.end) return;
        state.start = start; state.end = end;
        top.style.height = `${start * state.rowH}px`;
        bottom.style.height = `${(n - end) * state.rowH}px`;
        host.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (let i = start; i < end; i++) frag.appendChild(buildRow(state.items[i], i));
        host.appendChild(frag);
        // The probe can measure mid-animation; verify against a real rendered row once
        // and re-run, or spacer math drifts and deep-scroll windows land misaligned
        if (!state.remeasured && host.firstElementChild) {
            const real = host.firstElementChild.getBoundingClientRect().height;
            if (real && Math.abs(real - state.rowH) > 0.5) {
                state.remeasured = true;
                state.rowH = real;
                renderWindow(true);
                return;
            }
            if (real) state.remeasured = true;
        }
    };

    const ro = new ResizeObserver(() => {
        if (state.items.length === 0) return;
        // A focused row input would be destroyed without firing change (removal fires
        // neither blur nor change); flush it so mid-edit text survives the rebuild
        const focused = document.activeElement;
        if (focused && container.contains(focused) && typeof focused.blur === 'function') focused.blur();
        state.remeasured = false;
        renderWindow(true);
    });
    // One live instance per container: renders recreate the virtualizer, and a stale
    // instance's ResizeObserver would repaint old items over the new ones
    container._virtualList?.destroy();
    ro.observe(container);

    const api = {
        set(items) {
            state.items = items || [];
            state.start = -1; state.end = -1; state.remeasured = false;
            container.innerHTML = '';
            container.scrollTop = 0;
            if (state.items.length === 0) return false;   // caller renders its empty state
            container.appendChild(top);
            container.appendChild(host);
            container.appendChild(bottom);
            container.onscroll = () => {
                if (state.raf) return;
                state.raf = requestAnimationFrame(() => { state.raf = 0; renderWindow(false); });
            };
            renderWindow(true);
            return true;
        },
        refresh() { renderWindow(true); },
        destroy() { ro.disconnect(); },
    };
    container._virtualList = api;
    return api;
}

// Trimmed-lower sort keys: exact-form entries like " female" would otherwise sort to the
// top of A-Z, far from "female"; numeric compare keeps tag2 before tag10
const tagCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

// Static strings only; never route third-party text through this without escaping
function emptyStateHtml(icon, title, hint, action) {
    return `<div class="cl-empty-state tgm-empty-state">
        <i class="cl-empty-state-icon fa-solid ${icon}"></i>
        <div class="cl-empty-state-title">${title}</div>
        ${hint ? `<div class="cl-empty-state-hint">${hint}</div>` : ''}
        ${action ? `<button type="button" class="cl-btn cl-btn-primary cl-empty-state-action">${action}</button>` : ''}
    </div>`;
}

// ========================================
// BULK RUNS
// ========================================

// the run journal is server rows (tag_runs): the links a tag op or job moved, the newest run alone kept
async function listRuns() {
    const resp = await CoreAPI.apiRequest('/tag-runs', 'GET');
    if (!resp.ok) throw new Error(`tag runs read failed (${resp.status})`);
    return resp.json();
}

// what one op changed: a rename or remove counts carriers, an apply the characters it changed
const opTouched = (response) => response?.touched ?? response?.affected?.length ?? 0;

async function undoLastRun() {
    if (runInProgress) return;
    let runs;
    try { runs = await listRuns(); } catch { CoreAPI.showToast('Could not read the undo journal', 'error'); return; }
    const run = runs[0];
    if (!run) { CoreAPI.showToast('No bulk run to undo', 'info'); return; }
    // the server puts back the links the run moved, as a job of its own
    const ok = await CoreAPI.showConfirm({
        title: 'Undo last bulk run',
        message: `Revert "${run.label}"?`,
        confirmLabel: 'Revert',
        danger: true,
        content: [
            { type: 'stats', items: [
                { icon: 'fa-solid fa-clock-rotate-left', label: 'reverts', value: `${run.linkCount.toLocaleString()} tag link${run.linkCount === 1 ? '' : 's'}` },
                { icon: 'fa-solid fa-calendar', label: 'from', value: new Date(run.ts).toLocaleString() },
            ] },
            { type: 'note', text: 'The undo itself is journaled, so it can be undone again.' },
        ],
    });
    if (!ok) return;
    await runLinksUndo(run);
}

// an undo is a chunked server job: the bar follows it, Abort stops between chunks, the library re-reads at the end
async function runLinksUndo(run) {
    if (runInProgress) return;
    runInProgress = true;
    runAborted = false;
    setActionsDisabled(true);
    const bar = document.getElementById('tgmProgress');
    const fill = document.getElementById('tgmProgressFill');
    const text = document.getElementById('tgmProgressText');
    const abortBtn = document.getElementById('tgmAbortBtn');
    const label = `Undo: ${run.label}`;
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = `${label}: 0/${run.linkCount.toLocaleString()}`;
    CoreAPI.setRunVerb(abortBtn, 'running');
    bar?.classList.remove('hidden');
    let stopSent = false;
    const off = CoreAPI.onJob((job) => {
        if (job.kind !== 'undo') return;
        if (runAborted && !stopSent && (job.status === 'queued' || job.status === 'running')) {
            stopSent = true;
            void CoreAPI.stopJob(job.id);
        }
        if (fill) fill.style.width = `${job.total ? Math.round((job.done / job.total) * 100) : 100}%`;
        if (text) text.textContent = `${label}: ${job.done.toLocaleString()}/${job.total.toLocaleString()}`;
    });
    let ended = null;
    let failed = null;
    try {
        const data = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/tag-runs/${run.id}/undo`, 'POST'));
        if (!data?.job) throw new Error('the undo answered no job');
        ended = await CoreAPI.followJob(data.job);
        if (ended.status === 'failed') failed = ended.error || 'the undo failed';
    } catch (e) {
        failed = e?.message || 'network error';
    }
    off();
    if (abortBtn) abortBtn.disabled = true;
    if (text) text.textContent = 'Refreshing library...';
    // held: the job moved tags on rows this tab holds without telling them
    await CoreAPI.refreshCharacters(true, { held: true });
    // the names the undo moved back, followed by this tab's live rules as the op's own path does; other tabs hear its records
    for (const { from, to } of ended?.result?.renamed || []) CoreAPI.renameActiveTagFilter(from, to);
    bar?.classList.add('hidden');
    if (fill) fill.style.width = '0%';
    if (abortBtn) abortBtn.disabled = false;
    setActionsDisabled(false);
    runInProgress = false;
    const changed = ended?.result?.changed || 0;
    if (failed) CoreAPI.showToast(`${label} failed: ${failed}`, 'error');
    else if (ended?.status === 'stopped') CoreAPI.showToast(`${label} stopped (${cardCount(changed)} restored before the stop)`, 'warning');
    else CoreAPI.showToast(`${label}: ${cardCount(changed)} restored`, 'success');
    await buildTagIndex();
    rulesImpactCache = null;
    switchTab(activeTab);
    updateUndoButton();
}

function updateUndoButton() {
    const btn = document.getElementById('tgmUndoBtn');
    if (!btn) return;
    listRuns().then(runs => {
        const run = runs[0];
        btn.classList.toggle('hidden', !run);
        if (run) {
            btn.title = `Undo last bulk run: "${run.label}" (${run.linkCount.toLocaleString()} tag links, ${new Date(run.ts).toLocaleString()})`;
        }
    }).catch(() => btn.classList.add('hidden'));
}

function setActionsDisabled(disabled) {
    const modal = document.getElementById('tagsManagerModal');
    modal?.querySelectorAll('button, input').forEach(el => {
        if (el.id === 'tgmAbortBtn' || el.id === 'tgmCloseBtn') return;
        el.disabled = disabled;
    });
}

// ========================================
// OPERATIONS
// ========================================

// relational ops, each one server transaction joining one journaled run; null when not COMPLETE (callers gate remaps)
async function runTagOps(label, ops) {
    if (runInProgress) return null;
    runInProgress = true;
    runAborted = false;
    setActionsDisabled(true);

    // only a multi-op run lives long enough to owe the reader a progress bar
    const bar = document.getElementById('tgmProgress');
    const fill = document.getElementById('tgmProgressFill');
    const text = document.getElementById('tgmProgressText');
    const showBar = ops.length > 1;
    if (showBar && bar) {
        if (fill) fill.style.width = '0%';
        if (text) text.textContent = `${label}: 0/${ops.length}`;
        CoreAPI.setRunVerb(document.getElementById('tgmAbortBtn'), 'running');
        bar.classList.remove('hidden');
    }

    // an apply op runs through tags.apply so a wrapper hears it; rename and remove are their own journaled routes
    let run = { label };
    const runOp = async (op) => {
        if (op.route === 'apply') {
            const answer = await runCommand('tags.apply', { ids: op.body.charIds, add: op.body.add || [], remove: op.body.remove || [] });
            if (!answer) throw new Error('the change was held back');
            return answer;
        }
        const data = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/tags/${op.route}`, 'POST', { ...op.body, run }));
        if (Number.isInteger(data?.runId)) run = { id: data.runId };
        return data;
    };
    const results = [];
    let failed = null;
    try {
        for (let i = 0; i < ops.length; i++) {
            if (runAborted) break;
            const op = ops[i];
            let data;
            try { data = await runOp(op); } catch (e) { failed = e?.message || 'network error'; break; }
            results.push({ ...op, response: data });
            if (showBar) {
                if (fill) fill.style.width = `${Math.round(((i + 1) / ops.length) * 100)}%`;
                if (text) text.textContent = `${label}: ${i + 1}/${ops.length}`;
            }
        }
    } catch (e) {
        failed = e?.message || 'network error';
    }
    // an abort click landing during the refresh below must not make a completed run report as stopped
    const wasAborted = runAborted;
    const abortBtn = document.getElementById('tgmAbortBtn');
    if (abortBtn) abortBtn.disabled = true;

    // what landed is journaled either way, so a run refused midway undoes as far as it got
    if (showBar && text) text.textContent = 'Refreshing library...';
    await CoreAPI.refreshCharacters(true, { held: true });
    await buildTagIndex();
    rulesImpactCache = null;
    if (showBar && bar) {
        bar.classList.add('hidden');
        if (fill) fill.style.width = '0%';
    }
    if (abortBtn) abortBtn.disabled = false;
    setActionsDisabled(false);
    runInProgress = false;
    switchTab(activeTab);
    if (failed) {
        const landed = results.length ? `; the ${results.length.toLocaleString()} that landed are journaled (Undo last run reverts them)` : '';
        CoreAPI.showToast(`${label} failed: ${failed}${landed}`, 'error', results.length ? 8000 : undefined);
        return null;
    }
    const touched = results.reduce((n, r) => n + opTouched(r.response), 0);
    if (wasAborted) {
        CoreAPI.showToast(`${label} stopped: ${results.length}/${ops.length} operations applied, ${cardCount(touched)} updated (Undo reverts them)`, 'warning');
        return null;
    }
    CoreAPI.showToast(`${label}: ${cardCount(touched)} updated`, 'success');
    return results;
}

// SQLite's NOCASE folds ASCII only, so "Café" and "CAFÉ" are two rows there and must read as two here
const nocase = (s) => String(s).replace(/[A-Z]/g, c => c.toLowerCase());

async function renameTag(tag, newNameRaw) {
    const newName = String(newNameRaw ?? '').trim();
    if (!newName || newName === tag) return;
    if (tagIndexUnread()) return;

    const count = tagCounts.get(tag) || 0;
    if (count === 0) { CoreAPI.showToast('No characters carry this tag anymore', 'info'); return; }

    // Renaming onto an existing distinct NOCASE row is a merge and the confirm
    // must say so; the server folds carriers into the existing row's casing.
    const existingTarget = [...tagCounts.keys()].find(t =>
        t !== tag && nocase(t) === nocase(newName));
    const isMerge = !!existingTarget;
    const finalName = isMerge ? existingTarget : newName;

    const stats = [{ icon: 'fa-solid fa-tags', label: 'rewrites', value: cardCount(count) }];
    if (isMerge) stats.push({ icon: 'fa-solid fa-arrow-right-to-bracket', label: 'into', value: `${finalName} (${(tagCounts.get(existingTarget) || 0).toLocaleString()} existing)` });
    const ok = await CoreAPI.showConfirm({
        title: isMerge ? 'Merge tag' : 'Rename tag',
        message: isMerge ? `Merge "${tag}" into "${finalName}"?` : `Rename "${tag}" to "${finalName}"?`,
        danger: true,
        content: [
            { type: 'stats', items: stats },
            { type: 'note', text: 'One relational operation server-side; the toolbar Undo reverts it.' },
        ],
    });
    if (!ok) return;

    const results = await runTagOps(isMerge ? 'Merging' : 'Renaming',
        [{ route: 'rename', body: { from: tag, to: finalName } }]);
    if (results) CoreAPI.renameActiveTagFilter(tag, finalName);
}

async function deleteTag(tag) {
    if (tagIndexUnread()) return;
    const count = tagCounts.get(tag) || 0;
    if (count === 0) { CoreAPI.showToast('No characters carry this tag anymore', 'info'); return; }

    const ok = await CoreAPI.showConfirm({
        title: 'Delete tag',
        message: `Remove "${tag}" from every character that carries it?`,
        danger: true,
        content: [
            { type: 'stats', items: [{ icon: 'fa-solid fa-tags', label: 'carried by', value: cardCount(count) }] },
            { type: 'note', text: 'One relational operation server-side; the toolbar Undo reverts it.' },
        ],
    });
    if (!ok) return;

    const results = await runTagOps('Deleting', [{ route: 'remove', body: { name: tag } }]);
    if (results) CoreAPI.renameActiveTagFilter(tag, null);
}

const cardCount = (n) => `${n.toLocaleString()} ${n === 1 ? 'card' : 'cards'}`;
const tagCount = (n) => `${n.toLocaleString()} ${n === 1 ? 'tag' : 'tags'}`;

// One rule per distinct lowered form covers every case variant (matching is case-insensitive)
function addAliasRulesFor(variants, canonical) {
    const rules = getRules();
    const existing = new Set(rules.map(r => (r.match || '').trim().toLowerCase()).filter(Boolean));
    // store trimmed (the engine trims at compile), or a padded keeper maps imports onto a twin just merged away
    const cleanReplace = canonical.trim();
    let added = 0, updated = 0;
    for (const form of new Set(variants.map(v => v.name.trim().toLowerCase()))) {
        if (existing.has(form)) {
            // A pre-existing rule mapping this form ELSEWHERE would silently override the
            // merge confirm's promise; the just-made explicit choice wins over the old rule
            const rule = rules.find(r => (r.match || '').trim().toLowerCase() === form);
            if (rule && (rule.replace || '').trim() !== cleanReplace) { rule.replace = cleanReplace; updated++; }
            continue;
        }
        // The canonical's own form still earns a rule: it re-cases future imports of any variant
        rules.push({ match: form, replace: cleanReplace });
        existing.add(form);
        added++;
    }
    if (added > 0 || updated > 0) {
        saveRules(rules);
        const parts = [];
        if (added > 0) parts.push(`added ${added}`);
        if (updated > 0) parts.push(`updated ${updated}`);
        const msg = parts.join(' and ');
        CoreAPI.showToast(`Import rules: ${msg} mapping to "${canonical}"`, 'success');
    } else {
        CoreAPI.showToast('A matching import rule already exists', 'info');
    }
}

async function mergeGroup(variants, canonical) {
    if (tagIndexUnread()) return;
    // Only the non-canonical variants need an operation
    const others = variants.map(v => v.name).filter(n => n !== canonical);
    const rewriteCount = others.reduce((n, name) => n + (tagCounts.get(name) || 0), 0);
    const choice = await CoreAPI.showConfirm({
        title: 'Merge duplicates',
        message: `Merge ${others.map(n => `"${n}"`).join(', ')} into "${canonical}"?`,
        confirmLabel: 'Merge',
        extraLabel: 'Merge + Add Import Rule',
        danger: true,
        content: [
            { type: 'stats', items: [{ icon: 'fa-solid fa-tags', label: 'rewrites', value: cardCount(rewriteCount) }] },
            { type: 'note', text: 'One relational operation per variant server-side; the toolbar Undo reverts the run.' },
            { type: 'text', text: `"Merge + Add Import Rule" also maps these variants to "${canonical}" on future imports.` },
        ],
    });
    if (!choice) return;
    if (choice === 'extra') addAliasRulesFor(variants, canonical);

    const results = await runTagOps('Merging',
        others.map(name => ({ route: 'rename', body: { from: name, to: canonical } })));
    if (results) others.forEach(v => CoreAPI.renameActiveTagFilter(v, canonical));
}

/**
 * What the rules do, counted on the tag index alone in the apply's unit: tag rows and their links, never characters.
 * @returns {{perRule: Array<{tags: number, links: number}>, strip: {tags: number, links: number}, trim: {tags: number, links: number}, cap: {tags: number, links: number}}}
 */
function computeRuleImpact() {
    const rules = getRules();
    const stripOn = CoreAPI.getSetting('tagAliasStripDecor') === true;
    const capOn = CoreAPI.getSetting('tagAliasCapitalize') === true;
    const compiled = CoreAPI.compileTagAliasRules(rules);
    const tally = () => ({ tags: 0, links: 0 });
    const count = (t, links) => { t.tags++; t.links += links; };
    const perRule = rules.map(tally);
    const strip = tally(), trim = tally(), cap = tally();
    for (const [name, links] of tagCounts) {
        const trimmed = String(name ?? '').trim();
        if (trimmed !== name) count(trim, links);
        const tag = stripOn ? CoreAPI.stripTagDecoration(trimmed) : trimmed;
        if (stripOn && tag !== trimmed) count(strip, links);
        if (!tag) continue;
        const entry = CoreAPI.matchTagAliasRule(compiled, tag);
        if (entry) count(perRule[entry.index], links);
        else if (capOn) {
            const first = [...tag][0];
            if (first !== first.toUpperCase()) count(cap, links);
        }
    }
    return { perRule, strip, trim, cap };
}

// Impact walks the tag index; cache per data-state so rules-search keystrokes reuse it
let rulesImpactCache = null;
function getRuleImpact() {
    if (!rulesImpactCache) rulesImpactCache = computeRuleImpact();
    return rulesImpactCache;
}

/** The library tags a rule matches, in the engine's order, so a tag an earlier rule catches isnt counted here. */
function ruleImpactTags(i) {
    const stripOn = CoreAPI.getSetting('tagAliasStripDecor') === true;
    const compiled = CoreAPI.compileTagAliasRules(getRules());
    const out = [];
    for (const [name, count] of tagCounts) {
        const trimmed = String(name ?? '').trim();
        const tag = stripOn ? CoreAPI.stripTagDecoration(trimmed) : trimmed;
        if (!tag) continue;
        const entry = CoreAPI.matchTagAliasRule(compiled, tag);
        if (!entry || entry.index !== i) continue;
        const [mapped] = CoreAPI.applyTagAliases([name]) || [];
        out.push({ name, count: count || 0, becomes: mapped ?? '' });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
}

// the affected-tags dialog virtualizes the FULL list: a broad rule matches thousands of tags
let _impactTags = [];

function injectImpactModal() {
    if (document.getElementById('tgmImpactModal')) return;
    const html = `
    <div id="tgmImpactModal" class="cl-modal">
        <div class="cl-modal-content tgm-impact-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-filter"></i> Tags this rule matches</h3>
                <button class="cl-modal-close" id="tgmImpactCloseBtn" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body tgm-impact-body">
                <div class="tgm-impact-subhead" id="tgmImpactSubhead"></div>
                <input type="search" id="tgmImpactSearch" class="cl-input" placeholder="Filter tags..." autocomplete="one-time-code">
                <div class="tgm-impact-list" id="tgmImpactList"></div>
                <div class="tgm-impact-note">First match wins: a tag caught by an earlier rule never reaches this one. Each line shows what the tag becomes after the whole pipeline (strip, rules, cleanup).</div>
            </div>
        </div>
    </div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);
    CoreAPI.mountDialogSizing('tgmImpactModal');

    const modal = document.getElementById('tgmImpactModal');
    const close = () => modal?.classList.remove('visible');
    document.getElementById('tgmImpactCloseBtn')?.addEventListener('click', close);
    modal?.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.getElementById('tgmImpactSearch')?.addEventListener('input', renderImpactList);

    window.registerOverlay?.({
        id: 'tgmImpactModal',
        tier: 3,
        close,
        visible: (el) => el.classList.contains('visible'),
    });
}

function buildImpactRow(t) {
    const row = document.createElement('div');
    row.className = 'tgm-impact-row';
    row.innerHTML = `
        <span class="tgm-impact-name" title="${CoreAPI.escapeHtml(t.name)}">${CoreAPI.escapeHtml(t.name)}</span>
        <i class="fa-solid fa-arrow-right tgm-rule-arrow"></i>
        <span class="tgm-impact-becomes${t.becomes ? '' : ' tgm-impact-dropped'}" title="${CoreAPI.escapeHtml(t.becomes || '(dropped)')}">${CoreAPI.escapeHtml(t.becomes || '(dropped)')}</span>
        <span class="tgm-rule-impact" title="Characters carrying this tag">${t.count.toLocaleString()}</span>`;
    return row;
}

function renderImpactList() {
    const list = document.getElementById('tgmImpactList');
    if (!list) return;
    const filter = (document.getElementById('tgmImpactSearch')?.value || '').trim().toLowerCase();
    const items = _impactTags.filter(t => !filter
        || t.name.toLowerCase().includes(filter)
        || t.becomes.toLowerCase().includes(filter));
    const virtual = makeVirtualList(list, buildImpactRow);
    if (!virtual.set(items)) {
        list.innerHTML = emptyStateHtml('fa-magnifying-glass', 'No tags match', 'Try a different filter.');
    }
}

function showRuleImpactTags(i) {
    const rule = rulesWorking[i];
    if (!rule?.match) return;
    if (tagIndexUnread()) return;
    _impactTags = ruleImpactTags(i);
    if (_impactTags.length === 0) {
        CoreAPI.showToast('No library tags currently match this rule', 'info');
        return;
    }
    injectImpactModal();
    const sub = document.getElementById('tgmImpactSubhead');
    if (sub) {
        const links = getRuleImpact().perRule[i]?.links || 0;
        sub.innerHTML = `<code>${CoreAPI.escapeHtml(rule.match)}</code> <i class="fa-solid fa-arrow-right"></i> `
            + `${rule.replace ? `<code>${CoreAPI.escapeHtml(rule.replace)}</code>` : '<em>(drop tag)</em>'}`
            + ` · ${_impactTags.length.toLocaleString()} tag${_impactTags.length === 1 ? '' : 's'}`
            + ` · carried ${links.toLocaleString()} time${links === 1 ? '' : 's'}`;
    }
    const search = document.getElementById('tgmImpactSearch');
    if (search) search.value = '';
    renderImpactList();
    document.getElementById('tgmImpactModal')?.classList.add('visible');
}

async function applyRulesToLibrary() {
    if (tagIndexUnread()) return;
    const ops = buildRuleRenameOps();
    if (ops.length === 0) {
        CoreAPI.showToast('The rules change no tag in your library', 'info');
        return;
    }
    const plan = summarizeRuleOps(ops);
    const impact = getRuleImpact();
    const rules = getRules();
    // Blocks escape internally, so lines carry RAW rule text
    const lines = [];
    rules.forEach((rule, i) => {
        const hit = impact.perRule[i];
        if (!rule.match || !hit?.tags) return;
        const to = rule.replace ? `"${rule.replace}"` : '(dropped)';
        lines.push(`"${rule.match}" → ${to}   (${tagCount(hit.tags)})`);
    });
    if (CoreAPI.getSetting('tagAliasStripDecor') === true && impact.strip.tags > 0) lines.push(`Emoji/decoration strip   (${tagCount(impact.strip.tags)})`);
    if (CoreAPI.getSetting('tagAliasCapitalize') === true && impact.cap.tags > 0) lines.push(`First-letter capitalization   (${tagCount(impact.cap.tags)})`);
    if (CoreAPI.getSetting('tagAliasTrimSpaces') === true && impact.trim.tags > 0) lines.push(`Whitespace cleanup   (${tagCount(impact.trim.tags)})`);
    const shown = lines.slice(0, 12);
    if (lines.length > 12) shown.push(`and ${lines.length - 12} more`);
    const stats = [];
    if (plan.renames) stats.push({ icon: 'fa-solid fa-pen', label: 'renames', value: tagCount(plan.renames) });
    if (plan.merges) stats.push({ icon: 'fa-solid fa-code-merge', label: 'merges', value: tagCount(plan.merges) });
    if (plan.removes) stats.push({ icon: 'fa-solid fa-trash', label: 'removes', value: tagCount(plan.removes) });
    stats.push({ icon: 'fa-solid fa-link', label: 'links', value: plan.links.toLocaleString() });

    const ok = await CoreAPI.showConfirm({
        title: 'Apply rules to library',
        confirmLabel: 'Rewrite tags',
        danger: true,
        content: [
            { type: 'list', items: shown },
            { type: 'stats', items: stats },
            { type: 'note', text: 'Each tag changes once, for every character carrying it. Previous names are journaled (toolbar Undo reverts the run); imports keep applying these rules automatically.' },
        ],
    });
    if (!ok) return;

    const results = await runTagOps('Applying rules', ops);
    if (results) CoreAPI.reconcileTagFiltersWithAliases();
}

// a run's ops replayed over the table's names: a rename onto a held name is a merge, as the server decides it
function summarizeRuleOps(ops) {
    const taken = new Set([...tagCounts.keys()].map(nocase));
    let renames = 0, merges = 0, removes = 0, links = 0;
    for (const op of ops) {
        const source = op.route === 'remove' ? op.body.name : op.body.from;
        links += tagCounts.get(source) || 0;
        const from = nocase(source);
        taken.delete(from);
        if (op.route === 'remove') { removes++; continue; }
        const to = nocase(op.body.to);
        if (to !== from && taken.has(to)) merges++;
        else renames++;
        taken.add(to);
    }
    return { renames, merges, removes, links };
}

/** Rules rewrite tag NAMES, so the unit is the tags table (/tags/rename), never the cards (a case-only change wouldnt move). */
function buildRuleRenameOps() {
    const ops = [];
    const claimed = new Set();
    for (const name of tagCounts.keys()) {
        const [mapped] = CoreAPI.applyTagAliases([name]) || [];
        if (mapped === name) continue;
        if (!mapped) {
            ops.push({ route: 'remove', body: { name } });
            continue;
        }
        // two sources onto one target is a merge; keep them sequential and de-duped for the undo
        const key = JSON.stringify([name, mapped]);
        if (claimed.has(key)) continue;
        claimed.add(key);
        ops.push({ route: 'rename', body: { from: name, to: mapped } });
    }
    return ops;
}

// ========================================
// LIBRARY TAB (windowed list)
// ========================================

function renderLibraryTab() {
    const searchInput = document.getElementById('tgmSearchInput');
    const countEl = document.getElementById('tgmTagTotal');
    if (tagIndexError) {
        if (countEl) countEl.textContent = '? tags';
        document.getElementById('tgmDupeChip')?.classList.add('hidden');
        if (searchInput) searchInput.oninput = null;
        updateUndoButton();
        const content = document.getElementById('tgmTagList');
        if (!content) return;
        content.onscroll = null;
        content.innerHTML = emptyStateHtml('fa-triangle-exclamation', 'Could not read your tags', CoreAPI.escapeHtml(tagIndexError),
            '<i class="fa-solid fa-rotate-right"></i> Retry');
        content.querySelector('.cl-empty-state-action')?.addEventListener('click', retryTagIndex);
        return;
    }
    if (countEl) countEl.textContent = `${tagCounts.size.toLocaleString()} tags`;

    // the dupe chip only while dupes exist, the sort toggle only in the flat list
    const dupeGroups = findCaseDupeGroups();
    const chip = document.getElementById('tgmDupeChip');
    if (chip) {
        chip.classList.toggle('hidden', dupeGroups.length === 0);
        chip.classList.toggle('active', showingDupes);
        chip.querySelector('span').textContent = dupeGroups.length.toLocaleString();
        chip.title = showingDupes
            ? 'Back to all tags'
            : `Review ${dupeGroups.length.toLocaleString()} groups of case/whitespace duplicates`;
    }
    const sortBtn = document.getElementById('tgmSortBtn');
    if (sortBtn) {
        sortBtn.classList.toggle('hidden', showingDupes);
        sortBtn.querySelector('i').className =
            sortMode === 'name' ? 'fa-solid fa-arrow-down-a-z' : 'fa-solid fa-arrow-down-wide-short';
        sortBtn.querySelector('.tgm-tool-label').textContent = sortMode === 'name' ? 'A-Z' : 'Most used';
        sortBtn.title = sortMode === 'name' ? 'Sorted A-Z. Click to sort by most used' : 'Sorted by most used. Click to sort A-Z';
    }
    updateUndoButton();

    if (showingDupes) {
        renderDupeGroups(dupeGroups, searchInput?.value || '');
        return;
    }

    const content = document.getElementById('tgmTagList');
    if (!content) return;

    const entries = [...tagCounts.keys()].map(t => ({ t, key: t.trim().toLowerCase() }));
    entries.sort(sortMode === 'name'
        ? (a, b) => tagCollator.compare(a.key, b.key) || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)
        : (a, b) => (tagCounts.get(b.t) - tagCounts.get(a.t)) || tagCollator.compare(a.key, b.key));
    const sortedTags = entries.map(e => e.t);

    const buildRow = (tag) => {
        const row = document.createElement('div');
        row.className = 'tgm-row';

        const label = document.createElement('span');
        label.className = 'tgm-row-name';
        label.textContent = tag;
        label.title = tag;

        const count = document.createElement('span');
        count.className = 'tgm-row-count';
        count.textContent = tagCounts.get(tag) || 0;

        const actions = document.createElement('span');
        actions.className = 'tgm-row-actions';
        actions.innerHTML = `
            <button class="tgm-icon-btn" data-act="rename" title="Rename tag"><i class="fa-solid fa-pen"></i></button>
            <button class="tgm-icon-btn" data-act="filter" title="Show in grid"><i class="fa-solid fa-magnifying-glass"></i></button>
            <button class="tgm-icon-btn tgm-danger" data-act="delete" title="Delete tag from all characters"><i class="fa-solid fa-trash"></i></button>`;

        actions.querySelector('[data-act="rename"]').addEventListener('click', () => startInlineRename(row, tag));
        actions.querySelector('[data-act="filter"]').addEventListener('click', () => {
            CoreAPI.filterLibraryByTag(tag);
            closeModal();
        });
        actions.querySelector('[data-act="delete"]').addEventListener('click', () => deleteTag(tag));

        // rows rebuilt mid-run come up disabled, or a "Show in grid" click aborts the run via closeModal
        if (runInProgress) actions.querySelectorAll('button').forEach(b => { b.disabled = true; });

        // a phone's row is the target and its verbs a sheet; the glyph only says so
        const more = document.createElement('i');
        more.className = 'fa-solid fa-ellipsis-vertical tgm-row-more';
        more.setAttribute('aria-hidden', 'true');
        row.addEventListener('click', (e) => {
            if (!CoreAPI.isMobileMode() || runInProgress || e.target.closest('button, input')) return;
            openTagSheet(tag);
        });

        row.appendChild(label);
        row.appendChild(count);
        row.appendChild(actions);
        row.appendChild(more);
        return row;
    };

    const virtual = makeVirtualList(content, (tag) => buildRow(tag));

    const renderList = (filterText = '') => {
        const lowerFilter = filterText.toLowerCase();
        const matchedTags = !lowerFilter ? sortedTags : sortedTags.filter(t => t.toLowerCase().includes(lowerFilter));
        if (!virtual.set(matchedTags)) {
            content.innerHTML = emptyStateHtml('fa-magnifying-glass', 'No tags match', 'Try a different search.');
        }
    };

    renderList(searchInput?.value || '');

    if (searchInput) {
        searchInput.oninput = () => {
            if (showingDupes) renderLibraryTab();
            else renderList(searchInput.value);
        };
    }
}

// a phone row's three verbs in the canonical sheet; the rename asks in the dialog opened inside the tap, so the keyboard rises
function openTagSheet(tag) {
    const sheet = CoreAPI.createMobileSheet({ label: tag });
    if (!sheet) return;
    const item = (act, icon, word, danger) => `<button type="button" class="mobile-sheet-item${danger ? ' danger' : ''}" data-tgm-sheet="${act}"><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${word}</span></button>`;
    // insertAdjacentHTML, never innerHTML: the builder already appended the drag handle
    sheet.sheet.insertAdjacentHTML('beforeend', `<div class="tgm-sheet-head"><span class="tgm-sheet-name">${CoreAPI.escapeHtml(tag)}</span>`
        + `<span class="tgm-sheet-meta">On ${cardCount(tagCounts.get(tag) || 0)}</span></div>`
        + item('filter', 'fa-magnifying-glass', 'Show in the Library')
        + item('rename', 'fa-pen', 'Rename')
        + item('delete', 'fa-trash', 'Delete from Every Card', true));
    sheet.sheet.addEventListener('click', (e) => {
        const it = e.target.closest('[data-tgm-sheet]');
        if (!it) return;
        sheet.close();
        if (runInProgress) return;
        const act = it.dataset.tgmSheet;
        if (act === 'filter') { CoreAPI.filterLibraryByTag(tag); closeModal(); }
        else if (act === 'rename') void promptRename(tag);
        else void deleteTag(tag);
    });
    sheet.open();
}

async function promptRename(tag) {
    const name = await CoreAPI.showConfirm({ title: 'Rename tag', message: `A new name for "${tag}":`, confirmLabel: 'Rename', input: { value: tag } });
    if (typeof name === 'string') await renameTag(tag, name);
}

function startInlineRename(row, tag) {
    if (runInProgress) return;
    const label = row.querySelector('.tgm-row-name');
    if (!label || row.querySelector('.tgm-rename-input')) return;

    const input = document.createElement('input');
    input.type = 'search';
    input.autocomplete = 'one-time-code';
    input.className = 'cl-input tgm-rename-input';
    input.value = tag;

    let finished = false;
    const finish = (commit) => {
        if (finished) return;
        finished = true;
        input.replaceWith(label);
        if (commit && input.value.trim() && input.value.trim() !== tag) {
            renameTag(tag, input.value);
        } else {
            repaintIfWanted();
        }
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(false));

    label.replaceWith(input);
    input.focus();
    input.select();
}

function renderDupeGroups(groups, filterText = '') {
    const content = document.getElementById('tgmTagList');
    if (!content) return;
    content.onscroll = null;
    content.innerHTML = '';

    const lowerFilter = filterText.trim().toLowerCase();
    if (lowerFilter) {
        groups = groups.filter(variants => variants.some(v => v.name.toLowerCase().includes(lowerFilter)));
    }

    if (groups.length === 0) {
        if (lowerFilter) {
            content.innerHTML = emptyStateHtml('fa-magnifying-glass', 'No duplicate groups match', 'Try a different search.');
        } else {
            // All merged: drop back to the flat list instead of stranding an empty review
            showingDupes = false;
            renderLibraryTab();
        }
        return;
    }

    const hint = document.createElement('div');
    hint.className = 'tgm-hint tgm-dupes-hint';
    hint.textContent = `${CoreAPI.isMobileMode() ? 'Tap' : 'Click'} the variant to keep; the others merge into it.`;
    content.appendChild(hint);

    for (const variants of groups) {
        const groupEl = document.createElement('div');
        groupEl.className = 'tgm-dupe-group';

        for (const v of variants) {
            const pill = document.createElement('button');
            pill.className = 'cl-tag tgm-dupe-pill';
            pill.innerHTML = `${CoreAPI.escapeHtml(v.name)} <span class="tgm-row-count">${v.count}</span>`;
            pill.title = `Merge the other variant(s) into "${v.name}"`;
            pill.addEventListener('click', () => mergeGroup(variants, v.name));
            groupEl.appendChild(pill);
        }

        content.appendChild(groupEl);
    }
}

// ========================================
// BATCH TAB
// ========================================

// the library is the one picker: its selection, or its current view sent as a filter (never listed here)
function renderBatchTab() {
    const selected = CoreAPI.getSelectionCount();
    const selBtn = document.getElementById('tgmBatchSelectionBtn');
    if (selBtn) {
        selBtn.disabled = selected === 0 || runInProgress;
        selBtn.querySelector('.tgm-batch-n').textContent = selected.toLocaleString();
    }
    const filter = CoreAPI.currentViewFilter();
    // the grid sizes its array from the server's count, so its length is the view's size
    const inView = filter === null ? 0 : (CoreAPI.getCurrentCharacters() || []).length;
    const viewBtn = document.getElementById('tgmBatchViewBtn');
    if (viewBtn) {
        viewBtn.disabled = inView === 0 || runInProgress;
        viewBtn.querySelector('.tgm-batch-n').textContent = inView.toLocaleString();
        viewBtn.title = CoreAPI.filterNamesNothing(filter)
            ? 'No search or filter is active: this is every character in your library'
            : 'Every character the library\'s current search and filters show';
    }
}

function openBatchEditor(target) {
    // Close first: the two modals' DOM order (and so their paint order) depends on which
    // module lazy-loaded first, so stacking them is not deterministic
    closeModal();
    CoreAPI.getModule('batch-tagging')?.openModal?.(target);
}

// ========================================
// RULES TAB
// ========================================

// the rules tab's working array: rows write into it by identity and the whole array persists
let rulesWorking = [];
// live error state by rule index, so a scrolled-back row never re-shows a fixed regex's old mark
let rulesErrorByIndex = new Map();
// the phone's open rule, moved with its rule; -1 when none is open
let openRuleIdx = -1;

function getRules() {
    const rules = CoreAPI.getSetting('tagAliasRules');
    if (!Array.isArray(rules)) return [];
    // fresh copies: the stored array can BE the DEFAULT_SETTINGS reference (a shallow spread); junk is healed on read
    return rules
        .filter(r => r && typeof r === 'object')
        .map(r => ({
            match: typeof r.match === 'string' ? r.match : '',
            replace: typeof r.replace === 'string' ? r.replace : '',
        }));
}

function saveRules(rules) {
    CoreAPI.setSetting('tagAliasRules', rules);
    rulesImpactCache = null;
    updateRuleTest();
}

function renderRulesTab() {
    // a phone's toggles are the app's switch; the desktop keeps its checkboxes
    for (const id of ['tgmStripDecor', 'tgmTrimSpaces', 'tgmCapitalize']) document.getElementById(id)?.classList.toggle('cl-switch-input', CoreAPI.isMobileMode());
    const stripToggle = document.getElementById('tgmStripDecor');
    if (stripToggle) stripToggle.checked = CoreAPI.getSetting('tagAliasStripDecor') === true;
    const trimToggle = document.getElementById('tgmTrimSpaces');
    if (trimToggle) trimToggle.checked = CoreAPI.getSetting('tagAliasTrimSpaces') === true;
    const capToggle = document.getElementById('tgmCapitalize');
    if (capToggle) capToggle.checked = CoreAPI.getSetting('tagAliasCapitalize') === true;

    const list = document.getElementById('tgmRulesList');
    const header = document.getElementById('tgmRulesHeader');
    const searchInput = document.getElementById('tgmRuleSearch');
    if (!list) return;
    rulesWorking = getRules();
    // a phone shows the search once the rules outgrow a glance, and never hides one holding text
    list.closest('.tgm-pane')?.classList.toggle('tgm-few-rules', rulesWorking.length <= 6 && !searchInput?.value);

    if (rulesWorking.length === 0) {
        if (header) header.classList.add('hidden');
        list.onscroll = null;
        list.innerHTML = emptyStateHtml('fa-filter', 'No rules yet', 'Add a rule below; imports apply the whole list automatically.');
        refreshToggleImpacts(getRuleImpact());
        updateRuleTest();
        return;
    }
    if (header) header.classList.remove('hidden');

    const compiled = CoreAPI.compileTagAliasRules(rulesWorking);
    rulesErrorByIndex = new Map(compiled.list.filter(e => e.error).map(e => [e.index, e.error]));
    refreshToggleImpacts(getRuleImpact());

    const filter = (searchInput?.value || '').trim().toLowerCase();
    const items = rulesWorking
        .map((rule, i) => ({ rule, i }))
        .filter(({ rule }) => !filter
            || rule.match.toLowerCase().includes(filter)
            || rule.replace.toLowerCase().includes(filter));

    // Reordering a FILTERED view is ambiguous (moving past hidden neighbors), so the
    // chevrons only render on the unfiltered list
    const reorderable = !filter;
    if (CoreAPI.isMobileMode()) renderRuleCards(list, items, reorderable);
    else {
        const virtual = makeVirtualList(list, ({ rule, i }) => buildRuleRow(rule, i, reorderable));
        if (!virtual.set(items)) {
            list.innerHTML = emptyStateHtml('fa-magnifying-glass', 'No rules match', 'Try a different search.');
        }
    }

    if (searchInput) searchInput.oninput = () => renderRulesTab();

    updateRuleTest();
}

function buildRuleRow(rule, i, reorderable) {
    const row = document.createElement('div');
    row.className = 'tgm-rule-row';
    row.dataset.ruleIdx = i;
    // Read impact/error from live module state, not a render-time closure: the virtualizer
    // rebuilds scrolled-back rows long after the render that queued them
    const hit = getRuleImpact().perRule[i] || { tags: 0, links: 0 };
    const err = rulesErrorByIndex.get(i);
    row.innerHTML = `
        <input type="search" autocomplete="one-time-code" class="cl-input tgm-rule-match${err ? ' tgm-rule-error' : ''}" placeholder="tag to match, or /regex/" title="${err ? CoreAPI.escapeHtml('Invalid regex: ' + err) : 'The incoming tag to match: exact (case-insensitive), or /pattern/ regex; the replacement may use $1 groups'}" value="${CoreAPI.escapeHtml(rule.match)}">
        <i class="fa-solid fa-arrow-right tgm-rule-arrow"></i>
        <input type="search" autocomplete="one-time-code" class="cl-input tgm-rule-replace" placeholder="(drop tag)" title="What the tag becomes; leave empty to drop it entirely" value="${CoreAPI.escapeHtml(rule.replace)}">
        <span class="tgm-rule-impact${rule.match ? ' tgm-impact-click' : ''}" title="${ruleBadgeTitle(hit)}">${rule.match ? ruleBadgeText(hit) : ''}</span>
        <span class="tgm-rule-btns">${reorderable ? `
            <button class="tgm-icon-btn" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
            <button class="tgm-icon-btn" data-act="down" title="Move down" ${i === rulesWorking.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>` : ''}
            <button class="tgm-icon-btn tgm-danger" data-act="remove" title="Remove rule"><i class="fa-solid fa-xmark"></i></button>
        </span>`;

    const matchInput = row.querySelector('.tgm-rule-match');
    const replaceInput = row.querySelector('.tgm-rule-replace');
    const persist = () => persistRule(i, matchInput, replaceInput);
    matchInput.addEventListener('change', persist);
    replaceInput.addEventListener('change', persist);
    matchInput.addEventListener('blur', repaintIfWanted);
    replaceInput.addEventListener('blur', repaintIfWanted);
    row.querySelector('[data-act="up"]')?.addEventListener('click', () => moveRule(i, -1));
    row.querySelector('[data-act="down"]')?.addEventListener('click', () => moveRule(i, 1));
    row.querySelector('[data-act="remove"]').addEventListener('click', () => removeRule(i));
    // unconditional: an empty-match row grows its badge in place as the user types (a rebuild would steal focus)
    row.querySelector('.tgm-rule-impact')?.addEventListener('click', () => showRuleImpactTags(i));
    // mid-run rebuilt rows stay locked, or an edit would apply a different ruleset to the rest
    if (runInProgress) row.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
    return row;
}

const RULE_MATCH_TITLE = 'The incoming tag to match: exact (case-insensitive), or /pattern/ regex; the replacement may use $1 groups';

// a rule's fields written into the working array IN PLACE (the rows hold these objects), saved, its pattern checked
function persistRule(i, matchInput, replaceInput) {
    if (!rulesWorking[i]) return;
    rulesWorking[i].match = matchInput.value.trim();
    rulesWorking[i].replace = replaceInput.value.trim();
    saveRules(rulesWorking);
    const rowErr = CoreAPI.compileTagAliasRules([rulesWorking[i]]).list[0]?.error;
    if (rowErr) rulesErrorByIndex.set(i, rowErr); else rulesErrorByIndex.delete(i);
    matchInput.classList.toggle('tgm-rule-error', !!rowErr);
    matchInput.title = rowErr ? 'Invalid regex: ' + rowErr : RULE_MATCH_TITLE;
    refreshRuleImpacts();
}

// Index clamps stay load-bearing: a bulk run's blanket re-enable can arm the markup-disabled first/last moves
function moveRule(i, step) {
    const j = i + step;
    if (i < 0 || j < 0 || i >= rulesWorking.length || j >= rulesWorking.length) return;
    [rulesWorking[j], rulesWorking[i]] = [rulesWorking[i], rulesWorking[j]];
    if (openRuleIdx === i) openRuleIdx = j;
    saveRules(rulesWorking);
    renderRulesTab();
}

function removeRule(i) {
    if (i < 0 || i >= rulesWorking.length) return;
    rulesWorking.splice(i, 1);
    if (openRuleIdx === i) openRuleIdx = -1;
    else if (openRuleIdx > i) openRuleIdx--;
    saveRules(rulesWorking);
    renderRulesTab();
}

function addRule() {
    // A new row must be visible and focusable: clear the filter, open it, and on a desktop jump to the bottom
    const searchInput = document.getElementById('tgmRuleSearch');
    if (searchInput) searchInput.value = '';
    rulesWorking = getRules();
    rulesWorking.push({ match: '', replace: '' });
    openRuleIdx = rulesWorking.length - 1;
    saveRules(rulesWorking);
    renderRulesTab();
    if (CoreAPI.isMobileMode()) {
        // inside the tap, the one focus a phone raises its keyboard for
        const field = document.querySelector('#tgmRulesList .tgm-rule-card.is-open .tgm-rule-match');
        field?.focus({ preventScroll: true });
        field?.closest('.tgm-rule-card')?.scrollIntoView({ block: 'nearest' });
        return;
    }
    const list = document.getElementById('tgmRulesList');
    if (list) list.scrollTop = list.scrollHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const inputs = document.querySelectorAll('#tgmRulesList .tgm-rule-match');
        inputs[inputs.length - 1]?.focus();
    }));
}

// the phone's rules: a readable row each, opened in place one at a time

// the list renders whole: a row at rest is a few spans, and its fields are built only when it opens
function renderRuleCards(list, items, reorderable) {
    list._virtualList?.destroy();
    list._virtualList = null;
    list.onscroll = null;
    list.innerHTML = '';
    if (!items.length) { list.innerHTML = emptyStateHtml('fa-magnifying-glass', 'No rules match', 'Try a different search.'); return; }
    const frag = document.createDocumentFragment();
    for (const { i } of items) frag.appendChild(buildRuleCard(i, reorderable));
    list.appendChild(frag);
}

function buildRuleCard(i, reorderable) {
    const card = document.createElement('div');
    card.className = 'tgm-rule-card';
    card.dataset.ruleIdx = i;
    // the spans stay put and only their text changes: a repaint under a tap would lose the click
    card.innerHTML = `
        <button type="button" class="tgm-rule-sum" aria-expanded="false">
            <span class="tgm-rule-n">${i + 1}</span>
            <span class="tgm-rule-map"><span class="tgm-rule-from"></span><i class="fa-solid fa-arrow-right tgm-rule-arrow" aria-hidden="true"></i><span class="tgm-rule-to"></span></span>
            <span class="tgm-rule-meta"><span class="tgm-rule-chip tgm-chip-error"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Broken Pattern</span><span class="tgm-rule-chip tgm-chip-impact"></span></span>
            <i class="fa-solid fa-chevron-down tgm-rule-chev" aria-hidden="true"></i>
        </button>`;
    paintRuleSummary(card, i);
    card.querySelector('.tgm-rule-sum').addEventListener('click', () => {
        const open = document.querySelector('#tgmRulesList .tgm-rule-card.is-open');
        if (open) closeRuleCard(open);
        if (open !== card) openRuleCard(card, i, reorderable);
    });
    if (openRuleIdx === i) openRuleCard(card, i, reorderable);
    if (runInProgress) card.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
    return card;
}

function paintRuleSummary(card, i) {
    const rule = rulesWorking[i];
    if (!rule) return;
    const from = card.querySelector('.tgm-rule-from');
    const to = card.querySelector('.tgm-rule-to');
    from.textContent = rule.match || 'No match yet';
    from.classList.toggle('is-empty', !rule.match);
    from.classList.toggle('is-pattern', rule.match.length > 2 && rule.match[0] === '/');
    to.textContent = rule.replace || 'Drops the Tag';
    to.classList.toggle('is-drop', !rule.replace);
    card.querySelector('.tgm-chip-error').hidden = !rulesErrorByIndex.has(i);
    const impact = card.querySelector('.tgm-chip-impact');
    const hit = getRuleImpact().perRule[i] || { tags: 0, links: 0 };
    impact.hidden = !rule.match;
    impact.textContent = tagIndexError ? '? tags' : tagCount(hit.tags);
    impact.classList.toggle('is-none', !tagIndexError && hit.tags === 0);
}

function openRuleCard(card, i, reorderable) {
    const rule = rulesWorking[i];
    if (!rule) return;
    openRuleIdx = i;
    card.classList.add('is-open');
    card.querySelector('.tgm-rule-sum').setAttribute('aria-expanded', 'true');
    const last = i === rulesWorking.length - 1;
    const edit = document.createElement('div');
    edit.className = 'tgm-rule-edit';
    edit.innerHTML = `
        <label class="tgm-field"><span class="tgm-field-label">When a tag matches</span>
            <input type="search" autocomplete="one-time-code" class="cl-input tgm-rule-match" placeholder="A tag, or a /pattern/" title="${RULE_MATCH_TITLE}" value="${CoreAPI.escapeHtml(rule.match)}"></label>
        <p class="tgm-field-hint tgm-rule-err-line"></p>
        <p class="tgm-field-hint">The whole tag in any case, or a /pattern/.</p>
        <label class="tgm-field"><span class="tgm-field-label">It becomes</span>
            <input type="search" autocomplete="one-time-code" class="cl-input tgm-rule-replace" placeholder="Leave empty to drop the tag" value="${CoreAPI.escapeHtml(rule.replace)}"></label>
        <p class="tgm-field-hint">$1 brings back what a pattern's first group caught.</p>
        <button type="button" class="tgm-rule-impact-line"><span>What It Changes</span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
        <div class="tgm-rule-verbs">${reorderable ? `
            <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-act="up" ${i === 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-up"></i> Move Up</button>
            <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-act="down" ${last ? 'disabled' : ''}><i class="fa-solid fa-arrow-down"></i> Move Down</button>` : ''}
            <button type="button" class="cl-btn cl-btn-sm cl-btn-danger" data-act="remove"><i class="fa-solid fa-trash"></i> Delete</button>
        </div>`;
    card.appendChild(edit);
    const matchInput = edit.querySelector('.tgm-rule-match');
    const replaceInput = edit.querySelector('.tgm-rule-replace');
    const persist = () => persistRule(i, matchInput, replaceInput);
    matchInput.addEventListener('change', persist);
    replaceInput.addEventListener('change', persist);
    matchInput.addEventListener('blur', repaintIfWanted);
    replaceInput.addEventListener('blur', repaintIfWanted);
    edit.querySelector('[data-act="up"]')?.addEventListener('click', () => moveRule(i, -1));
    edit.querySelector('[data-act="down"]')?.addEventListener('click', () => moveRule(i, 1));
    edit.querySelector('[data-act="remove"]').addEventListener('click', () => removeRule(i));
    edit.querySelector('.tgm-rule-impact-line').addEventListener('click', () => showRuleImpactTags(i));
    paintRuleEditor(card, i);
    if (runInProgress) edit.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
}

function paintRuleEditor(card, i) {
    const rule = rulesWorking[i];
    const edit = card.querySelector('.tgm-rule-edit');
    if (!rule || !edit) return;
    const err = rulesErrorByIndex.get(i);
    edit.querySelector('.tgm-rule-match').classList.toggle('tgm-rule-error', !!err);
    const errLine = edit.querySelector('.tgm-rule-err-line');
    errLine.hidden = !err;
    errLine.textContent = err ? `This pattern cannot run: ${err}` : '';
    const line = edit.querySelector('.tgm-rule-impact-line');
    const hit = getRuleImpact().perRule[i] || { tags: 0, links: 0 };
    const shows = !!rule.match && !tagIndexError && hit.tags > 0;
    line.disabled = !shows || runInProgress;
    line.querySelector('i').hidden = !shows;
    line.querySelector('span').textContent = !rule.match ? 'Type a match to see what it changes'
        : tagIndexError ? 'Your tags could not be read'
            : hit.tags ? `Changes ${tagCount(hit.tags)} in your library, carried ${hit.links.toLocaleString()} time${hit.links === 1 ? '' : 's'}`
                : 'Changes no tag in your library yet';
}

function closeRuleCard(card) {
    // the field's pending change lands before its row goes: removal fires neither blur nor change
    const active = document.activeElement;
    if (active && card.contains(active)) active.blur();
    card.querySelector('.tgm-rule-edit')?.remove();
    card.classList.remove('is-open');
    card.querySelector('.tgm-rule-sum')?.setAttribute('aria-expanded', 'false');
    if (openRuleIdx === Number(card.dataset.ruleIdx)) openRuleIdx = -1;
}

// In-place badge refresh so a mid-edit rebuild cant steal focus from the next input
function refreshRuleImpacts() {
    rulesImpactCache = null;
    const impact = getRuleImpact();
    document.querySelectorAll('#tgmRulesList .tgm-rule-row').forEach(row => {
        const idx = Number(row.dataset.ruleIdx);
        const badge = row.querySelector('.tgm-rule-impact');
        if (badge) {
            const hasMatch = !!rulesWorking[idx]?.match;
            const hit = impact.perRule[idx] || { tags: 0, links: 0 };
            badge.textContent = hasMatch ? ruleBadgeText(hit) : '';
            badge.title = ruleBadgeTitle(hit);
            badge.classList.toggle('tgm-impact-click', hasMatch);
        }
    });
    document.querySelectorAll('#tgmRulesList .tgm-rule-card').forEach(card => {
        const idx = Number(card.dataset.ruleIdx);
        paintRuleSummary(card, idx);
        paintRuleEditor(card, idx);
    });
    refreshToggleImpacts(impact);
}

// a badge counts the tags a rule changes, its title the links; a failed index reads as unknown
function ruleBadgeTitle(hit) {
    if (tagIndexError) return 'Your tags could not be read';
    return `${tagCount(hit.tags)} in your library, carried ${hit.links.toLocaleString()} time${hit.links === 1 ? '' : 's'}; click to list them`;
}

const ruleBadgeText = (hit) => (tagIndexError ? '?' : hit.tags.toLocaleString());

function refreshToggleImpacts(impact) {
    const setBadge = (id, on, hit) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (on && tagIndexError) { el.textContent = '? affected'; el.title = 'Your tags could not be read'; return; }
        el.textContent = (on && hit.tags > 0) ? `${tagCount(hit.tags)} affected` : '';
        el.title = (on && hit.tags > 0) ? `Carried ${hit.links.toLocaleString()} time${hit.links === 1 ? '' : 's'}` : '';
    };
    setBadge('tgmStripImpact', CoreAPI.getSetting('tagAliasStripDecor') === true, impact.strip);
    setBadge('tgmTrimImpact', CoreAPI.getSetting('tagAliasTrimSpaces') === true, impact.trim);
    setBadge('tgmCapImpact', CoreAPI.getSetting('tagAliasCapitalize') === true, impact.cap);
}

function updateRuleTest() {
    const input = document.getElementById('tgmRuleTestInput');
    const out = document.getElementById('tgmRuleTestOut');
    if (!input || !out) return;
    const value = input.value.trim();
    if (!value) { out.textContent = ''; return; }
    const mapped = CoreAPI.applyTagAliases([value]);
    out.textContent = mapped.length === 0 ? '(dropped)' : mapped[0];
    out.classList.toggle('tgm-dropped', mapped.length === 0);
}

// ========================================
// MODAL SHELL
// ========================================

function switchTab(tab) {
    activeTab = tab;
    const modal = document.getElementById('tagsManagerModal');
    modal.querySelectorAll('.tgm-tab').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.tab === tab));
    modal.querySelectorAll('.tgm-pane').forEach(pane =>
        pane.classList.toggle('hidden', pane.dataset.tab !== tab));

    // every tab reads the tag index (loaded with the modal) or the library's own selection and
    // view: nothing library-shaped is loaded to paint one
    if (tab === 'library') renderLibraryTab();
    else if (tab === 'batch') renderBatchTab();
    else renderRulesTab();
}

export async function openModal(tab) {
    if (!isInitialized) {
        console.error('[TagsManager] Module not initialized');
        return;
    }
    // settingsReady gates the modal: before it the rules tab paints defaults, and a toggle would PATCH them over the stored values
    await Promise.all([buildTagIndex(), CoreAPI.settingsReady()]);
    // Tag edits made outside the manager (batch tagging, detail modal) since the last
    // open invalidate any cached rule impacts
    rulesImpactCache = null;
    showingDupes = false;
    openRuleIdx = -1;
    document.getElementById('tagsManagerModal').classList.add('visible');
    switchTab(tab || activeTab || 'library');
}

function closeModal() {
    if (runInProgress) runAborted = true;
    // Flush a focused rule input's pending change FIRST: hiding the modal blurs it and
    // the late change event would otherwise write against post-prune indexes
    const modal = document.getElementById('tagsManagerModal');
    const active = document.activeElement;
    if (modal && active && modal.contains(active)) active.blur();
    // An abandoned blank Add Rule row would otherwise sit in settings forever (harmless to
    // the engine, which skips blank matches, but junk state)
    const rules = getRules();
    const pruned = rules.filter(r => r.match.trim() || r.replace.trim());
    if (pruned.length !== rules.length) saveRules(pruned);
    modal?.classList.remove('visible');
}

// a delete re-reads the index and repaints, unless a run holds the pane or a field is being typed in
let _repaintWanted = false;

function fieldBeingTyped() {
    const cls = document.activeElement?.classList;
    return !!cls && (cls.contains('tgm-rename-input') || cls.contains('tgm-rule-match') || cls.contains('tgm-rule-replace'));
}

function onCharactersDeleted() {
    const modal = document.getElementById('tagsManagerModal');
    if (!modal?.classList.contains('visible') || runInProgress) return;
    rulesImpactCache = null;
    if (fieldBeingTyped()) { _repaintWanted = true; return; }
    _repaintWanted = false;
    buildTagIndex().then(() => {
        if (modal.classList.contains('visible')) switchTab(activeTab);
    });
}

function repaintIfWanted() {
    if (_repaintWanted) onCharactersDeleted();
}

function setupEventListeners() {
    const modal = document.getElementById('tagsManagerModal');
    document.getElementById('tgmCloseBtn')?.addEventListener('click', closeModal);
    modal?.addEventListener('click', (e) => {
        // A stray backdrop tap must not abort a multi-thousand-carrier run; the Abort
        // button and the X are the deliberate stops
        if (e.target.id === 'tagsManagerModal' && !runInProgress) closeModal();
    });
    modal?.querySelectorAll('.tgm-tab').forEach(btn =>
        btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

    document.getElementById('tgmAbortBtn')?.addEventListener('click', (e) => { runAborted = true; CoreAPI.setRunVerb(e.currentTarget, 'stopping'); });
    document.getElementById('tgmUndoBtn')?.addEventListener('click', undoLastRun);
    document.getElementById('tgmDupeChip')?.addEventListener('click', () => {
        showingDupes = !showingDupes;
        renderLibraryTab();
    });
    document.getElementById('tgmSortBtn')?.addEventListener('click', () => {
        sortMode = sortMode === 'name' ? 'count' : 'name';
        renderLibraryTab();
    });

    // the library's selection: its ids, or a Select All's filter
    document.getElementById('tgmBatchSelectionBtn')?.addEventListener('click', () => {
        const selection = CoreAPI.getSelection();
        if (selection.filter !== undefined) openBatchEditor({ filter: selection.filter });
        else if (selection.ids.length) openBatchEditor({ ids: selection.ids });
    });
    document.getElementById('tgmBatchViewBtn')?.addEventListener('click', () => {
        const filter = CoreAPI.currentViewFilter();
        if (filter !== null) openBatchEditor({ filter });
    });

    const wireAliasToggle = (id, settingKey) => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            CoreAPI.setSetting(settingKey, e.target.checked === true);
            rulesImpactCache = null;
            updateRuleTest();
            refreshRuleImpacts();
        });
    };
    wireAliasToggle('tgmStripDecor', 'tagAliasStripDecor');
    wireAliasToggle('tgmTrimSpaces', 'tagAliasTrimSpaces');
    wireAliasToggle('tgmCapitalize', 'tagAliasCapitalize');
    document.getElementById('tgmAddRuleBtn')?.addEventListener('click', addRule);
    document.getElementById('tgmAddRuleRow')?.addEventListener('click', addRule);
    document.getElementById('tgmRulesHelpBtn')?.addEventListener('click', (e) => {
        const open = e.currentTarget.closest('.tgm-hint-banner').classList.toggle('is-open');
        e.currentTarget.setAttribute('aria-expanded', String(open));
    });
    document.getElementById('tgmRuleTestInput')?.addEventListener('input', updateRuleTest);
    document.getElementById('tgmApplyRulesBtn')?.addEventListener('click', applyRulesToLibrary);
}

function injectModal() {
    const modalHtml = `
    <div id="tagsManagerModal" class="cl-modal">
        <div class="cl-modal-content tgm-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-tags"></i> Tags Manager</h3>
                <button id="tgmCloseBtn" class="cl-modal-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <div class="tgm-tabs">
                <button class="tgm-tab active" data-tab="library" title="Browse, rename, merge and delete the tags in your library"><i class="fa-solid fa-list"></i> Library Tags</button>
                <button class="tgm-tab" data-tab="batch" title="Add or remove tags on many characters at once"><i class="fa-solid fa-object-group"></i> Batch Tagging</button>
                <button class="tgm-tab" data-tab="rules" title="Automatically rewrite or drop tags when importing from providers"><i class="fa-solid fa-filter"></i> Import Rules</button>
            </div>

            <div class="cl-modal-body tgm-body">
                <div class="tgm-pane" data-tab="library">
                    <div class="tgm-toolbar">
                        <input type="search" id="tgmSearchInput" class="cl-input" placeholder="Search tags..." autocomplete="one-time-code" title="Filter the tag list (also filters the duplicate review)">
                        <button id="tgmSortBtn" class="tgm-icon-btn tgm-tool-btn" aria-label="Sort tags"><i class="fa-solid fa-arrow-down-a-z"></i><span class="tgm-tool-label"></span></button>
                        <button id="tgmUndoBtn" class="tgm-icon-btn tgm-tool-btn hidden" title="Undo last bulk run"><i class="fa-solid fa-clock-rotate-left"></i><span class="tgm-tool-label">Undo</span></button>
                        <button id="tgmDupeChip" class="tgm-dupe-chip hidden"><i class="fa-solid fa-triangle-exclamation"></i> <span></span> dupes</button>
                        <span id="tgmTagTotal" class="tgm-total" title="Unique tags across your library"></span>
                    </div>
                    <div id="tgmTagList" class="tgm-list"></div>
                </div>

                <div class="tgm-pane hidden" data-tab="batch">
                    <div class="tgm-hint-banner">
                        <i class="fa-solid fa-circle-info"></i>
                        <span>Choose the characters in the library itself: select them, or search and filter the grid. The batch editor then adds or removes tags on all of them in one step.</span>
                    </div>
                    <div class="tgm-batch-verbs">
                        <button id="tgmBatchSelectionBtn" class="cl-btn cl-btn-primary" title="The characters selected in the library"><i class="fa-solid fa-square-check"></i><span>Tag the <span class="tgm-batch-n"></span> Selected</span><i class="fa-solid fa-chevron-right tgm-batch-chev" aria-hidden="true"></i></button>
                        <button id="tgmBatchViewBtn" class="cl-btn cl-btn-secondary"><i class="fa-solid fa-filter"></i><span>Tag Every Character in the Current View (<span class="tgm-batch-n"></span>)</span><i class="fa-solid fa-chevron-right tgm-batch-chev" aria-hidden="true"></i></button>
                    </div>
                </div>

                <div class="tgm-pane hidden" data-tab="rules">
                    <div class="tgm-hint-banner">
                        <i class="fa-solid fa-circle-info"></i>
                        <span><span class="tgm-hint-lead">Rules rewrite tags arriving from <strong>provider imports</strong>, top to bottom, first match wins.</span>
                            <button type="button" id="tgmRulesHelpBtn" class="tgm-hint-toggle" aria-expanded="false">How Rules Work</button>
                            <span class="tgm-hint-rest">Match exactly (case-insensitive) or with <strong>/regex/</strong> (the replacement may use <strong>$1</strong> groups); an empty replacement drops the tag. While anything here is active, imports also get whitespace trimmed and duplicates merged. Local files are never rewritten.</span></span>
                    </div>
                    <div class="tgm-alias-toggles">
                        <label class="tgm-strip-toggle" title="Removes emoji and decorations on import, e.g. a fire-emoji Female tag becomes just Female">
                            <input type="checkbox" id="tgmStripDecor"><span class="cl-switch tgm-switch" aria-hidden="true"></span>
                            <span class="tgm-toggle-text">Strip emoji and decoration from imported tags</span>
                            <span id="tgmStripImpact" class="tgm-rule-impact"></span>
                        </label>
                        <label class="tgm-strip-toggle" title="Trims stray whitespace on imported tags and merges the duplicates that creates, even with no rules defined">
                            <input type="checkbox" id="tgmTrimSpaces"><span class="cl-switch tgm-switch" aria-hidden="true"></span>
                            <span class="tgm-toggle-text">Clean whitespace on imported tags</span>
                            <span id="tgmTrimImpact" class="tgm-rule-impact"></span>
                        </label>
                        <label class="tgm-strip-toggle" title="Capitalizes the first letter of imported tags; tags produced by a rule keep the rule's exact casing">
                            <input type="checkbox" id="tgmCapitalize"><span class="cl-switch tgm-switch" aria-hidden="true"></span>
                            <span class="tgm-toggle-text">Capitalize the first letter of imported tags</span>
                            <span id="tgmCapImpact" class="tgm-rule-impact"></span>
                        </label>
                    </div>
                    <div class="tgm-toolbar">
                        <input type="search" id="tgmRuleSearch" class="cl-input" placeholder="Search rules..." autocomplete="one-time-code" title="Filter rules by match or replacement text (reordering is available on the unfiltered list)">
                    </div>
                    <div id="tgmRulesHeader" class="tgm-rule-header hidden"><span>When a tag matches</span><span></span><span>it becomes</span><span></span></div>
                    <div id="tgmRulesList" class="tgm-rules-list"></div>
                    <button type="button" id="tgmAddRuleRow" class="tgm-add-rule-row"><i class="fa-solid fa-plus" aria-hidden="true"></i> Add a Rule</button>
                    <div class="tgm-rules-actions">
                        <button id="tgmAddRuleBtn" class="cl-btn cl-btn-secondary tgm-add-rule-btn" title="Rules apply top to bottom; the first matching rule wins"><i class="fa-solid fa-plus"></i> Add Rule</button>
                        <button id="tgmApplyRulesBtn" class="cl-btn cl-btn-primary" title="Run the ruleset once over every character already in the library"><i class="fa-solid fa-bolt"></i> Apply to Library Now</button>
                    </div>
                    <div class="tgm-rule-test" title="Preview what the rules would do to a tag">
                        <i class="fa-solid fa-flask tgm-rule-test-icon"></i>
                        <input type="search" id="tgmRuleTestInput" class="cl-input" placeholder="Test a tag..." autocomplete="one-time-code">
                        <i class="fa-solid fa-arrow-right tgm-rule-arrow"></i>
                        <span id="tgmRuleTestOut"></span>
                    </div>
                </div>
            </div>

            <div id="tgmProgress" class="tgm-progress hidden">
                <div class="tgm-progress-track"><div id="tgmProgressFill" class="tgm-progress-fill"></div></div>
                <span id="tgmProgressText"></span>
                <button id="tgmAbortBtn" class="cl-btn cl-btn-danger-hover" title="Stop after the write currently in flight; completed writes stay and Undo reverts them"><i class="fa-solid fa-xmark"></i> Cancel</button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    CoreAPI.mountDialogSizing('tagsManagerModal');
}

export function init() {
    if (isInitialized) {
        console.warn('[TagsManager] Already initialized');
        return;
    }

    injectModal();
    setupEventListeners();
    CoreAPI.onCharactersDeleted(onCharactersDeleted);
    // a phone and a desktop draw the rules and the rows differently, so a live flip repaints the open tab
    document.addEventListener('cl-mobile-mode-change', () => {
        if (document.getElementById('tagsManagerModal')?.classList.contains('visible') && !runInProgress) switchTab(activeTab);
    });

    // tier 8; the global Escape is capture-phase, so the close fn cancels an active rename instead of closing
    window.registerOverlay?.({
        id: 'tagsManagerModal',
        tier: 8,
        close: () => {
            const rename = document.querySelector('#tagsManagerModal .tgm-rename-input');
            if (rename) { rename.blur(); return; }
            closeModal();
        },
        visible: (el) => el.classList.contains('visible'),
    });

    isInitialized = true;
    CoreAPI.debugLog('[TagsManager] Module initialized');
}

export default {
    init,
    openModal
};
