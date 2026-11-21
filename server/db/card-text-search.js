// The search box's card-text arm: a typed word finds the indexed words holding it (search_terms), then characters_fts their cards
import { subscribeChanges } from './changes.js';
import { nextTurn, scheduleLibraryJob } from '../lib/steps.js';
import { textMatch } from './rule-filters.js';

// past this many terms a word reads the card text instead: an ORed term costs about 60 us, a read of every card about a second
export const TERM_FANOUT_CAP = 3000;
const REFRESH_SLICE = 500;
const REFRESH_WAIT_MS = 1500;

const scanIn = (column) => (alias, word) => textMatch(`COALESCE(${alias}.${column}, '')`, word);

/** The q fields that read card text: each one's characters_fts column and how a scan finds a word in it. */
export const CARD_TEXT_Q_FIELDS = Object.assign(Object.create(null), {
    notes: { column: 'creator_notes', scan: scanIn('creator_notes') },
    description: { column: 'description', scan: scanIn('description') },
    firstMessage: { column: 'first_mes', scan: scanIn('first_mes') },
    altGreetings: {
        column: 'alternate_greetings',
        scan: (alias, word) => {
            const m = textMatch('g.value', word);
            return { sql: `EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(${alias}.card, '$.data.alternate_greetings'), '[]')) g WHERE ${m.sql})`, params: m.params };
        },
    },
});

const _stmts = new WeakMap();

function stmts(db) {
    let s = _stmts.get(db);
    if (s) return s;
    // a scratch index in the connection's temp schema, tokenized as characters_fts is, so a word folds as the index folded the card
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS temp.search_scratch USING fts5(t, tokenize='unicode61 remove_diacritics 2');
        CREATE VIRTUAL TABLE IF NOT EXISTS temp.search_scratch_tokens USING fts5vocab(temp, search_scratch, instance);
        CREATE VIRTUAL TABLE IF NOT EXISTS temp.search_scratch_terms USING fts5vocab(temp, search_scratch, row);
        CREATE VIRTUAL TABLE IF NOT EXISTS temp.search_vocab USING fts5vocab(main, characters_fts, row);
    `);
    const cols = db.prepare("SELECT name FROM pragma_table_info('characters_fts_source') WHERE name != 'rid'").pluck().all();
    s = {
        clear: db.prepare('DELETE FROM temp.search_scratch'),
        add: db.prepare('INSERT INTO temp.search_scratch (rowid, t) VALUES (?, ?)'),
        tokens: db.prepare('SELECT term, doc FROM temp.search_scratch_tokens ORDER BY doc, offset'),
        terms: db.prepare('SELECT term FROM search_terms WHERE instr(term, ?) > 0 LIMIT ?').pluck(),
        anyPending: db.prepare('SELECT EXISTS (SELECT 1 FROM search_terms_pending)').pluck(),
        // the rowid ceiling, about the library's size without counting it
        lastRowid: db.prepare('SELECT MAX(rowid) FROM characters').pluck(),
        slice: db.prepare('SELECT rid FROM search_terms_pending ORDER BY rid LIMIT ?').pluck(),
        addRows: db.prepare(`INSERT INTO temp.search_scratch (t) SELECT concat_ws(char(10), ${cols.join(', ')})
            FROM characters_fts_source WHERE rid IN (SELECT value FROM json_each(?))`),
        scratchTerms: db.prepare('SELECT term FROM temp.search_scratch_terms').pluck(),
        fold: db.prepare('INSERT OR IGNORE INTO search_terms (term) SELECT term FROM temp.search_scratch_terms'),
        done: db.prepare('DELETE FROM search_terms_pending WHERE rid IN (SELECT value FROM json_each(?))'),
    };
    _stmts.set(db, s);
    return s;
}

// a typed text as its words (each with the spelling typed, for a scan) and its quoted runs, folded by the index's tokenizer
function readSearchText(db, text) {
    const quoted = [];
    const rest = String(text).replace(/"([^"]*)"/g, (_, run) => { quoted.push(run); return ' '; });
    const raws = rest.match(/[\p{L}\p{N}\p{M}\p{Co}]+/gu) || [];
    const docs = [...raws, ...quoted];
    if (!docs.length) return { words: [], phrases: [] };
    const s = stmts(db);
    s.clear.run();
    docs.forEach((d, i) => s.add.run(i + 1, d));
    const byDoc = new Map();
    for (const r of s.tokens.all()) {
        if (!byDoc.has(r.doc)) byDoc.set(r.doc, []);
        byDoc.get(r.doc).push(r.term);
    }
    s.clear.run();
    const words = new Map();
    raws.forEach((raw, i) => {
        const tokens = byDoc.get(i + 1) || [];
        // a run the tokenizer splits further is searched as its pieces
        if (tokens.length === 1) { if (!words.has(tokens[0])) words.set(tokens[0], { raw, token: tokens[0] }); }
        else for (const t of tokens) if (!words.has(t)) words.set(t, { raw: t, token: t });
    });
    const phrases = quoted.map((_, j) => byDoc.get(raws.length + j + 1) || []).filter(t => t.length);
    return { words: [...words.values()], phrases };
}

const quote = (t) => `"${String(t).replace(/"/g, '""')}"`;

