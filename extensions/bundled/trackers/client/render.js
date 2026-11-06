// SPDX-License-Identifier: MIT

// A tracker's state as HTML, derived from its fields: the kind is the component, the role the weight.
// Every value goes through esc.
import { filled, updateOf, UNLISTED } from './model.js';

// the host's escapeHtml, handed in by the entry: this module never reaches ctx, and keeps no escape of its own
let esc = null;
export function setEscaper(fn) { if (typeof fn === 'function') esc = fn; }

let avatarFor = () => null;
/** name -> a picture url when the window can resolve one (the chat's own character), else null */
export function setAvatarResolver(fn) { avatarFor = typeof fn === 'function' ? fn : () => null; }

const roleOf = (f) => (['headline', 'badge', 'detail'].includes(f.role) ? f.role : 'detail');
const isBounded = (f) => Number.isFinite(f.min) && Number.isFinite(f.max) && f.max > f.min;

/**
 * One tracker's state; empty fields are left out, and a manual field is an input when editable, keyed by its JSON path.
 */
export function stateHtml(def, state, { editable = false } = {}) {
    const body = fieldsHtml(def.fields, state, [], editable);
    if (!body.trim()) {
        return `<div class="tkr-blank"><i class="fa-solid fa-hourglass-start" aria-hidden="true"></i>
            <span>Nothing kept yet. It fills in after the next reply, or when you press Update Now.</span></div>`;
    }
    return body + extraHtml(state);
}

// a field list split the way a card wants it: headline, badges, meters, stats, blocks, the rest
function partition(fields, data) {
    const p = { headline: null, badges: [], meters: [], stats: [], blocks: [], details: [] };
    for (const f of Array.isArray(fields) ? fields : []) {
        const v = data?.[f.key];
        const role = roleOf(f);
        if (role === 'headline' && !p.headline && filled(v) && typeof v !== 'object') { p.headline = [f, v]; continue; }
        if (role === 'badge') { if (filled(v)) p.badges.push([f, v]); continue; }
        if (f.kind === 'number' && isBounded(f)) { if (filled(v)) p.meters.push([f, v]); continue; }
        if (f.kind === 'number') { if (filled(v)) p.stats.push([f, v]); continue; }
        if (f.kind === 'group' || f.kind === 'rows' || f.kind === 'per-character') { p.blocks.push([f, v]); continue; }
        p.details.push([f, v]);
    }
    return p;
}

function fieldsHtml(fields, data, path, editable) {
    const p = partition(fields, data);
    const out = [];
    if (p.headline) out.push(`<p class="tkr-headline">${esc(p.headline[1])}</p>`);
    if (p.badges.length) out.push(`<div class="tkr-pills">${p.badges.map(([f, v]) => badgeHtml(f, v)).join('')}</div>`);
    if (p.meters.length) out.push(`<div class="tkr-meters">${p.meters.map(([f, v]) => meterHtml(f, v)).join('')}</div>`);
    if (p.stats.length) out.push(`<div class="tkr-stats">${p.stats.map(([f, v]) => statHtml(f, v)).join('')}</div>`);
    const details = p.details.map(([f, v]) => detailHtml(f, v, [...path, f.key], editable)).filter(Boolean);
    if (details.length) out.push(`<div class="tkr-details">${details.join('')}</div>`);
    for (const [f, v] of p.blocks) {
        const here = [...path, f.key];
        if (f.kind === 'group') {
            const inner = fieldsHtml(f.fields, v, here, editable);
            if (inner) out.push(sectionHtml(f, inner));
        } else if (f.kind === 'rows') {
            if (filled(v)) out.push(sectionHtml(f, itemsHtml(f, v)));
        } else if (filled(v)) {
            out.push(sectionHtml(f, castHtml(f, v, here, editable)));
        }
    }
    return out.join('');
}

