// SPDX-License-Identifier: 0BSD

// The kit's checks on an extension's scripts before a test boots: the guide's data rules, for honest mistakes, never a security check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Each check the kit runs, by the name a sigma-kit-allow comment uses, and the why it prints. */
export const CHECKS = Object.freeze({
    'app-table-write': 'changes the app\'s table "{name}" with its own SQL. Write the app\'s data through ctx.stores: a raw write skips the store guards, leaves the figures the app keeps beside the row stale, never reaches the other open tabs, and the app\'s updates assume its tables are as it left them.',
    'other-extension-table': 'reaches "{name}", another extension\'s table. Its author can change it in any release, and it may not be installed or on; use what that extension publishes (its commands), or keep the data yourself.',
    'browser-storage': 'uses {name}, which is per browser, shared by every account signed in there and invisible to the server. Keep settings in ctx.settings and state in ctx.storage.',
});

// ---- the app's tables, from its migrations in a process of its own: server modules read the data folder once, on import
let tables = null;
/** The tables and views of a fresh library, the extensions' own (x_) left out. */
export function appTables() {
    if (tables) return tables;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-kit-schema-'));
    try {
        const script = `
            import { createRequire } from 'node:module';
            import path from 'node:path';
            import { pathToFileURL } from 'node:url';
            const repo = ${JSON.stringify(repo)}, scratch = ${JSON.stringify(path.join(tmp, 'paths'))};
            const Database = createRequire(path.join(repo, 'package.json'))('better-sqlite3');
            const { runMigrationSteps, MIGRATION_COUNT } = await import(pathToFileURL(path.join(repo, 'server', 'db', 'database.js')).href);
            const db = new Database(':memory:');
            db.pragma('foreign_keys = OFF');
            runMigrationSteps(db, new Proxy({}, { get: (_, k) => path.join(scratch, String(k)) }), 0, MIGRATION_COUNT);
            const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all();
            console.log(JSON.stringify(rows.map(r => r.name).filter(n => !/^(sqlite_|x_)/.test(n))));
        `;
        const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            env: { ...process.env, CL_DATA_DIR: path.join(tmp, 'data') }, encoding: 'utf8', windowsHide: true, timeout: 120000,
        });
        const last = (r.stdout || '').trim().split('\n').pop() || '';
        if (r.status !== 0 || !last.startsWith('[')) throw new Error(`the kit could not read the app's tables: ${(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`}`);
        tables = new Set(JSON.parse(last).map(n => n.toLowerCase()));
        return tables;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// ---- a script read as code (strings and comments blanked, lines kept) and its string literals, each with its line
function scan(src) {
    const strings = [];
    let code = '', line = 1, i = 0, depth = 0, last = '';
    const n = src.length;
    const open = []; // the brace depth each open template's ${ began at
    const blank = (s) => { code += s.replace(/[^\n]/g, ' '); line += (s.match(/\n/g) || []).length; };
    // from just inside a template (after its backtick, or the } closing one of its ${}) to its end or next ${
    const template = () => {
        let text = '', j = i;
        const start = line;
        while (j < n) {
            if (src[j] === '\\') { text += src.slice(j, j + 2); j += 2; continue; }
            if (src[j] === '`') { strings.push({ text, line: start }); blank(src.slice(i, j + 1)); i = j + 1; last = 'a'; return; }
            if (src[j] === '$' && src[j + 1] === '{') { strings.push({ text, line: start }); blank(src.slice(i, j + 2)); i = j + 2; open.push(depth); depth++; last = '{'; return; }
            text += src[j++];
        }
        strings.push({ text, line: start });
        blank(src.slice(i));
        i = n;
    };
    while (i < n) {
        const c = src[i], d = src[i + 1];
        if (c === '/' && d === '/') { let j = src.indexOf('\n', i); if (j < 0) j = n; blank(src.slice(i, j)); i = j; continue; }
        if (c === '/' && d === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; blank(src.slice(i, j)); i = j; continue; }
        if (c === '\'' || c === '"') {
            let j = i + 1, text = '';
            while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { text += src.slice(j, j + 2); j += 2; } else text += src[j++]; }
            strings.push({ text, line });
            blank(src.slice(i, j + 1));
            i = j + 1; last = 'a';
            continue;
        }
        if (c === '`') { blank(c); i++; template(); continue; }
        if (c === '}' && open.length && open[open.length - 1] === depth - 1) { open.pop(); depth--; blank(c); i++; template(); continue; }
        // a slash where an operand would start opens a regex literal, never a division
        if (c === '/' && ('(,=:[!&|?{};+-*%<>~^'.includes(last) || last === '' || /\b(return|typeof|case|in|of|void|delete|throw|new|yield|await)\s*$/.test(code))) {
            let j = i + 1, cls = false;
            while (j < n && src[j] !== '\n') {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === '[') cls = true;
                else if (src[j] === ']') cls = false;
                else if (src[j] === '/' && !cls) break;
                j++;
            }
            j++;
            while (j < n && /[a-z]/i.test(src[j])) j++;
            blank(src.slice(i, j));
            i = j; last = 'a';
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        code += c;
        if (c === '\n') line++;
        else if (!/\s/.test(c)) last = c;
        i++;
    }
    return { code, strings };
}

