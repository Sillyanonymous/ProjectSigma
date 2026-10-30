import { Router } from 'express';
import { isDocumentKey, readDocumentText, writeDocument, deleteDocument } from '../db/documents-store.js';

// Generic JSON store: one key = one JSON document (filter presets, css snippets, ui state, ...).
export const storeRouter = Router();

storeRouter.get('/:key', (req, res) => {
    if (!isDocumentKey(req.params.key)) return res.status(400).json({ error: 'bad key' });
    const text = readDocumentText(req.db, req.params.key);
    if (text === null) return res.status(404).json({ error: 'not found' });
    res.type('application/json').send(text);
});

storeRouter.put('/:key', (req, res) => {
    if (!isDocumentKey(req.params.key)) return res.status(400).json({ error: 'bad key' });
    if (req.body === undefined) return res.status(400).json({ error: 'JSON body required' });
    writeDocument(req.db, req.params.key, req.body);
    res.json({ ok: true });
});

storeRouter.delete('/:key', (req, res) => {
    if (!isDocumentKey(req.params.key)) return res.status(400).json({ error: 'bad key' });
    deleteDocument(req.db, req.params.key);
    res.json({ ok: true });
});
