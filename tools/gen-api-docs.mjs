// Renders server/openapi.js into one self-contained HTML file (no CDN). Regenerate after a spec change:
//   node tools/gen-api-docs.mjs   -> docs/api-docs.html   (npm run docs runs it)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildOpenApiSpec } from '../server/openapi.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const spec = buildOpenApiSpec(pkg.version);

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The methods an operation is rendered under, in display order; a path key that is neither one nor a PATH_FIELDS key stops the build. */
export const METHOD_ORDER = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'];
const PATH_FIELDS = new Set(['summary', 'description', 'parameters', 'servers']);

function refName(ref) { return ref.split('/').pop(); }

/** The mark an operation, a parameter, a field or a schema carries when the spec deprecates it. */
export function deprecatedMark(node) {
    return node?.deprecated ? ' <span class="dep">deprecated</span>' : '';
}

function schemaLabel(schema) {
    if (!schema) return '';
    if (schema.$ref) return `<a class="ref" href="#schema-${refName(schema.$ref)}">${refName(schema.$ref)}</a>`;
    if (schema.allOf) return schema.allOf.map(schemaLabel).join(' + ');
    if (schema.anyOf) return schema.anyOf.map(s => schemaLabel(s) + (s.description ? ` <span class="dim">(${esc(s.description)})</span>` : '')).join(' | ');
    if (schema.type === 'array') return `array&lt;${schemaLabel(schema.items)}&gt;${deprecatedMark(schema)}`;
    if (schema.enum) return schema.enum.map(v => `<code>${esc(v)}</code>`).join(' | ');
    let label = schema.type || 'object';
    if (schema.format) label += ` (${schema.format})`;
    if (schema.nullable) label += ' | null';
    return esc(label) + (schema.pattern ? ` matching <code>${esc(schema.pattern)}</code>` : '') + deprecatedMark(schema);
}

const WALKS = { cursor: 'walked by its cursor (after, nextCursor)', offset: 'walked by offset', none: 'a ranked top N, with no next page' };
const FORMS = { bare: 'a request naming neither limit nor after answers the whole list', unbounded: 'no limit, or one of 0 or below, answers every row', clamped: 'a limit of 0 or below reads the default, and one past the cap reads the cap' };

/** An operation's x-collection, read as one line: what the collection answers and what it still answers until a later API version. */
export function collectionLine(c) {
    if (!c) return '';
    let text;
    if (c.kind === 'page') text = `A page: ${c.default} unless limit asks, at most ${c.max}, ${WALKS[c.walk] || c.walk}${c.key ? `; the list is ${c.key}` : ''}.`;
    else if (c.kind === 'whole') text = `The whole set: ${c.bound}.`;
    else if (c.kind === 'retired') text = `Leaves at API version ${c.until}: ${c.use} replaces it.`;
    else text = JSON.stringify(c);
    if (c.deprecated?.length) text += ` Until API version ${c.until} (deprecated): ${c.deprecated.map(f => FORMS[f] || f).join('; ')}.`;
    return `<div class="sect"><span class="sect-label">Collection</span><span class="coll">${esc(text)}</span></div>`;
}