// a statement that changes a table, with what must follow its name for it to be SQL and not prose
const WRITES = [
    { re: /\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into)\s+["`[]?([a-z_][a-z0-9_]*)["`\]]?(?=\s*(?:\(|values\b|select\b|default\b))/gi },
    { re: /\bupdate(?:\s+or\s+\w+)?\s+["`[]?([a-z_][a-z0-9_]*)["`\]]?(?=\s+set\b)/gi },
    { re: /\bdelete\s+from\s+["`[]?([a-z_][a-z0-9_]*)["`\]]?(?=\s*(?:$|where\b|returning\b|;))/gi },
    { re: /\b(?:alter|drop)\s+table\s+(?:if\s+exists\s+)?["`[]?([a-z_][a-z0-9_]*)["`\]]?/gi },
    { re: /\bcreate\s+(?:temp\s+|temporary\s+)?trigger\b[\s\S]*?\bon\s+["`[]?([a-z_][a-z0-9_]*)["`\]]?/gi },
];
const SQLISH = /\b(select|insert|update|delete|replace|from|join|into|table)\b/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests']);

const linesBefore = (text, index) => (text.slice(0, index).match(/\n/g) || []).length;
// a sigma-kit-allow comment on the line or the one above names the checks that line means to pass
function allowed(rawLines, line, check) {
    for (const l of [rawLines[line - 1], rawLines[line - 2]]) {
        const m = l && /sigma-kit-allow:?\s*([\w-]+(?:\s*,\s*[\w-]+)*)/.exec(l);
        if (m && m[1].split(/\s*,\s*/).includes(check)) return true;
    }
    return false;
}

/**
 * Check an extension folder's own scripts (its tests and node_modules aside) against the guide's ground rules.
 * @param {string} dir the extension's folder
 * @param {{ tables?: Set<string> }} [opts] the app's tables, read from its migrations when not given
 * @returns {Array<{ file: string, line: number, check: string, name: string, why: string }>}
 */
export function lintExtension(dir, { tables: given = null } = {}) {
    const root = path.resolve(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const own = `x_${String(manifest.id).toLowerCase().replace(/-/g, '_')}_`;
    const app = given || appTables();
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
        if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : walk(path.join(d, e.name));
        return /\.(m?js|cjs)$/.test(e.name) && !/\.(test|spec)\.[mc]?js$/.test(e.name) ? [path.join(d, e.name)] : [];
    });
    const found = [];
    for (const file of walk(root)) {
        const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        const rawLines = src.split('\n');
        const rel = path.relative(root, file).split(path.sep).join('/');
        const add = (line, check, name) => {
            if (!allowed(rawLines, line, check)) found.push({ file: rel, line, check, name, why: CHECKS[check].replace('{name}', name) });
        };
        const { code, strings } = scan(src);
        for (const s of strings) {
            for (const { re } of WRITES) {
                for (const m of s.text.matchAll(re)) if (app.has(m[1].toLowerCase())) add(s.line + linesBefore(s.text, m.index), 'app-table-write', m[1]);
            }
            if (SQLISH.test(s.text)) {
                for (const m of s.text.matchAll(/\bx_[a-z0-9_]+/gi)) if (!m[0].toLowerCase().startsWith(own)) add(s.line + linesBefore(s.text, m.index), 'other-extension-table', m[0]);
            }
        }
        for (const m of code.matchAll(/\b(localStorage|sessionStorage)\b/g)) add(1 + linesBefore(code, m.index), 'browser-storage', m[1]);
    }
    return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** What startSigma throws for an extension the checks stopped. */
export function lintReport(id, found) {
    return [
        `startSigma: the kit's checks found ${found.length} ${found.length === 1 ? 'problem' : 'problems'} in "${id}". Fix each one, or mark a line`
        + ' that means it with a "sigma-kit-allow: <check>" comment on it or the line above ("Working with the app" in the authors\' guide says why):',
        ...found.map(f => `  ${f.file}:${f.line}  [${f.check}] ${f.why}`),
    ].join('\n');
}
