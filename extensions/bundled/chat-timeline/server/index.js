// SPDX-License-Identifier: MIT

// Chat Timeline, the server half: a character's chats as one tree, folded with the client's own model
// file and answered as runs.
import { createTrie, buildSegments, toWire, matchesQuery, snippetAround } from '../client/graph.js';

// the shared loop is let go between chats once this many rows were read since the last yield
const MESSAGES_PER_YIELD = 2000;
const HITS_MAX = 2000;
const SNIPPETS_MAX = 200;
const QUERY_MAX = 200;

// 1 or 0 (true or false) as the request names it, the fallback when it names nothing, undefined otherwise
function flagOf(raw, fallback) {
    if (raw === undefined) return fallback;
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return undefined;
}

export function register(router, ctx) {
    const characterOr404 = (req, res) => {
        const charId = String(req.params.charId || '');
        if (ctx.stores.characters.characterExists(req.db, charId)) return charId;
        res.status(404).json({ error: 'no such character' });
        return null;
    };

    // each chat read whole in one statement, so a chat is a consistent snapshot; the loop is let go between chats
    async function* outlines(db, chats) {
        let sinceYield = 0;
        for (const chat of chats) {
            if (sinceYield >= MESSAGES_PER_YIELD) {
                sinceYield = 0;
                await new Promise(r => setImmediate(r));
            }
            const rows = ctx.stores.chats.listMessageOutline(db, chat.id);
            sinceYield += rows.length;
            yield { chat, rows };
        }
    }

    // the tree: chats newest first, runs folded as the request asks, else as the account's settings say
    router.get('/characters/:charId/tree', async (req, res) => {
        const fold = flagOf(req.query.fold, ctx.setting(req.db, 'collapseRuns') !== false);
        const roads = flagOf(req.query.roads, ctx.setting(req.db, 'showRoads') === true);
        if (fold === undefined || roads === undefined) return res.status(400).json({ error: 'fold and roads are 1 or 0' });
        const charId = characterOr404(req, res);
        if (!charId) return;
        const trie = createTrie();
        const chats = [];
        for await (const { chat, rows } of outlines(req.db, ctx.stores.chats.listChatsForChar(req.db, charId))) {
            trie.add({ id: chat.id, messages: rows });
            chats.push({ id: chat.id, name: chat.name, messages: rows.length, lastAt: chat.lastMesAt ?? null });
        }
        const { root, nodes } = trie.finish();
        res.json({ charId, fold, roads, nodes, chats, segments: toWire(buildSegments(root, { collapse: fold, roads })) });
    });

    // a search as message addresses (a chat and its seqs), which stay true across a re-read of the tree
    router.get('/characters/:charId/search', async (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (!q || q.length > QUERY_MAX) return res.status(400).json({ error: `q is the text to find, 1 to ${QUERY_MAX} characters` });
        const charId = characterOr404(req, res);
        if (!charId) return;
        const hits = [];
        // the line around the match for the first hits, so a find can show what it found
        const snippets = [];
        let total = 0;
        let truncated = false;
        for await (const { chat, rows } of outlines(req.db, ctx.stores.chats.listChatsForChar(req.db, charId))) {
            const seqs = [];
            for (const r of rows) {
                if (!matchesQuery(r.mes, q)) continue;
                if (total === HITS_MAX) { truncated = true; break; }
                seqs.push(r.seq);
                if (snippets.length < SNIPPETS_MAX) snippets.push({ chatId: chat.id, seq: r.seq, text: snippetAround(r.mes, q) });
                total++;
            }
            if (seqs.length) hits.push({ chatId: chat.id, seqs });
            if (truncated) break;
        }
        res.json({ q, hits, total, truncated, snippets });
    });
}