// a bounded number: severity in thirds by tone; a range crossing zero fills from the centre and shows its sign
function meterHtml(f, value) {
    const n = Number(value);
    const { min, max } = f;
    const diverging = min < 0 && max > 0;
    const clamped = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
    const frac = (clamped - min) / (max - min);
    let fill;
    if (diverging) {
        const half = Math.max(Math.abs(min), Math.abs(max));
        const width = (Math.abs(clamped) / half) * 50;
        const left = clamped >= 0 ? 50 : 50 - width;
        fill = `<span class="tkr-meter-fill is-${severity(f, frac)}" style="left:${left}%;width:${width}%"></span>`;
    } else {
        fill = `<span class="tkr-meter-fill is-${severity(f, frac)}" style="left:0;width:${frac * 100}%"></span>`;
    }
    const num = diverging
        ? `${clamped > 0 ? '+' : ''}${esc(clamped)}`
        : `${esc(clamped)}<span class="tkr-meter-max">/${esc(max)}</span>`;
    return `<div class="tkr-meter">
        <div class="tkr-meter-head"><span class="tkr-meter-name">${esc(f.label || f.key)}</span><span class="tkr-meter-num">${num}</span></div>
        <div class="tkr-meter-track${diverging ? ' is-diverging' : ''}">${fill}</div>
    </div>`;
}

// good, fair or bad by thirds; the plain accent when the field does not say which end is good
function severity(f, frac) {
    if (f.tone !== 'good-high' && f.tone !== 'good-low') return 'plain';
    const good = f.tone === 'good-high' ? frac : 1 - frac;
    if (good >= 0.66) return 'good';
    return good >= 0.33 ? 'fair' : 'bad';
}

function statHtml(f, value) {
    return `<div class="tkr-stat"><span class="tkr-stat-num">${esc(value)}</span><span class="tkr-stat-label">${esc(f.label || f.key)}</span></div>`;
}

// a chip by the name; an alarm only where the field says its good end is low (a mood is not news)
function badgeHtml(f, value) {
    const cls = f.tone === 'good-low' ? 'tkr-pill is-alert' : 'tkr-pill is-on';
    if (f.kind === 'boolean') return value === true ? `<span class="${cls}">${esc(f.label || f.key)}</span>` : '';
    if (Array.isArray(value)) return value.map(v => `<span class="${cls}">${esc(v)}</span>`).join('');
    return `<span class="${cls}">${esc(value)}</span>`;
}

const pillHtml = (text, on) => `<span class="tkr-pill${on ? ' is-on' : ''}">${esc(text)}</span>`;
const chipHtml = (text) => `<span class="tkr-chip">${esc(text)}</span>`;

