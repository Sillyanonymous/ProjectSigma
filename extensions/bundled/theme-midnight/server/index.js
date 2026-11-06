// SPDX-License-Identifier: MIT

// Midnight, the server half: the account's own palettes, one JSON file each in its folder.
import crypto from 'node:crypto';
import { PALETTE_FIELDS as FIELDS, FIELD_RULES, PALETTE_ID as ID_RE } from '../client/palettes.js';

const DIR = 'palettes';
const COUNT_MAX = 24;
const BODY_MAX = 2048;

/**
 * A request's fields read by their rules: every field when whole, the ones given otherwise.
 * @returns {{ fields: object } | { error: string, status: number }}
 */
function readFields(body, whole) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'a palette is an object of name, accent, hue, glow and sky', status: 400 };
    if (JSON.stringify(body).length > BODY_MAX) return { error: `a palette is at most ${BODY_MAX} bytes`, status: 413 };
    const stranger = Object.keys(body).find(k => !FIELDS.includes(k));
    if (stranger) return { error: `unknown field "${stranger.slice(0, 40)}": a palette holds ${FIELDS.join(', ')}`, status: 400 };
    const fields = {};
    for (const key of FIELDS) {
        if (body[key] === undefined) {
            if (whole) return { error: FIELD_RULES[key].rule, status: 400 };
            continue;
        }
        const v = FIELD_RULES[key].read(body[key]);
        if (v === null) return { error: FIELD_RULES[key].rule, status: 400 };
        fields[key] = v;
    }
    if (!whole && !Object.keys(fields).length) return { error: `name a field to change: ${FIELDS.join(', ')}`, status: 400 };
    return { fields };
}

// a stored file read back under the same rules, so a file edited by hand is never applied half-valid
function storedPalette(id, raw) {
    if (!raw || typeof raw !== 'object' || raw.id !== id) return null;
    const out = { id };
    for (const key of FIELDS) {
        const v = FIELD_RULES[key].read(raw[key]);
        if (v === null) return null;
        out[key] = v;
    }
    out.created = Number.isFinite(raw.created) ? raw.created : 0;
    return out;
}

/** @type {import('../../../../docs/extensions').ServerExtension['register']} */
export function register(router, ctx) {
    const fileOf = (id) => `${DIR}/${id}.json`;
    const idsOf = (folder) => folder.list(DIR).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5));
    // every palette the folder holds, oldest first; a file that is not one is named, never applied
    const readAll = (folder) => {
        const palettes = [], unreadable = [];
        for (const id of idsOf(folder)) {
            let p = null;
            try { p = ID_RE.test(id) ? storedPalette(id, folder.readJson(fileOf(id))) : null; } catch { /* named below */ }
            if (p) palettes.push(p);
            else unreadable.push(id);
        }
        palettes.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
        return { palettes, unreadable };
    };
    const one = (folder, id) => {
        if (!ID_RE.test(id) || !folder.list(DIR).includes(`${id}.json`)) return { status: 404, body: { error: 'no such palette' } };
        let p = null;
        try { p = storedPalette(id, folder.readJson(fileOf(id))); } catch { /* answered below */ }
        return p ? { status: 200, body: { palette: p } } : { status: 422, body: { error: 'the palette\'s file is not a palette any more' } };
    };

    router.get('/palettes', (req, res) => res.json(readAll(ctx.files.user(req))));

    router.get('/palettes/:id', (req, res) => {
        const { status, body } = one(ctx.files.user(req), req.params.id);
        res.status(status).json(body);
    });

    router.post('/palettes', (req, res) => {
        const read = readFields(req.body, true);
        if (read.error) return res.status(read.status).json({ error: read.error });
        const folder = ctx.files.user(req);
        if (idsOf(folder).length >= COUNT_MAX) return res.status(400).json({ error: `an account keeps at most ${COUNT_MAX} palettes of its own` });
        let id;
        do id = `p-${crypto.randomBytes(4).toString('hex')}`; while (folder.list(DIR).includes(`${id}.json`));
        const palette = { id, ...read.fields, created: Date.now() };
        folder.writeJson(fileOf(id), palette);
        res.json({ palette, ...readAll(folder) });
    });

    router.put('/palettes/:id', (req, res) => {
        const folder = ctx.files.user(req);
        const was = one(folder, req.params.id);
        if (was.status !== 200) return res.status(was.status).json(was.body);
        const read = readFields(req.body, false);
        if (read.error) return res.status(read.status).json({ error: read.error });
        const palette = { ...was.body.palette, ...read.fields };
        folder.writeJson(fileOf(palette.id), palette);
        res.json({ palette, ...readAll(folder) });
    });

    router.delete('/palettes/:id', (req, res) => {
        const folder = ctx.files.user(req);
        const { id } = req.params;
        if (!ID_RE.test(id) || !folder.list(DIR).includes(`${id}.json`)) return res.status(404).json({ error: 'no such palette' });
        folder.remove(fileOf(id));
        res.json(readAll(folder));
    });
}
