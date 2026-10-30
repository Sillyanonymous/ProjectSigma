import express, { Router } from 'express';
import { chatExists } from '../db/chats-store.js';
import { sessionExists } from '../db/studio-store.js';
import { listAttachments, addAttachment, deleteAttachment } from '../db/attachments-store.js';
import { imageSizeOf } from '../lib/image-size.js';

// an owner's own pictures, by the owner the path names: a chat's gallery beside its character's, a studio session's references
const listOf = (kind, exists, notFound) => (req, res) => {
    if (!exists(req.db, req.params.id)) return res.status(404).json({ error: notFound });
    res.json({ items: listAttachments(req.db, { kind, id: req.params.id }) });
};

// raw body upload, the name on ?name=; bytes the owner holds already answer that attachment, created false
const addTo = (kind, exists, notFound) => async (req, res) => {
    if (!exists(req.db, req.params.id)) return res.status(404).json({ error: notFound });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'file body required' });
    const size = await imageSizeOf(req.body);
    res.json(addAttachment(req.db, req.paths, { kind, id: req.params.id }, String(req.query.name || 'picture.png'), req.body, size));
};
const rawBody = express.raw({ type: () => true, limit: '50mb' });

export const chatAttachmentsRouter = Router({ mergeParams: true });
chatAttachmentsRouter.get('/', listOf('chat', chatExists, 'chat not found'));
chatAttachmentsRouter.post('/', rawBody, addTo('chat', chatExists, 'chat not found'));

export const studioAttachmentsRouter = Router({ mergeParams: true });
studioAttachmentsRouter.get('/', listOf('studio', sessionExists, 'no such session'));
studioAttachmentsRouter.post('/', rawBody, addTo('studio', sessionExists, 'no such session'));

export const attachmentsRouter = Router();

// the messages that showed it lose it (their links go with the row) and are named in the answer
attachmentsRouter.delete('/:attachmentId', (req, res) => {
    const id = Number(req.params.attachmentId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'attachment id must be a positive integer' });
    const gone = deleteAttachment(req.db, req.paths, id);
    if (!gone) return res.status(404).json({ error: 'attachment not found' });
    res.json({ ok: true, messages: gone.messages });
});