const NONE = Object.freeze({ selects: ['SELECT c2.rowid FROM characters c2 WHERE 0'], params: [] });
// a rule narrows by its longest few words: any subset of them still finds every card holding the whole text
const NARROW_WORDS = 3;

/**
 * The cards whose named fields hold each typed word inside a word, a quoted run as a phrase: rowid SELECTs, or a scanning row clause.
 * @param {string[]} fields keys of CARD_TEXT_Q_FIELDS
 * @returns {{ selects: string[], params: any[], row?: { sql: string, params: any[] } }}
 */
export function cardTextSearch(db, text, fields) {
    return cardTextArms(db, readSearchText(db, text), fields.map(f => CARD_TEXT_Q_FIELDS[f])) || NONE;
}

/**
 * The rowids whose card column may hold a text; null where reading every card is cheaper or the only way.
 * @returns {number[] | null}
 */
export function cardTextCandidates(db, text, column) {
    const read = readSearchText(db, text);
    const words = [...read.words].sort((a, b) => b.token.length - a.token.length || (a.token < b.token ? -1 : 1)).slice(0, NARROW_WORDS);
    const arms = cardTextArms(db, { words, phrases: read.phrases }, [{ column, scan: scanIn(column) }], { narrowOnly: true });
    if (!arms) return null;
    // past a third the scan is cheaper: the candidates are read anyway, and the lookup costs on top
    const most = Math.floor((stmts(db).lastRowid.get() || 0) / 3);
    const rows = db.prepare(`SELECT * FROM (${arms.selects.join(' UNION ALL ')}) LIMIT ?`).pluck().all(...arms.params, most + 1);
    return rows.length > most ? null : [...new Set(rows)];
}