// a caption with its value flowing after it, never a label column (a column is a spreadsheet)
function detailHtml(f, value, path, editable) {
    const editing = editable && updateOf(f) === 'never' && (f.kind === 'text' || f.kind === 'choice' || !f.kind);
    if (!filled(value) && !editing) return '';
    const label = `<span class="tkr-dlabel">${esc(f.label || f.key)}</span>`;
    if (editing) {
        // the path rides as JSON: a name inside a card is the model's, and may hold a dot
        const at = esc(JSON.stringify(path));
        const control = f.kind === 'choice'
            // a choice is its options and nothing else, so it is chosen, never typed
            ? `<select class="cl-select-fluid tkr-field-select" data-tkr-field="${at}" aria-label="${esc(f.label || f.key)}"><option value=""${filled(value) ? '' : ' selected'}>Not set</option>${
                (f.options || []).map(o => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
            : `<input type="search" autocomplete="one-time-code" class="cl-cwin-input tkr-field-input" data-tkr-field="${at}" value="${esc(value)}" placeholder="Yours to fill in" aria-label="${esc(f.label || f.key)}">`;
        return `<div class="tkr-detail is-manual">${label}${control}</div>`;
    }
    switch (f.kind) {
        case 'choice': return `<div class="tkr-detail">${label}${pillHtml(value, true)}</div>`;
        case 'boolean': return `<div class="tkr-detail">${label}${pillHtml(value ? 'yes' : 'no', value === true)}</div>`;
        case 'list': return `<div class="tkr-detail">${label}${(Array.isArray(value) ? value : []).map(chipHtml).join('')}</div>`;
        default: return `<div class="tkr-detail">${label}<span class="tkr-dvalue">${esc(value)}</span></div>`;
    }
}

// a repeating group: a line per entry, its first text as the name, its first number as a badge
function itemsHtml(f, rows) {
    const list = Array.isArray(rows) ? rows : [];
    const numKey = (f.fields || []).find(c => c.kind === 'number')?.key;
    const nameKey = (f.fields || []).find(c => c.kind === 'text')?.key;
    return `<div class="tkr-items">${list.map((row) => {
        const rest = (f.fields || []).filter(c => c.key !== numKey && c.key !== nameKey && filled(row?.[c.key]))
            .map(c => esc(Array.isArray(row[c.key]) ? row[c.key].join(', ') : row[c.key]));
        return `<div class="tkr-item">
            <span class="tkr-item-name">${esc(row?.[nameKey] ?? '')}</span>
            ${rest.length ? `<span class="tkr-item-note">${rest.join(' · ')}</span>` : ''}
            ${numKey && filled(row?.[numKey]) ? `<span class="tkr-item-qty">${esc(row[numKey])}</span>` : ''}
        </div>`;
    }).join('')}</div>`;
}

// a card per character: face or initials, name, headline, badges, then bars and the rest, nothing repeated
function castHtml(f, people, path, editable) {
    return `<div class="tkr-cast">${Object.keys(people || {}).map((who) => {
        const p = partition(f.fields, people[who]);
        const url = avatarFor(who);
        const mark = url
            ? `<img class="tkr-person-face" src="${esc(url)}" alt="" loading="lazy">`
            : `<span class="tkr-person-mark" aria-hidden="true">${esc(initials(who))}</span>`;
        const rest = (f.fields || []).filter(x => roleOf(x) !== 'headline' && roleOf(x) !== 'badge');
        const inner = fieldsHtml(rest, people[who], [...path, who], editable);
        return `<article class="tkr-person">
            <header class="tkr-person-head">
                ${mark}
                <div class="tkr-person-id">
                    <span class="tkr-person-name">${esc(who)}</span>
                    ${p.headline ? `<span class="tkr-person-sub">${esc(p.headline[1])}</span>` : ''}
                </div>
                ${p.badges.length ? `<span class="tkr-person-badges">${p.badges.map(([bf, bv]) => badgeHtml(bf, bv)).join('')}</span>` : ''}
            </header>
            ${inner ? `<div class="tkr-person-body">${inner}</div>` : ''}
        </article>`;
    }).join('')}</div>`;
}

// letters and digits only: a model keys a character by anything, and "Ada <b>" is not an A<
const initials = (name) => (String(name).match(/[\p{L}\p{N}]+/gu) || []).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

const sectionHtml = (f, inner) => `<section class="tkr-section"><h5 class="tkr-section-title">${esc(f.label || f.key)}</h5>${inner}</section>`;

// what the model added with no field for it: shown, since it is usually a missing field, never sent to the story
function extraHtml(state) {
    const extra = collectExtra(state);
    if (!extra.length) return '';
    return `<details class="tkr-extra">
        <summary>${esc(extra.length)} thing${extra.length === 1 ? '' : 's'} the model added</summary>
        ${extra.map(([k, v]) => `<div class="tkr-detail"><span class="tkr-dlabel">${esc(k)}</span><span class="tkr-dvalue">${esc(short(v))}</span></div>`).join('')}
        <p class="tkr-none">The definition has no field for these, so they are kept here and never sent to the story.</p>
    </details>`;
}

function collectExtra(node, prefix = '', out = []) {
    if (!node || typeof node !== 'object') return out;
    for (const [k, v] of Object.entries(node)) {
        if (k === UNLISTED && v && typeof v === 'object') {
            for (const [ek, ev] of Object.entries(v)) out.push([prefix ? `${prefix}.${ek}` : ek, ev]);
        } else if (v && typeof v === 'object') {
            collectExtra(v, prefix ? `${prefix}.${k}` : k, out);
        }
    }
    return out;
}

const short = (v) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 160 ? `${s.slice(0, 157)}...` : s;
};