function paramsTable(params) {
    if (!params?.length) return '';
    const rows = params.map(p => `
        <tr>
            <td><code>${esc(p.name)}</code>${p.required && p.in !== 'path' ? ' <span class="req">required</span>' : ''}${deprecatedMark(p)}</td>
            <td class="dim">${esc(p.in)}</td>
            <td>${schemaLabel(p.schema)}</td>
            <td>${esc(p.description || p.schema?.description || '')}</td>
        </tr>`).join('');
    return `<table><thead><tr><th>Parameter</th><th>In</th><th>Type</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** A request body's blocks, one per content type it accepts. */
export function bodyBlock(rb) {
    if (!rb) return '';
    return Object.entries(rb.content || {}).map(([ctype, media]) => {
        const schema = media?.schema;
        let inner = schemaLabel(schema);
        if (schema?.type === 'object' && schema.properties) inner = propsTable(schema);
        return `<div class="sect"><span class="sect-label">Request body</span> <code class="ctype">${esc(ctype)}</code>${inner ? `<div>${inner}</div>` : ''}</div>`;
    }).join('');
}

function propsTable(schema) {
    if (!schema?.properties) return '';
    const req = new Set(schema.required || []);
    const rows = Object.entries(schema.properties).map(([name, s]) => `
        <tr>
            <td><code>${esc(name)}</code>${req.has(name) ? ' <span class="req">required</span>' : ''}${deprecatedMark(s)}</td>
            <td>${schemaLabel(s)}</td>
            <td>${esc(s.description || '')}</td>
        </tr>`).join('');
    return `<table><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** The responses table; a response with several content types names each beside its schema. */
export function responsesBlock(responses) {
    if (!responses) return '';
    const rows = Object.entries(responses).map(([code, r]) => {
        const types = Object.entries(r.content || {});
        const schema = types[0]?.[1]?.schema;
        const label = types.length > 1
            ? types.map(([ctype, media]) => `<code class="ctype">${esc(ctype)}</code> ${schemaLabel(media?.schema)}`).join('<br>')
            : schema ? schemaLabel(schema) : '';
        return `<tr>
            <td><span class="code code-${code[0]}xx">${esc(code)}</span></td>
            <td>${label}</td>
            <td>${esc(r.description || '')}</td>
        </tr>`;
    }).join('');
    return `<div class="sect"><span class="sect-label">Responses</span><table><tbody>${rows}</tbody></table></div>`;
}

function opBlock(pathStr, method, op, pathLevelDesc) {
    return `
    <details class="op" id="op-${esc(method)}-${esc(pathStr.replace(/[^a-z0-9]+/gi, '-'))}">
        <summary>
            <span class="method m-${method}">${method.toUpperCase()}</span>
            <span class="path">${esc(pathStr)}</span>${deprecatedMark(op)}
            <span class="summary-text">${esc(op.summary || '')}</span>
        </summary>
        <div class="op-body">
            ${pathLevelDesc ? `<p class="desc">${esc(pathLevelDesc)}</p>` : ''}
            ${op.description ? `<p class="desc">${esc(op.description)}</p>` : ''}
            ${collectionLine(op['x-collection'])}
            ${op.parameters?.length ? `<div class="sect"><span class="sect-label">Parameters</span>${paramsTable(op.parameters)}</div>` : ''}
            ${bodyBlock(op.requestBody)}
            ${responsesBlock(op.responses)}
        </div>
    </details>`;
}

const byTag = new Map((spec.tags || []).map(t => [t.name, { ...t, ops: [] }]));
for (const [pathStr, pathObj] of Object.entries(spec.paths)) {
    const unknown = Object.keys(pathObj).filter(k => !METHOD_ORDER.includes(k) && !PATH_FIELDS.has(k));
    if (unknown.length) throw new Error(`${pathStr}: ${unknown.join(', ')} is neither a method the docs render nor a path field`);
    for (const method of METHOD_ORDER) {
        const op = pathObj[method];
        if (!op) continue;
        const tag = op.tags?.[0] || 'other';
        if (!byTag.has(tag)) byTag.set(tag, { name: tag, description: '', ops: [] });
        byTag.get(tag).ops.push(opBlock(pathStr, method, op, pathObj.description));
    }
}

const tagSections = [...byTag.values()].filter(t => t.ops.length).map(t => `
    <section id="tag-${esc(t.name)}">
        <h2>${esc(t.name)}</h2>
        ${t.description ? `<p class="tag-desc">${esc(t.description)}</p>` : ''}
        ${t.ops.join('\n')}
    </section>`).join('\n');

const schemaSections = Object.entries(spec.components?.schemas || {}).map(([name, schema]) => `
    <details class="op schema" id="schema-${esc(name)}">
        <summary><span class="method m-schema">SCHEMA</span><span class="path">${esc(name)}</span>${deprecatedMark(schema)}
            <span class="summary-text">${esc(schema.description || '')}</span></summary>
        <div class="op-body">${schema.allOf ? schema.allOf.map(s => s.$ref ? `<p>extends ${schemaLabel(s)}</p>` : propsTable(s)).join('') : propsTable(schema) || `<p class="desc">${esc(schema.type || 'object')}</p>`}</div>
    </details>`).join('\n');

const nav = [...byTag.values()].filter(t => t.ops.length)
    .map(t => `<a href="#tag-${esc(t.name)}">${esc(t.name)}</a>`).join('');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.info.title)} v${esc(spec.info.version)}</title>
<style>
:root {
    --bg: #14141a; --panel: #1c1c24; --panel-2: #22222c; --border: #2e2e3a;
    --text: #e0e0e6; --dim: #9a9aa8; --faint: #6c6c7a;
    --accent: #8b7cf8; --accent-2: #5eead4;
    --get: #61affe; --head: #9012fe; --post: #49cc90; --put: #fca130; --patch: #50e3c2; --delete: #f93e3e; --options: #0d5aa7;
    --ok: #49cc90; --warn: #fca130; --err: #f93e3e;
    color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, "Segoe UI", sans-serif; }
