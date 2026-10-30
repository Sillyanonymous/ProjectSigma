import * as CoreAPI from './core-api.js';
import { runCommand } from './ext-registry.js';

// ========================================
// STATE
// ========================================

let isInitialized = false;

const state = {
    view: 'chooser',
    running: false,
    abort: false,
    controller: null,
    zip: null,
    manifest: null,
    importSourceName: '',
};

const dec = new TextDecoder();

function tryParseJson(text) {
    try { return JSON.parse(text); } catch { return null; }
}

// ========================================
// ZIP READER (review-only; the server writes bundles)
// ========================================

// 32-bit field ceiling: values at it live in the zip64 extra records instead
const U32_MAX = 0xFFFFFFFF;
const U16_MAX = 0xFFFF;

async function parseZip(file) {
    // EOCD sits at the end, preceded by an up-to-64KB comment; scan the tail backwards.
    const tailSize = Math.min(file.size, 65557);
    if (tailSize < 22) throw new Error('Not a zip file');
    const tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
    let eocdPos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
            eocdPos = i;
            break;
        }
    }
    if (eocdPos < 0) throw new Error('Not a zip file (no end-of-central-directory record)');

    const eocd = new DataView(tail.buffer, eocdPos);
    let count = eocd.getUint16(10, true);
    let cdSize = eocd.getUint32(12, true);
    let cdOffset = eocd.getUint32(16, true);

    // Any maxed-out field means the real values live in the zip64 EOCD record,
    // reached via the 20-byte locator immediately preceding the standard EOCD.
    if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
        const locPos = eocdPos - 20;
        if (locPos < 0 || tail[locPos] !== 0x50 || tail[locPos + 1] !== 0x4b || tail[locPos + 2] !== 0x06 || tail[locPos + 3] !== 0x07) {
            throw new Error('Corrupt bundle: zip64 markers present but the locator is missing');
        }
        const zEocdOffset = Number(new DataView(tail.buffer, locPos).getBigUint64(8, true));
        const zBytes = new Uint8Array(await file.slice(zEocdOffset, zEocdOffset + 56).arrayBuffer());
        const z = new DataView(zBytes.buffer);
        if (z.getUint32(0, true) !== 0x06064b50) throw new Error('Corrupt zip64 end-of-central-directory record');
        count = Number(z.getBigUint64(32, true));
        cdSize = Number(z.getBigUint64(40, true));
        cdOffset = Number(z.getBigUint64(48, true));
    }

    const cdBytes = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const cd = new DataView(cdBytes.buffer);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count; i++) {
        if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip central directory');
        const method = cd.getUint16(p + 10, true);
        let compSize = cd.getUint32(p + 20, true);
        let size = cd.getUint32(p + 24, true);
        const nameLen = cd.getUint16(p + 28, true);
        const extraLen = cd.getUint16(p + 30, true);
        const commentLen = cd.getUint16(p + 32, true);
        let localOffset = cd.getUint32(p + 42, true);
        const name = dec.decode(cdBytes.subarray(p + 46, p + 46 + nameLen));

        // Resolve any sentinel'd field from the zip64 extra (header 0x0001); the 8-byte
        // values appear in size / compressed-size / offset order, only the flagged ones.
        if (size === U32_MAX || compSize === U32_MAX || localOffset === U32_MAX) {
            let ep = p + 46 + nameLen;
            const extraEnd = ep + extraLen;
            while (ep + 4 <= extraEnd) {
                const hid = cd.getUint16(ep, true);
                const hlen = cd.getUint16(ep + 2, true);
                if (hid === 0x0001) {
                    let fp = ep + 4;
                    if (size === U32_MAX) { size = Number(cd.getBigUint64(fp, true)); fp += 8; }
                    if (compSize === U32_MAX) { compSize = Number(cd.getBigUint64(fp, true)); fp += 8; }
                    if (localOffset === U32_MAX) { localOffset = Number(cd.getBigUint64(fp, true)); fp += 8; }
                    break;
                }
                ep += 4 + hlen;
            }
        }

        entries.set(name, { method, compSize, size, localOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return { file, entries };
}

async function readZipEntry(zip, name) {
    const e = zip.entries.get(name);
    if (!e) return null;
    // Name/extra lengths must come from the LOCAL header; tools can write a
    // different extra field there than in the central directory.
    const lh = new DataView(await zip.file.slice(e.localOffset, e.localOffset + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error(`Corrupt zip entry: ${name}`);
    const nameLen = lh.getUint16(26, true);
    const extraLen = lh.getUint16(28, true);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const blob = zip.file.slice(start, start + e.compSize);
    if (e.method === 0) return new Uint8Array(await blob.arrayBuffer());
    if (e.method === 8) {
        // Deflate support so bundles re-zipped by external tools still import.
        const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error(`Unsupported zip compression method ${e.method} for ${name}`);
}

// ========================================
// MODAL SHELL
// ========================================

function injectModal() {
    const modalHtml = `
    <div id="batchTransferModal" class="cl-modal cl-modal-drawer cl-drawer-partial">
        <div class="cl-modal-content btx-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-box-archive"></i> <span id="batchTransferTitle">Export</span></h3>
                <button id="batchTransferCloseBtn" class="cl-modal-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body btx-body" id="batchTransferBody"></div>
            <div class="cl-modal-footer btx-footer" id="batchTransferFooter"></div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    CoreAPI.mountDialogSizing('batchTransferModal');

    document.getElementById('batchTransferCloseBtn')?.addEventListener('click', () => closeModal());
    document.getElementById('batchTransferModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'batchTransferModal') closeModal();
    });
}

function setTitle(text) {
    const el = document.getElementById('batchTransferTitle');
    if (el) el.textContent = text;
}

function showModal() {
    document.getElementById('batchTransferModal')?.classList.add('visible');
}

async function closeModal() {
    if (state.running) {
        const confirmed = await CoreAPI.showConfirm({
            title: state.view === 'import-progress' ? 'Cancel import?' : 'Cancel export?',
            message: 'The operation is still running. Cancel and close?',
            icon: 'fa-solid fa-triangle-exclamation',
            iconColor: 'var(--cl-warning-bright)',
            confirmLabel: 'Cancel It',
            cancelLabel: 'Keep Running',
            danger: true,
        });
        if (!confirmed) return;
        state.abort = true;
        state.controller?.abort();
    }
    state.zip = null;
    state.manifest = null;
    state.importFile = null;
    document.getElementById('batchTransferModal')?.classList.remove('visible');
}

// ========================================
// PROGRESS VIEW (shared by export + import)
// ========================================

function renderProgressView() {
    const body = document.getElementById('batchTransferBody');
    const footer = document.getElementById('batchTransferFooter');
    if (!body || !footer) return;
    body.innerHTML = `
        <div class="btx-progress-label" id="btxProgressLabel">Starting...</div>
        <div class="btx-bar"><div class="btx-bar-fill" id="btxBarFill"></div></div>
        <div class="btx-log" id="btxLog"></div>`;
    footer.innerHTML = `
        <button id="btxCancelBtn" class="cl-btn cl-btn-danger-hover"><i class="fa-solid fa-xmark"></i> Cancel</button>`;
    document.getElementById('btxCancelBtn')?.addEventListener('click', (e) => {
        state.abort = true;
        state.controller?.abort();
        CoreAPI.setRunVerb(e.currentTarget, 'stopping');
    });
}

function setProgress(fraction, label) {
    const fill = document.getElementById('btxBarFill');
    if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    const labelEl = document.getElementById('btxProgressLabel');
    if (labelEl && label) labelEl.textContent = label;
}

function logLine(text, level = 'info') {
    const log = document.getElementById('btxLog');
    if (!log) return;
    const line = document.createElement('div');
    line.className = `btx-log-line btx-log-${level}`;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
}

function renderDoneFooter() {
    const footer = document.getElementById('batchTransferFooter');
    if (!footer) return;
    footer.innerHTML = `<button id="btxDoneBtn" class="cl-btn cl-btn-secondary"><i class="fa-solid fa-xmark"></i> Close</button>`;
    document.getElementById('btxDoneBtn')?.addEventListener('click', () => closeModal());
}

// ========================================
// EXPORT: CHOOSER
// ========================================

function openExportChooser() {
    if (!isInitialized) return;
    const count = CoreAPI.getSelectionCount();
    if (!count) {
        CoreAPI.showToast('No characters selected', 'warning');
        return;
    }

    state.view = 'chooser';
    setTitle(`Export ${count.toLocaleString()} Character${count !== 1 ? 's' : ''}`);

    const linksDefault = !!CoreAPI.getSetting('exportAsLinks');
    const defaultBadge = '<span class="btx-default-badge">Default</span>';
    const body = document.getElementById('batchTransferBody');
    const footer = document.getElementById('batchTransferFooter');
    if (!body || !footer) return;

    body.innerHTML = `
        <div class="btx-options">
            <button class="btx-option" data-mode="bundle">
                <i class="fa-solid fa-box-archive"></i>
                <div class="btx-option-text">
                    <div class="btx-option-title">Full Bundle (.zip)</div>
                    <div class="btx-option-desc">Cards, all chats, and gallery media in one archive, for moving to another Project Σ. An extension's own data (ratings, notes, trackers) does not travel in it.</div>
                </div>
            </button>
            <button class="btx-option" data-mode="pngs">
                <i class="fa-solid fa-file-image"></i>
                <div class="btx-option-text">
                    <div class="btx-option-title">Character Cards (.png) ${linksDefault ? '' : defaultBadge}</div>
                    <div class="btx-option-desc">Download each card as a separate PNG file</div>
                </div>
            </button>
            <button class="btx-option" data-mode="links">
                <i class="fa-solid fa-link"></i>
                <div class="btx-option-text">
                    <div class="btx-option-title">Provider Links ${linksDefault ? defaultBadge : ''}</div>
                    <div class="btx-option-desc">Copy the source URLs of linked characters to the clipboard</div>
                </div>
            </button>
        </div>
        <label class="btx-worlds-check">
            <input type="checkbox" id="btxIncludeWorlds" checked>
            <span>Include linked lorebooks in the full bundle</span>
        </label>`;
    footer.innerHTML = '';

    body.querySelectorAll('.btx-option').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            if (mode === 'bundle') {
                const includeWorlds = !!document.getElementById('btxIncludeWorlds')?.checked;
                runBundleExport(CoreAPI.getSelection(), includeWorlds);
                return;
            }
            runCardsExport(CoreAPI.getSelection(), mode === 'links' ? 'links' : 'png');
        });
    });

    showModal();
}

// ========================================
// EXPORT: BUNDLE
// ========================================

// a selection as a command's args: the ids picked by hand, or a Select All's filter
const selectionArgs = (selection) => (selection.filter !== undefined ? { filter: selection.filter } : { ids: selection.ids });

async function runBundleExport(selection, includeWorlds) {
    state.view = 'export-progress';
    state.running = true;
    state.abort = false;
    state.controller = new AbortController();

    setTitle('Exporting Bundle');
    renderProgressView();
    setProgress(0.3, `Building bundle for ${selection.count.toLocaleString()} character${selection.count !== 1 ? 's' : ''}...`);
    logLine('The server assembles the archive: cards with chunks embedded fresh, chats as JSONL, gallery files' + (includeWorlds ? ', lorebooks' : ''));

    try {
        const result = await runCommand('character.export', {
            ...selectionArgs(selection), format: 'bundle', worlds: !!includeWorlds, signal: state.controller.signal,
        });
        const count = result?.count ?? (result?.exported || []).length;
        const missed = result?.skippedCount ?? (result?.skipped || []).length;
        if (count) {
            setProgress(1, 'Bundle downloaded');
            logLine(`Exported ${count} character${count !== 1 ? 's' : ''} (${CoreAPI.formatBytes(result?.bytes || 0)})`, 'success');
        } else {
            setProgress(1, 'Nothing exported');
            logLine('No file was downloaded', 'warn');
        }
        if (missed) logLine(`${missed} character${missed !== 1 ? 's were' : ' was'} left out: the server could not read ${missed !== 1 ? 'their pictures or cards' : 'its picture or card'}`, 'warn');
        renderDoneFooter();
    } catch (err) {
        if (state.abort || err?.name === 'AbortError') {
            setProgress(1, 'Export cancelled');
            logLine('Cancelled; no file was downloaded', 'warn');
        } else {
            setProgress(1, 'Export failed');
            logLine(err.message || String(err), 'error');
        }
        renderDoneFooter();
    } finally {
        state.running = false;
        state.controller = null;
    }
}

// the bundle behind character.export: one server call builds the archive over { ids } or a filter's set
async function exportBundleNow(target, { worlds = true, signal } = {}) {
    const byFilter = target?.filter !== undefined;
    const resp = await CoreAPI.apiRequest('/bundle/export', 'POST', { ...(byFilter ? { filter: target.filter } : { ids: target.ids }), include: { worlds: !!worlds } }, { signal });
    // spelled here, not readAnswer: an answer is the archive's bytes, so only a refusal is read as JSON
    if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        throw new Error(err?.error || `bundle export failed (HTTP ${resp.status})`);
    }
    const blob = await resp.blob();
    // a cancel that lands while the archive streams in still saves nothing
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    CoreAPI.downloadBlobAsFile(blob, `cl-bundle-${new Date().toISOString().slice(0, 10)}.zip`);
    // what the server could not carry (a picture or a card gone) is skipped, never reported exported
    const skipped = (resp.headers.get('X-Bundle-Skipped') || '').split(',').filter(Boolean);
    const skippedCount = Number(resp.headers.get('X-Bundle-Skipped-Count')) || skipped.length;
    if (byFilter) return { count: Number(resp.headers.get('X-Bundle-Count')) || 0, skippedCount, bytes: blob.size };
    const left = new Set(skipped);
    return { exported: target.ids.filter(id => !left.has(id)), skipped, skippedCount, bytes: blob.size };
}

// ========================================
// EXPORT: CARDS AND LINKS
// ========================================

// the selection's cards as PNGs (or its provider links as one list) via character.export, with a Cancel between files
async function runCardsExport(selection, format) {
    const links = format === 'links';
    state.view = 'export-progress';
    state.running = true;
    state.abort = false;
    state.controller = new AbortController();

    setTitle(links ? 'Copying Provider Links' : 'Exporting Cards');
    renderProgressView();
    showModal();
    const total = selection.count;
    const of = (n) => `${n.toLocaleString()} of ${total.toLocaleString()}`;
    setProgress(0, links ? `Reading the links of ${total.toLocaleString()} character${total !== 1 ? 's' : ''}...` : `Downloading ${of(0)}...`);

    try {
        const result = await runCommand('character.export', {
            ...selectionArgs(selection), format, signal: state.controller.signal,
            onProgress: (done) => setProgress(total ? done / total : 1, links ? `Read ${of(done)}` : `Downloaded ${of(done)}`),
        });
        const count = result?.count ?? (result?.exported || []).length;
        const missed = result?.skippedCount ?? (result?.skipped || []).length;
        if (links) {
            setProgress(1, count ? `${count.toLocaleString()} link${count !== 1 ? 's' : ''} copied to the clipboard` : 'No linked characters to export');
            if (missed) logLine(`${missed.toLocaleString()} unlinked character${missed !== 1 ? 's were' : ' was'} skipped`, 'warn');
        } else {
            setProgress(1, `Exported ${of(count)} character${total !== 1 ? 's' : ''}`);
            if (missed) logLine(`${missed.toLocaleString()} could not be downloaded`, 'warn');
        }
        logLine(links ? (count ? 'Copied' : 'The clipboard was left alone') : `Downloaded ${count.toLocaleString()} file${count !== 1 ? 's' : ''}`, count ? 'success' : 'warn');
    } catch (err) {
        if (state.abort || err?.name === 'AbortError') {
            setProgress(1, 'Export cancelled');
            logLine(links ? 'Cancelled; nothing was copied' : 'Cancelled; the files already downloaded stay', 'warn');
        } else {
            setProgress(1, 'Export failed');
            logLine(err.message || String(err), 'error');
        }
    } finally {
        state.running = false;
        state.controller = null;
        renderDoneFooter();
    }
}

// ========================================
// IMPORT: REVIEW
// ========================================

async function openImportReview(file) {
    if (!isInitialized || !file) return;

    state.view = 'import-review';
    state.importSourceName = file.name || 'bundle.zip';
    setTitle('Import Bundle');

    const body = document.getElementById('batchTransferBody');
    const footer = document.getElementById('batchTransferFooter');
    if (!body || !footer) return;
    body.innerHTML = '<div class="btx-progress-label">Reading bundle...</div>';
    footer.innerHTML = '';
    showModal();

    try {
        const zip = await parseZip(file);
        const manifestBytes = await readZipEntry(zip, 'manifest.json');
        if (!manifestBytes) throw new Error('Not a Project Σ bundle (manifest.json missing)');
        const manifest = tryParseJson(dec.decode(manifestBytes));
        if (!manifest || !Array.isArray(manifest.characters)) {
            throw new Error('Unsupported or corrupt bundle manifest');
        }
        // v1 packs keyed characters by filename and cannot be collision-checked or
        // snapshotted safely; the extension era is the migration tool's job now
        if (manifest.version !== 2 || manifest.characters.some(c => !c?.uid)) {
            throw new Error('This bundle was exported by an older Project Σ or the SillyTavern extension. '
                + 'Re-export it from a current install, or use the SillyTavern migration tool for extension-era data.');
        }
        state.zip = zip;
        state.manifest = manifest;
        state.importFile = file; // the raw File re-uploads verbatim on Import
        // uuids travel, so "already in library" is id equality (provider-link matches are the server snapshot's)
        state.existingIds = new Set(
            (await CoreAPI.fetchCharactersByIds(manifest.characters.map(c => c.uid))).map(c => c.id),
        );
        renderImportReview();
    } catch (err) {
        body.innerHTML = `<div class="btx-error"><i class="fa-solid fa-triangle-exclamation"></i> ${CoreAPI.escapeHtml(err.message || String(err))}</div>`;
        renderDoneFooter();
    }
}

function renderImportReview() {
    const { manifest } = state;
    const body = document.getElementById('batchTransferBody');
    const footer = document.getElementById('batchTransferFooter');
    if (!body || !footer) return;

    const existingIds = state.existingIds || new Set();
    const worldCount = Array.isArray(manifest.worlds) ? manifest.worlds.length : 0;
    // a pack without the worlds scope still carries aux-link refs; without this count they'd be silently unrestorable
    const auxRefCount = manifest.characters.reduce((n, e) => n + (Array.isArray(e.auxWorlds) ? e.auxWorlds.length : 0), 0);

    const rows = manifest.characters.map((entry, idx) => {
        const exists = existingIds.has(entry.uid);
        const chats = (entry.chatFiles || []).length;
        const files = (entry.galleryFiles || []).length;
        return `
        <label class="btx-review-row">
            <input type="checkbox" class="btx-review-check" data-index="${idx}" checked>
            <div class="btx-review-info">
                <div class="btx-review-name">${CoreAPI.escapeHtml(entry.name || entry.file)}${exists ? '<span class="btx-exists-badge">In library</span>' : ''}</div>
                <div class="btx-review-meta">${chats} chat${chats !== 1 ? 's' : ''} · ${files} gallery file${files !== 1 ? 's' : ''}</div>
            </div>
        </label>`;
    }).join('');

    body.innerHTML = `
        <div class="btx-review-header">${manifest.characters.length} character${manifest.characters.length !== 1 ? 's' : ''} in "${CoreAPI.escapeHtml(state.importSourceName)}"</div>
        <div class="btx-review-list">${rows}</div>
        <div class="btx-policy">
            <div class="btx-policy-title">Imports never overwrite: an identical character is reused (its new chats and gallery still attach), and one that diverged from your copy is skipped and listed so you can bring it in as a copy afterwards.</div>
        </div>
        ${(worldCount || auxRefCount) ? `
        <label class="btx-worlds-check">
            <input type="checkbox" id="btxImportWorlds" checked>
            <span>${worldCount
                ? `Import ${worldCount} bundled lorebook${worldCount !== 1 ? 's' : ''} (identical books are reused; a different book with the same name imports as "Name (2)")`
                : `Restore ${auxRefCount} additional-lorebook link${auxRefCount !== 1 ? 's' : ''} (no book files in this bundle; links only apply to books already on this instance)`}</span>
        </label>` : ''}`;

    footer.innerHTML = `
        <button id="btxReviewCancelBtn" class="cl-btn cl-btn-secondary">Cancel</button>
        <button id="btxReviewImportBtn" class="cl-btn cl-btn-primary"><i class="fa-solid fa-download"></i> Import</button>`;

    document.getElementById('btxReviewCancelBtn')?.addEventListener('click', () => closeModal());
    document.getElementById('btxReviewImportBtn')?.addEventListener('click', () => {
        runBundleImport().catch(err => {
            setProgress(1, 'Import failed');
            logLine(err.message || String(err), 'error');
        }).finally(() => {
            // Backstop so a thrown error cant leave the modal stuck in running state
            if (state.running) {
                state.running = false;
                renderDoneFooter();
            }
        });
    });
}

// ========================================
// IMPORT: RUN
// ========================================

async function runBundleImport() {
    const { manifest, importFile } = state;
    if (!manifest || !importFile) return;

    const checked = [...document.querySelectorAll('.btx-review-check:checked')].map(cb => Number(cb.dataset.index));
    const entries = checked.map(i => manifest.characters[i]).filter(e => e && e.uid);
    if (entries.length === 0) {
        CoreAPI.showToast('No characters selected for import', 'warning');
        return;
    }
    const includeWorlds = !!document.getElementById('btxImportWorlds')?.checked;

    state.view = 'import-progress';
    state.running = true;
    state.abort = false;
    setTitle('Importing Bundle');
    renderProgressView();

    await uploadBundle(entries, { includeWorlds });
}

// One upload; the server owns the whole no-overwrite triage (new / identical-attach /
// diverged-skip). copyUids re-requests specific diverged entries as forced copies.
async function uploadBundle(entries, { includeWorlds, copyUids = null }) {
    const { manifest, importFile } = state;
    setProgress(0.4, `Importing ${entries.length} character${entries.length !== 1 ? 's' : ''}...`);
    logLine('Uploading bundle to the server...');
    const params = new URLSearchParams({ worlds: includeWorlds ? 'true' : 'false' });
    if (entries.length !== manifest.characters.length) {
        params.set('only', entries.map(e => e.uid).join(','));
    }
    if (copyUids?.length) params.set('copy', copyUids.join(','));

    // Cancel ends the upload (the server keeps nothing of a half-received pack) or the restore before its next entry
    state.controller = new AbortController();
    let summary = null;
    try {
        summary = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/bundle/import?${params}`, 'POST', importFile,
            { raw: true, headers: { 'Content-Type': 'application/zip' }, signal: state.controller.signal }));
    } catch (err) {
        state.running = false;
        if (state.abort || err?.name === 'AbortError') {
            setProgress(1, 'Import cancelled');
            logLine('Cancelled; any characters the server had already restored stay in your library', 'warn');
            try { await CoreAPI.refreshCharacters(true, { held: true }); } catch (_) { /* next view entry heals */ }
        } else {
            setProgress(1, 'Import failed');
            logLine(err.message || String(err), 'error');
        }
        renderDoneFooter();
        return;
    } finally {
        state.controller = null;
    }

    for (const r of summary.worldsRenamed || []) {
        logLine(`Lorebook "${r.from}" differs from the existing book of that name; imported as "${r.to}"`, 'warn');
    }
    for (const d of summary.diverged || []) {
        logLine(`${d.name || d.uid}: differs from a character already in your library; skipped (nothing was changed)`, 'warn');
    }
    for (const e of summary.errors || []) {
        logLine(`${e.character || e.world || 'entry'}: ${e.error}`, 'error');
    }

    // grid + held rows resync from the server's post-import truth (an import can rewrite a row this tab holds)
    try { await CoreAPI.refreshCharacters(true, { held: true }); } catch (_) { /* next view entry heals */ }

    setProgress(1, 'Import complete');
    const bits = [`Imported ${summary.imported}`];
    if (summary.identical) bits.push(`${summary.identical} already here (new chats/media attached)`);
    if (summary.diverged?.length) bits.push(`${summary.diverged.length} diverged, skipped`);
    if (summary.errors?.length) bits.push(`${summary.errors.length} failed`);
    logLine(`${bits.join(', ')} (${summary.chats} chats, ${summary.media} gallery files${summary.worlds ? `, ${summary.worlds} lorebooks` : ''})`,
        summary.errors?.length ? 'warn' : 'success');
    state.running = false;

    // the per-entry override: bring the skipped diverged versions in as copies
    if (summary.diverged?.length && !state.abort) {
        const footer = document.getElementById('batchTransferFooter');
        if (footer) {
            footer.innerHTML = `
                <button id="btxDivergedBtn" class="cl-btn cl-btn-secondary"><i class="fa-solid fa-clone"></i> Import ${summary.diverged.length} Diverged as ${summary.diverged.length !== 1 ? 'Copies' : 'Copy'}</button>
                <button id="btxDoneBtn" class="cl-btn cl-btn-secondary"><i class="fa-solid fa-xmark"></i> Close</button>`;
            document.getElementById('btxDoneBtn')?.addEventListener('click', () => closeModal());
            document.getElementById('btxDivergedBtn')?.addEventListener('click', async () => {
                const uids = summary.diverged.map(d => String(d.uid));
                const divergedEntries = state.manifest.characters.filter(c => uids.includes(String(c.uid)));
                state.running = true;
                renderProgressView();
                await uploadBundle(divergedEntries, { includeWorlds, copyUids: uids });
            });
            return;
        }
    }
    renderDoneFooter();
}

// ========================================
// INIT
// ========================================

function init() {
    if (isInitialized) {
        console.warn('[BatchTransfer] Already initialized');
        return;
    }
    injectModal();
    window.registerOverlay?.({
        id: 'batchTransferModal',
        tier: 7,
        close: () => closeModal(),
        visible: (el) => el.classList.contains('visible'),
    });
    isInitialized = true;
    CoreAPI.debugLog('[BatchTransfer] Module initialized');
}

export default {
    init,
    openExportChooser,
    runCardsExport,
    openImportReview,
    exportBundleNow,
};
