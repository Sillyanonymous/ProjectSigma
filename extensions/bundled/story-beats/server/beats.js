// Story Beats' model: a chat's beats as its slot keeps them, their lifecycle, and the direction the prompt carries.
import crypto from 'node:crypto';
import { WEIGHTS, STATUSES, TITLE_MAX, DIRECTIVE_MAX, REASON_MAX, beatCount } from '../client/limits.js';

export const VERBS = Object.freeze({ soft: 'consider', firm: 'should', hard: 'must' });
const RANK = { soft: 0, firm: 1, hard: 2 };
const ID_RE = /^b_[0-9a-f]{8}$/;

// the statuses each one may become by the reader's hand; only the director suggests
const NEXT = {
    pending: ['active', 'skipped'],
    active: ['pending', 'satisfied', 'skipped'],
    suggested: ['active', 'pending', 'skipped'],
    satisfied: ['active', 'pending'],
    skipped: ['active', 'pending'],
};

export const clip = (text, max) => {
    const s = String(text ?? '').trim();
    return s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s;
};

/** A message a pass or a beat is counted from: its own id and its place then, or null. */
export const markOf = (m) => (m && Number.isInteger(m.id) && Number.isInteger(m.seq) ? { id: m.id, seq: m.seq } : null);

export const newBeatId = () => `b_${crypto.randomBytes(4).toString('hex')}`;

/** One beat as the slot keeps it; null for anything that is not one. */
export function normalizeBeat(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
    const status = STATUSES.includes(raw.status) ? raw.status : 'pending';
    return {
        id: raw.id,
        title: typeof raw.title === 'string' ? raw.title.slice(0, TITLE_MAX) : '',
        directive: typeof raw.directive === 'string' ? raw.directive.slice(0, DIRECTIVE_MAX) : '',
        weight: WEIGHTS.includes(raw.weight) ? raw.weight : 'soft',
        status,
        dependsOn: Array.isArray(raw.dependsOn) ? [...new Set(raw.dependsOn.filter(d => typeof d === 'string' && d !== raw.id))] : [],
        fadeAfter: beatCount('fadeAfter', raw.fadeAfter),
        maxMessages: beatCount('maxMessages', raw.maxMessages),
        activatedAt: status === 'active' ? markOf(raw.activatedAt) : null,
        faded: status === 'active' && raw.faded === true,
        suggestion: status === 'suggested' && typeof raw.suggestion === 'string' ? raw.suggestion.slice(0, REASON_MAX) : null,
    };
}

/** A chat's slot as Story Beats reads it: the beats in authoring order and the director's state. */
export function normalizeSlot(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const seen = new Set();
    const beats = (Array.isArray(r.beats) ? r.beats : []).map(normalizeBeat).filter(b => b && !seen.has(b.id) && seen.add(b.id));
    const ids = new Set(beats.map(b => b.id));
    for (const b of beats) b.dependsOn = b.dependsOn.filter(d => ids.has(d));
    const d = r.director && typeof r.director === 'object' ? r.director : {};
    return {
        beats,
        director: {
            mark: markOf(d.mark),
            tension: typeof d.tension === 'number' && Number.isFinite(d.tension) ? d.tension : null,
            summary: typeof d.summary === 'string' ? d.summary : '',
            at: Number.isInteger(d.at) ? d.at : null,
        },
    };
}

/** The beats a beat still waits on: the ones it depends on that are not satisfied yet. */
export const waitsOn = (beat, beats) => beat.dependsOn.filter(id => beats.some(b => b.id === id && b.status !== 'satisfied'));

/** The first pending beat in authoring order whose dependencies are all satisfied. */
export const nextReady = (beats) => beats.find(b => b.status === 'pending' && !waitsOn(b, beats).length) || null;

/** Whether a dependency list would make beats wait on one another. */
export function makesCycle(beats, id, dependsOn) {
    const deps = new Map(beats.map(b => [b.id, b.id === id ? dependsOn : b.dependsOn]));
    const seen = new Set();
    const walk = (at) => {
        if (at === id) return true;
        if (seen.has(at)) return false;
        seen.add(at);
        return (deps.get(at) || []).some(walk);
    };
    return dependsOn.some(walk);
}

/** A status the beat takes, its counters starting over; the reason a suggestion carries. */
export function setStatus(beat, status, { mark = null, reason = null } = {}) {
    beat.status = status;
    beat.activatedAt = status === 'active' ? markOf(mark) : null;
    beat.faded = false;
    beat.suggestion = status === 'suggested' ? clip(reason, REASON_MAX) : null;
}

/**
 * The reader's change of a beat's status, checked against its lifecycle.
 * @returns {{ error: string, status: number } | { from: string }}
 */
export function transition(beats, beat, to, { force = false, mark = null } = {}) {
    if (!STATUSES.includes(to) || to === 'suggested') return { error: 'status is pending, active, satisfied or skipped', status: 400 };
    if (beat.status === to) return { error: `the beat is ${to} already`, status: 409 };
    if (!NEXT[beat.status].includes(to)) return { error: `a ${beat.status} beat cannot become ${to}`, status: 409 };
    const waiting = to === 'active' && !force ? waitsOn(beat, beats) : [];
    if (waiting.length) return { error: `it waits on ${waiting.map(id => titleOf(beats.find(b => b.id === id))).join(', ')}`, status: 409 };
    const from = beat.status;
    setStatus(beat, to, { mark });
    return { from };
}

export const titleOf = (beat) => (beat?.title?.trim() ? beat.title.trim() : '(untitled)');

/** The weight a beat is injected with: a faded beat speaks softly. */
export const weightOf = (beat) => (beat.faded ? 'soft' : beat.weight);

// one line a beat, its directive on one line; an untitled beat with no directive says nothing
function lineOf(beat) {
    const text = (beat.directive.trim() || beat.title.trim()).replace(/\s*\n\s*/g, ' ');
    if (!text) return null;
    const w = weightOf(beat);
    return `- (${w}) ${VERBS[w]}: ${text}`;
}

/** Every active beat a line, under the strongest weight; past the budget the longest active go first, one line kept whole. */
export function directionText(beats, budget) {
    let kept = beats.filter(b => b.status === 'active').map(b => ({ b, line: lineOf(b) })).filter(x => x.line);
    const since = (x) => x.b.activatedAt?.id ?? -1;
    while (kept.length > 1 && kept.map(x => x.line).join('\n').length > budget) {
        const oldest = kept.reduce((a, x) => (since(x) < since(a) ? x : a));
        kept = kept.filter(x => x !== oldest);
    }
    if (!kept.length) return '';
    const strongest = kept.map(x => weightOf(x.b)).reduce((a, w) => (RANK[w] > RANK[a] ? w : a), 'soft');
    return [`[STORY DIRECTION: ${strongest} guidance, do not narrate verbatim]`, ...kept.map(x => x.line), '[/STORY DIRECTION]'].join('\n');
}

/** The counts the window and the status command show. */
export function countsOf(beats) {
    const out = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const b of beats) out[b.status]++;
    return out;
}
