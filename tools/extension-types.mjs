// Writes docs/extensions.d.ts from tools/extension-types-base.d.ts and the contracts and vocabularies.
// Regenerate after changing any:
//   node tools/extension-types.mjs   (npm run docs runs it)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMMAND_TYPES, EVENT_TYPES, HOOK_TYPES, SLOT_TYPES } from '../app/modules/ext-contract.js';
import { SLOT_KINDS } from '../app/modules/ext-registry.js';
import { PIPELINE_TYPES } from '../server/lib/ext-contract.js';
import { CHANGE_VOCABULARY, LIBRARY_WRITE_ENTITIES } from '../server/db/changes.js';
import { ERROR_KINDS } from '../server/llm/errors.js';
import { GENERATE_MODES, LLM_PURPOSES, triggerOfMode } from '../server/llm/vocabulary.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'docs', 'extensions.d.ts');
const baseFile = path.join(root, 'tools', 'extension-types-base.d.ts');

const key = (k) => `'${k}'`;
// a map of key -> type as an object type; an empty one is an object with nothing in it
const objectType = (map) => {
    const entries = Object.entries(map);
    return entries.length ? `{ ${entries.map(([k, t]) => `${k}: ${t}`).join('; ')} }` : 'Record<string, never>';
};
const block = (name, doc, entries) => [
    `/** ${doc} */`,
    `export interface ${name} {`,
    ...entries.flatMap(([k, members]) => [`    ${key(k)}: {`, ...members.map(m => `        ${m};`), '    };']),
    '}',
    '',
];

/** What this generator writes, for a check that the committed file is current. */
export function generate() {
    const base = fs.readFileSync(baseFile, 'utf8').replace(/\r\n/g, '\n').trimEnd();
    const lines = [
        '// SPDX-License-Identifier: 0BSD',
        '',
        '// docs/extensions.d.ts: written by tools/extension-types.mjs from tools/extension-types-base.d.ts,',
        '// the two contracts (app/modules/ext-contract.js, server/lib/ext-contract.js), the change',
        '// feed\'s vocabulary (server/db/changes.js) and the model layer\'s lists (server/llm/errors.js,',
        '// server/llm/vocabulary.js). Edit those, then run npm run docs.',
        '',
        base,
        '',
        '// ======== generated from app/modules/ext-contract.js ========',
        '',
        '/** The kinds of place a slot is. */',
        `export type SlotKind = ${SLOT_KINDS.map(key).join(' | ')};`,
        '',
        ...block('Commands', 'Every command the app defines: the args run takes and what it answers.',
            Object.entries(COMMAND_TYPES).map(([id, t]) => [id, [`args: ${t.args}`, `answers: ${t.answers}`]])),
        '/** Every listed event: the payload a listener is handed. */',
        'export interface Events {',
        ...Object.entries(EVENT_TYPES).map(([name, payload]) => `    ${key(name)}: ${objectType(payload)};`),
        '}',
        '',
        ...block('ConversationHooks', 'The conversation\'s hooks: a filter\'s value, context and answer; an action\'s context.',
            Object.entries(HOOK_TYPES).map(([name, t]) => [name, [
                `kind: '${'value' in t ? 'filter' : 'action'}'`,
                ...('value' in t ? [`value: ${t.value}`] : []),
                `context: ${t.context}`,
                `answer: ${t.answer}`,
            ]])),
        ...block('Slots', 'Every slot: the context its callbacks are handed and the spec contribute takes.',
            Object.entries(SLOT_TYPES).map(([id, t]) => [id, [`context: ${objectType(t.context)}`, `spec: ${t.spec}`]])),
        '// ======== generated from server/lib/ext-contract.js and server/db/changes.js ========',
        '',
        ...block('Pipelines', 'Every pipeline a server half joins: the value a filter is handed and answers, and the facts beside it.',
            Object.entries(PIPELINE_TYPES).map(([name, t]) => [name, [`value: ${t.value}`, `context: ${t.context}`]])),
        '/** Every entity a change record names, with the ops it is reported under. */',
        'export interface ChangeVocabulary {',
        ...Object.entries(CHANGE_VOCABULARY).map(([entity, ops]) => `    ${entity}: ${ops.map(key).join(' | ')};`),
        '}',
        '',
        'export type ChangeEntity = keyof ChangeVocabulary;',
        '',
        '/** The entities a library write reports: what the store guards see and ctx.report reports. */',
        `export type LibraryWriteEntity = ${LIBRARY_WRITE_ENTITIES.map(key).join(' | ')};`,
        '',
        '/** A store guard\'s name: one per entity and op a library write reports. */',
        'export type StoreGuardName =',
        ...LIBRARY_WRITE_ENTITIES.flatMap(entity => CHANGE_VOCABULARY[entity].map(op => `    | ${key(`store.before.${entity}.${op}`)}`))
            .map((line, i, all) => (i === all.length - 1 ? `${line};` : line)),
        '',
        '// ======== generated from server/llm/errors.js and server/llm/vocabulary.js ========',
        '',
        '/** What went wrong with a model call: an LlmError\'s kind. */',
        `export type LlmErrorKind = ${ERROR_KINDS.map(key).join(' | ')};`,
        '',
        '/** The mode a reply is generated in, as POST /api/chats/{id}/generate takes it. */',
        `export type GenerationMode = ${GENERATE_MODES.map(key).join(' | ')};`,
        '',
        '/** What a model call is for, as the route that made it stamps it. */',
        `export type LlmPurpose = ${LLM_PURPOSES.map(key).join(' | ')};`,
        '',
        '/** A generation mode in the lore scan\'s words (\'append\' is \'normal\'). */',
        `export type PromptTrigger = ${[...new Set(GENERATE_MODES.map(triggerOfMode))].map(key).join(' | ')};`,
        '',
    ];
    return { file: outFile, text: lines.join('\n') };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const { file, text } = generate();
    fs.writeFileSync(file, text);
    console.log(`wrote ${file} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
}