// null for a text of no words; narrowOnly drops a word past the cap (any subset still finds every card), null if none is left
function cardTextArms(db, { words, phrases }, specs, { narrowOnly = false } = {}) {
    if (!words.length && !phrases.length) return null;
    const s = stmts(db);
    const colset = `{${specs.map(sp => sp.column).join(' ')}}`;
    const scanOf = (alias, raw) => {
        const parts = specs.map(sp => sp.scan(alias, raw));
        return { sql: `(${parts.map(p => p.sql).join(' OR ')})`, params: parts.flatMap(p => p.params) };
    };
    const indexed = [];
    const scanned = [];
    for (const w of words) {
        const terms = s.terms.all(w.token, TERM_FANOUT_CAP + 1);
        if (terms.length > TERM_FANOUT_CAP) { if (!narrowOnly) scanned.push(w); }
        else indexed.push({ word: w, match: terms.length ? `(${terms.map(quote).join(' OR ')})` : null });
    }
    for (const p of phrases) indexed.push({ match: quote(p.join(' ')) });

    if (!indexed.length) {
        if (narrowOnly) return null;
        const scans = scanned.map(w => scanOf('c', w.raw));
        return { selects: [], params: [], row: { sql: `(${scans.map(x => x.sql).join(' AND ')})`, params: scans.flatMap(x => x.params) } };
    }
    const selects = [];
    const params = [];
    const scans = scanned.map(w => scanOf('c2', w.raw));
    // a word no term holds matches no indexed card
    if (indexed.every(i => i.match)) {
        const match = 'SELECT f.rowid FROM characters_fts f WHERE f.characters_fts MATCH ?';
        selects.push(scans.length ? `SELECT c2.rowid FROM characters c2 WHERE c2.rowid IN (${match})${scans.map(x => ` AND ${x.sql}`).join('')}` : match);
        params.push(`${colset} : (${indexed.map(i => i.match).join(' AND ')})`, ...scans.flatMap(x => x.params));
    }
    // a card written since the term list caught up may hold a word it lacks yet, so those rows also try each word by scan
    if (indexed.some(i => i.word) && s.anyPending.get()) {
        scheduleSearchTermsRefresh(db);
        const conds = [];
        for (const i of indexed) {
            const inIndex = i.match ? 'c4.rowid IN (SELECT f.rowid FROM characters_fts f WHERE f.characters_fts MATCH ?)' : null;
            if (inIndex) params.push(`${colset} : ${i.match}`);
            if (!i.word) { conds.push(inIndex); continue; }
            const sc = scanOf('c4', i.word.raw);
            conds.push(inIndex ? `(${inIndex} OR ${sc.sql})` : sc.sql);
            params.push(...sc.params);
        }
        for (const w of scanned) {
            const sc = scanOf('c4', w.raw);
            conds.push(sc.sql);
            params.push(...sc.params);
        }
        // CROSS JOIN keeps the queue the outer loop: left free, the planner (no stats on the queue) walked every card for the scan
        selects.push(`SELECT p.rid FROM search_terms_pending p CROSS JOIN characters c4 ON c4.rowid = p.rid WHERE ${conds.join(' AND ')}`);
    }
    return selects.length ? { selects, params } : NONE;
}

/** Fold the words of up to max pending rows into search_terms; answers how many rows it folded. */
export function refreshSearchTerms(db, max = REFRESH_SLICE) {
    const s = stmts(db);
    return db.transaction(() => {
        const rids = s.slice.all(max);
        if (!rids.length) return 0;
        const list = JSON.stringify(rids);
        s.clear.run();
        s.addRows.run(list);
        s.fold.run();
        s.done.run(list);
        s.clear.run();
        return rids.length;
    })();
}

/** Bring search_terms up to date with every pending row soon, a slice per turn; a call while one waits joins it. */
function scheduleSearchTermsRefresh(db, wait = REFRESH_WAIT_MS) {
    scheduleLibraryJob(db, 'search', async () => { while (db.open && refreshSearchTerms(db) === REFRESH_SLICE) await nextTurn(); }, { wait });
}

/** search_terms rebuilt whole from the index's vocabulary, for a bulk load that ran without the triggers. */
export function rebuildSearchTerms(db) {
    stmts(db);
    db.transaction(() => {
        db.prepare('DELETE FROM search_terms').run();
        db.prepare('INSERT INTO search_terms (term) SELECT term FROM temp.search_vocab').run();
        db.prepare('DELETE FROM search_terms_pending').run();
    })();
}

/** The index's words search_terms lacks that no pending row explains (the invariant); reads the whole vocabulary, so never on a request. */
export function missingSearchTerms(db) {
    const s = stmts(db);
    const missing = db.prepare('SELECT v.term FROM temp.search_vocab v WHERE NOT EXISTS (SELECT 1 FROM search_terms t WHERE t.term = v.term)').pluck().all();
    if (!missing.length) return [];
    const rids = db.prepare('SELECT rid FROM search_terms_pending').pluck().all();
    s.clear.run();
    if (rids.length) s.addRows.run(JSON.stringify(rids));
    const pending = new Set(s.scratchTerms.all());
    s.clear.run();
    return missing.filter(t => !pending.has(t));
}

// a character write schedules the refresh; one from another process is caught when a search finds rows pending
subscribeChanges((owner, records, db) => {
    if (db && records.some(r => r.entity === 'character')) scheduleSearchTermsRefresh(db);
});