.wrap { max-width: 1060px; margin: 0 auto; padding: 32px 24px 80px; }
header h1 { margin: 0 0 4px; font-size: 1.9rem;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    -webkit-background-clip: text; background-clip: text; color: transparent; }
header .version { color: var(--faint); font-size: .95rem; }
header .intro { color: var(--dim); max-width: 70ch; margin: 14px 0 0; }
nav { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 6px;
    padding: 14px 0; margin: 20px 0 4px; background: var(--bg); border-bottom: 1px solid var(--border); }
nav a { color: var(--dim); text-decoration: none; padding: 5px 12px; border: 1px solid var(--border);
    border-radius: 999px; font-size: .85rem; }
nav a:hover { color: var(--text); border-color: var(--accent); }
section h2 { margin: 36px 0 6px; font-size: 1.25rem; text-transform: capitalize; }
.tag-desc { color: var(--dim); margin: 0 0 14px; font-size: .92rem; }
.op { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; margin: 8px 0; overflow: hidden; }
.op[open] { border-color: #3a3a4c; }
.op summary { display: flex; align-items: center; gap: 12px; padding: 11px 14px; cursor: pointer; list-style: none; }
.op summary::-webkit-details-marker { display: none; }
.op summary:hover { background: var(--panel-2); }
.method { flex: 0 0 64px; text-align: center; padding: 3px 0; border-radius: 6px;
    font-size: .74rem; font-weight: 700; letter-spacing: .04em; color: #101014; }
.m-get { background: var(--get); } .m-head { background: var(--head); color: #f4f4f8; } .m-post { background: var(--post); }
.m-put { background: var(--put); } .m-patch { background: var(--patch); } .m-delete { background: var(--delete); }
.m-options { background: var(--options); color: #f4f4f8; }
.m-schema { background: #6c6c7a; color: #14141a; }
.path { font-family: ui-monospace, Consolas, monospace; font-size: .9rem; white-space: nowrap; }
.summary-text { color: var(--dim); font-size: .86rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.op-body { padding: 4px 16px 16px; border-top: 1px solid var(--border); }
.desc { color: var(--dim); font-size: .9rem; }
.sect { margin-top: 14px; }
.sect-label { display: block; color: var(--faint); font-size: .72rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
.ctype { color: var(--accent-2); font-size: .82rem; }
table { width: 100%; border-collapse: collapse; font-size: .87rem; margin-top: 6px; }
th { text-align: left; color: var(--faint); font-weight: 600; font-size: .76rem; text-transform: uppercase;
    letter-spacing: .05em; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--border); }
td { padding: 6px 10px 6px 0; border-bottom: 1px solid #26262f; vertical-align: top; }
tr:last-child td { border-bottom: none; }
code { background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px;
    padding: 1px 5px; font-size: .82rem; font-family: ui-monospace, Consolas, monospace; }
.dim { color: var(--faint); }
.req { color: var(--warn); font-size: .72rem; font-weight: 700; }
.dep { color: var(--err); font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.coll { color: var(--text); font-size: .88rem; }
.ref { color: var(--accent); text-decoration: none; font-family: ui-monospace, Consolas, monospace; font-size: .84rem; }
.ref:hover { text-decoration: underline; }
.code { font-family: ui-monospace, Consolas, monospace; font-weight: 700; font-size: .84rem; }
.code-2xx { color: var(--ok); } .code-4xx { color: var(--warn); } .code-5xx { color: var(--err); }
.foot { margin-top: 48px; color: var(--faint); font-size: .82rem; border-top: 1px solid var(--border); padding-top: 16px; }
@media (max-width: 640px) {
    .op summary { flex-wrap: wrap; }
    .summary-text { white-space: normal; }
    .path { white-space: normal; word-break: break-all; }
}
</style>
</head>
<body>
<div class="wrap">
    <header>
        <h1>${esc(spec.info.title)}</h1>
        <div class="version">API version ${esc(spec.info.version)} &middot; OpenAPI ${esc(spec.openapi)} &middot; live spec at <code>/api/openapi.json</code></div>
        <p class="intro">${esc(spec.info.description)}</p>
    </header>
    <nav>${nav}<a href="#schemas">schemas</a></nav>
    ${tagSections}
    <section id="schemas">
        <h2>Schemas</h2>
        ${schemaSections}
    </section>
    <div class="foot">Generated from <code>server/openapi.js</code>. Single file, no external assets; safe to share as an attachment.</div>
</div>
</body>
</html>`;

const outFile = path.join(root, 'docs', 'api-docs.html');
// the template's indentation pads blank lines; no line of the file ends in whitespace
const text = html.replace(/[ \t]+$/gm, '');

/** What this generator writes, for a check that the committed file is current. */
export function generate() {
    return { file: outFile, text };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    fs.writeFileSync(outFile, text);
    console.log(`wrote ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);
}
