import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { writeFileAtomic } from '../lib/atomic-write.js';
import { invalidatePersonaThumbs } from './thumbs.js';
import {
    listPersonas, getPersona, createPersona, updatePersona, deletePersona,
    getActivePersona, setActivePersona, resolvePersona, chatPersonaOverride, PRONOUN_COLUMNS,
} from '../db/personas-store.js';
import { listAllWorldsFor } from '../db/world-links-store.js';

export const personasRouter = Router();

const nameOf = v => (typeof v === 'string' ? v.trim() : '');

// a form is a word or two; the cap keeps a pasted paragraph out of every sentence that names it
const PRONOUN_MAX = 64;

/** A pronouns body checked: { forms } trimmed, or { error } naming what is wrong. */
function pronounsOf(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: `pronouns must be an object of ${Object.keys(PRONOUN_COLUMNS).join(', ')}` };
    const forms = {};
    for (const [key, value] of Object.entries(v)) {
        if (!Object.hasOwn(PRONOUN_COLUMNS, key)) return { error: `pronouns.${key} is not a form; the forms are ${Object.keys(PRONOUN_COLUMNS).join(', ')}` };
        if (typeof value !== 'string') return { error: `pronouns.${key} must be a string` };
        const form = value.trim();
        if ([...form].length > PRONOUN_MAX) return { error: `pronouns.${key} is longer than ${PRONOUN_MAX} characters` };
        forms[key] = form;
    }
    return { forms };
}

personasRouter.get('/', (req, res) => {
    // Each persona's bound lorebooks ride the list (one grouped read over a small table)
    // so the editor renders its pills without a read per persona.
    const byPersona = new Map(listAllWorldsFor(req.db, 'persona').map(r => [r.id, r.worlds]));
    res.json({
        personas: listPersonas(req.db).map(p => ({ ...p, worlds: byPersona.get(p.id) || [] })),
        activeId: getActivePersona(req.db)?.id ?? null,
    });
});

personasRouter.post('/', (req, res) => {
    const name = nameOf(req.body?.name);
    if (!name) return res.status(400).json({ error: 'name required' });
    const description = typeof req.body?.description === 'string' ? req.body.description : '';
    const pronouns = req.body?.pronouns === undefined ? { forms: {} } : pronounsOf(req.body.pronouns);
    if (pronouns.error) return res.status(400).json({ error: pronouns.error });
    const persona = createPersona(req.db, { name, description, avatar: null, pronouns: pronouns.forms });
    // the first persona becomes active; later ones never steal the selection
    if (listPersonas(req.db).length === 1) setActivePersona(req.db, persona.id);
    res.json(persona);
});

// Ahead of '/:id' so the literal path is not swallowed by the param route.
personasRouter.put('/active', (req, res) => {
    const id = req.body?.id;
    if (id === null) return res.json({ activeId: null, persona: setActivePersona(req.db, null) });
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id must be a string, or null to clear' });
    const persona = setActivePersona(req.db, id);
    if (!persona) return res.status(404).json({ error: 'persona not found' });
    res.json({ activeId: persona.id, persona });
});

// Declared before /:id so the literal path wins the match.
// `override` is the chat's raw pointer, so the panel can tell "set here" from "inherited"
personasRouter.get('/resolve', (req, res) => {
    const chatId = req.query.chatId ? String(req.query.chatId) : '';
    const { persona, source } = resolvePersona(req.db, chatId || null);
    res.json({ persona, source, override: chatId ? chatPersonaOverride(req.db, chatId) : null });
});

personasRouter.get('/:id', (req, res) => {
    const persona = getPersona(req.db, req.params.id);
    if (!persona) return res.status(404).json({ error: 'persona not found' });
    res.json(persona);
});

personasRouter.patch('/:id', (req, res) => {
    const patch = {};
    if (req.body?.name !== undefined) {
        const name = nameOf(req.body.name);
        if (!name) return res.status(400).json({ error: 'name cannot be blank' });
        patch.name = name;
    }
    if (req.body?.description !== undefined) {
        if (typeof req.body.description !== 'string') return res.status(400).json({ error: 'description must be a string' });
        patch.description = req.body.description;
    }
    if (req.body?.pronouns !== undefined) {
        const pronouns = pronounsOf(req.body.pronouns);
        if (pronouns.error) return res.status(400).json({ error: pronouns.error });
        patch.pronouns = pronouns.forms;
    }
    const persona = updatePersona(req.db, req.params.id, patch);
    if (!persona) return res.status(404).json({ error: 'persona not found' });
    res.json(persona);
});

personasRouter.delete('/:id', (req, res) => {
    if (!deletePersona(req.db, req.paths, req.params.id)) return res.status(404).json({ error: 'persona not found' });
    res.json({ ok: true });
});

// ========================================
// AVATAR
// ========================================
//
// Rewritten IN PLACE at personas/{id}.png, the same deal as a character avatar: one persona
// has one picture, so a new uuid per upload would just leak files. That is why the static
// mount serves these on ETag revalidation rather than the immutable cache the gallery and
// the backgrounds use.
//
// The column holds the filename purely as a presence marker. Nothing reads it to BUILD a
// url: the client derives that from the id, so there is no caller-supplied string on the
// path into an <img src>.

const personaAvatarFile = (paths, id) => path.join(paths.personaAvatarsDir, `${id}.png`);

personasRouter.put('/:id/avatar', express.raw({ type: ['image/*', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
    if (!getPersona(req.db, req.params.id)) return res.status(404).json({ error: 'persona not found' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: 'image body required' });
    }
    let png;
    try {
        png = await sharp(req.body).png().toBuffer();
    } catch {
        return res.status(415).json({ error: 'body is not a decodable image' });
    }
    // the row first: a write a store guard refuses never reaches the file
    updatePersona(req.db, req.params.id, { avatar: `${req.params.id}.png` });
    fs.mkdirSync(req.paths.personaAvatarsDir, { recursive: true });
    writeFileAtomic(personaAvatarFile(req.paths, req.params.id), png);
    invalidatePersonaThumbs(req.paths.personaThumbsDir, req.params.id);
    res.json(getPersona(req.db, req.params.id));
});

personasRouter.delete('/:id/avatar', (req, res) => {
    if (!getPersona(req.db, req.params.id)) return res.status(404).json({ error: 'persona not found' });
    updatePersona(req.db, req.params.id, { avatar: null });
    try { fs.unlinkSync(personaAvatarFile(req.paths, req.params.id)); } catch { /* already gone is success */ }
    invalidatePersonaThumbs(req.paths.personaThumbsDir, req.params.id);
    res.json(getPersona(req.db, req.params.id));
});
