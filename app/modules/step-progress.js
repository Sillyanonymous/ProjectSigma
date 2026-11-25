// The step list and the bar under it: one renderer for every long job a surface follows (the app update, the SillyTavern migration)

const STEP_ICONS = { done: 'fa-solid fa-circle-check', active: 'fa-solid fa-circle-notch fa-spin', waiting: 'fa-regular fa-circle', skipped: 'fa-solid fa-circle-minus', failed: 'fa-solid fa-circle-xmark', warn: 'fa-solid fa-circle-exclamation' };

// time left is said once a job has run long enough to measure, and only when there is enough of it to matter
const ETA_AFTER_MS = 3000;
const ETA_MIN_MS = 10000;

const fmtLeft = (ms) => (ms >= 90000 ? `about ${Math.round(ms / 60000)} min left` : `about ${Math.max(5, Math.round(ms / 5000) * 5)} s left`);

/**
 * The time left from the first sample of a measured job and where it stands now; '' until it has run 3 s, and under 10 s left.
 * @param {{t: number, done: number}|null} first
 */
export function timeLeft(first, done, total, now) {
    if (!first || !total || now - first.t < ETA_AFTER_MS || !(done > first.done)) return '';
    const left = (total - done) / ((done - first.done) / (now - first.t));
    return left >= ETA_MIN_MS ? fmtLeft(left) : '';
}

/** The block's markup: the steps, then what runs now (its bar, its words, the time left, a hint); each hook is data-{p}-name. */
export function progressBlockHtml(p) {
    return `
        <ol class="cl-steps" data-${p}-steps></ol>
        <div class="cl-progress-now" data-${p}-now aria-live="polite">
            <div class="import-progress-bar" data-${p}-bar><div class="import-progress-fill" data-${p}-fill></div></div>
            <div class="cl-progress-now-text"><span data-${p}-what></span><span class="cl-progress-eta" data-${p}-eta></span></div>
            <div class="cl-progress-hint" data-${p}-hint hidden></div>
        </div>`;
}

const stepBodyHtml = (st, esc) => `
                <div class="cl-step-name">${esc(st.name)}${st.count ? `<span class="cl-step-count">${esc(st.count)}</span>` : ''}</div>
                ${st.sub ? `<div class="cl-step-sub">${esc(st.sub)}</div>` : ''}`;

const stepRowHtml = (st, esc) => `
        <li class="cl-step is-${st.state}">
            <span class="cl-step-icon"><i class="${STEP_ICONS[st.state]}" aria-hidden="true"></i></span>
            <div class="cl-step-body">${stepBodyHtml(st, esc)}
            </div>
        </li>`;

// what each row's body last showed, so an unchanged one is left alone
const paintedBody = new WeakMap();

/**
 * Draw the steps and the bar into a block progressBlockHtml(p) made.
 * @param {{steps: Array<{name: string, state: string, count?: string, sub?: string}>, bar: {kind: 'none'|'busy'|'measured', pct: number, what: string, eta: string, hint: string}, failed?: boolean}} view
 * @param {(s: string) => string} esc
 */
export function paintProgress(root, p, { steps, bar, failed = false }, esc) {
    const q = (name) => root.querySelector(`[data-${p}-${name}]`);
    const list = q('steps');
    const rows = [...list.children];
    if (rows.length !== steps.length) list.innerHTML = steps.map(st => stepRowHtml(st, esc)).join('');
    // patched in place, never rewritten: a rewrite each second restarts the active step's spinner
    else steps.forEach((st, i) => {
        const row = rows[i];
        const cls = `cl-step is-${st.state}`;
        if (row.className !== cls) row.className = cls;
        const icon = row.querySelector('.cl-step-icon i');
        if (icon && icon.className !== STEP_ICONS[st.state]) icon.className = STEP_ICONS[st.state];
        const body = row.querySelector('.cl-step-body');
        const html = stepBodyHtml(st, esc);
        if (body && paintedBody.get(body) !== html) { body.innerHTML = html; paintedBody.set(body, html); }
    });
    const now = q('now');
    now.classList.toggle('is-busy', bar.kind === 'busy');
    now.classList.toggle('is-failed', failed);
    q('bar').hidden = bar.kind === 'none';
    q('fill').style.width = bar.kind === 'measured' ? `${bar.pct}%` : '';
    q('what').textContent = bar.what;
    q('eta').textContent = bar.eta;
    const hint = q('hint');
    hint.textContent = bar.hint;
    hint.hidden = !bar.hint;
}
