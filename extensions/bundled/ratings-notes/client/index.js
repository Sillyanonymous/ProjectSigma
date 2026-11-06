// SPDX-License-Identifier: MIT

// Ratings and Notes, the client half: a grid chip, a details tab and a selection verb. The chip reads
// row.ext, never the server.
import { NOTE_MAX, BATCH_MAX } from './limits.js';

const ID = 'ratings-notes';

export default {
    init(ctx) {
        const { CoreAPI } = ctx;
        const esc = (s) => CoreAPI.escapeHtml(s);
        const call = ctx.server.call;

        ctx.ui.contribute('character.card.badge', {
            id: 'rating',
            render: (row) => {
                const rating = row.ext?.[ID]?.rating;
                return rating ? { icon: 'fa-star', label: String(rating), tone: 'accent' } : null;
            },
        });

        // the tab the details show now, so a write made elsewhere can repaint it
        let shown = null;

        // the five stars, lit up to a rating: the tab's control, and the selection's dialog
        const starsHtml = (rating) => [1, 2, 3, 4, 5].map(n => `<button type="button" class="rn-star${rating >= n ? ' is-on' : ''}" data-rating="${n}"
                title="${n} star${n === 1 ? '' : 's'}" aria-label="${n} star${n === 1 ? '' : 's'}" aria-pressed="${rating === n}"><i class="fa-solid fa-star"></i></button>`).join('');

        const paint = (view, entry, status = '') => {
            // a note typed but not saved outlives a repaint; typed is against what the box held once painted, as the parser folds a CRLF
            const box = view.entry ? view.pane.querySelector('.rn-note') : null;
            const typed = box && box.value !== view.painted ? box.value : null;
            const stars = starsHtml(entry.rating);
            // the parser drops the newline right after <textarea>, so a note that starts with its own keeps it
            view.pane.innerHTML = `
                <div class="rn-pane">
                    <div class="rn-row">
                        <div class="rn-stars" role="group" aria-label="Rating">${stars}</div>
                        <span class="rn-hint">${entry.rating ? 'Tap the lit star again to clear it' : 'Not rated'}</span>
                    </div>
                    <label class="rn-label">Private note
                        <textarea class="glass-input rn-note" rows="6" maxlength="${NOTE_MAX}" placeholder="Only you see this note.">\n${esc(entry.note)}</textarea>
                    </label>
                    <div class="rn-foot">
                        <span class="rn-status" role="status">${esc(status)}</span>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-primary rn-save">Save Note</button>
                    </div>
                </div>`;
            view.entry = entry;
            const note = view.pane.querySelector('.rn-note');
            view.painted = note.value;
            if (typed !== null && typed !== view.painted) note.value = typed;
            // a change heard while the note had focus is read once the reader leaves it
            note.addEventListener('blur', () => {
                if (!view.owed || !view.isCurrent()) return;
                view.owed = false;
                refresh(view);
            });
            view.pane.querySelectorAll('.rn-star').forEach(btn => btn.addEventListener('click', () => {
                const n = Number(btn.dataset.rating);
                save(view, { rating: n === view.entry.rating ? null : n });
            }));
            view.pane.querySelector('.rn-save').addEventListener('click', () => {
                save(view, { note: view.pane.querySelector('.rn-note').value });
            });
        };

        const load = async (view) => {
            view.pane.innerHTML = '<div class="rn-pane"><span class="rn-status">Loading...</span></div>';
            try {
                const entry = await call(`/entry/${encodeURIComponent(view.character.id)}`);
                if (view.isCurrent()) paint(view, entry);
            } catch (e) {
                if (view.isCurrent()) view.pane.innerHTML = `<div class="rn-pane"><span class="rn-status is-error">The rating could not be read: ${esc(e.message)}</span></div>`;
            }
        };

        // a re-read after a change elsewhere moves nothing unless the entry did, so a write's own echo never wipes it
        const refresh = async (view) => {
            try {
                const entry = await call(`/entry/${encodeURIComponent(view.character.id)}`);
                if (view.isCurrent() && (entry.rating !== view.entry?.rating || entry.note !== view.entry?.note)) paint(view, entry);
            } catch { /* the tab keeps what it shows; the next open re-reads */ }
        };

        const save = async (view, changes) => {
            try {
                const entry = await call(`/entry/${encodeURIComponent(view.character.id)}`, 'PUT', changes);
                if (view.isCurrent()) paint(view, entry, 'note' in changes ? 'Note saved' : '');
            } catch (e) {
                const status = view.isCurrent() && view.pane.querySelector('.rn-status');
                if (status) { status.textContent = `Not saved: ${e.message}`; status.classList.add('is-error'); }
            }
        };

        ctx.ui.contribute('character.details.tab', {
            id: 'rating',
            label: 'Rating',
            icon: 'fa-star',
            render: async (pane, { character, isCurrent }) => {
                shown = { pane, character, isCurrent, entry: null };
                await load(shown);
            },
        });

        // another tab's write reaches the open tab, never over a note being typed (that waits for its blur)
        const reread = () => {
            if (shown.pane.contains(document.activeElement) && document.activeElement?.classList.contains('rn-note')) { shown.owed = true; return; }
            refresh(shown);
        };
        ctx.events.on('character.updated', ({ ids, fields }) => {
            if (!shown?.isCurrent() || !ids.includes(shown.character.id)) return;
            if (!fields.some(f => f.startsWith(`${ID}.`))) return;
            reread();
        });
        // a resync (the feed was away) or an import: what the tab shows may have moved meanwhile
        ctx.events.on('library.changed', () => {
            if (shown?.isCurrent()) reread();
        });

        // a selection's rating is picked on the tab's own stars in a dialog; a dismissal answers null
        let picking = null;
        const answerPick = (n) => { const done = picking; picking = null; done?.(n); };
        const rateDialog = ctx.ui.dialog({ id: 'rate', label: 'Rate the Selection', icon: 'fa-star-half-stroke', onClose: () => answerPick(null) });
        const pickRating = (count) => {
            const body = rateDialog.open({ title: `Rate ${count} character${count === 1 ? '' : 's'}` });
            body.innerHTML = `
                <div class="rn-pane">
                    <div class="rn-stars" role="group" aria-label="Rating">${starsHtml(0)}</div>
                    <div class="rn-foot">
                        <span class="rn-hint">Notes stay as they are.</span>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary rn-clear">Clear the Rating</button>
                    </div>
                </div>`;
            body.addEventListener('click', (e) => {
                const star = e.target.closest?.('.rn-star');
                const n = star ? Number(star.dataset.rating) : e.target.closest?.('.rn-clear') ? 0 : null;
                if (n === null) return;
                const done = picking;
                picking = null;
                rateDialog.close({ force: true });
                done?.(n);
            });
            return new Promise((resolve) => { picking = resolve; });
        };

        // a half star: the selection's toolbar already carries Favorite's full one, icon-only on a phone
        ctx.ui.addAction('bulk', {
            id: 'rate',
            label: 'Rate the Selection',
            icon: 'fa-star-half-stroke',
            run: async ({ characters }) => {
                const ids = characters.map(c => c.id).filter(Boolean);
                if (!ids.length) return;
                const n = await pickRating(ids.length);
                if (n === null) return;
                let affected = 0, skipped = 0;
                for (let i = 0; i < ids.length; i += BATCH_MAX) {
                    try {
                        const out = await call('/ratings', 'PUT', { ids: ids.slice(i, i + BATCH_MAX), rating: n || null });
                        affected += out.affected.length;
                        skipped += out.skipped.length;
                    } catch (e) {
                        // the chunks before this one are written: say how many, then why the rest are not
                        const said = affected ? `${n ? 'Rated' : 'Cleared the rating of'} ${affected} character${affected === 1 ? '' : 's'} before it stopped; the rest were not`
                            : n ? 'Nothing was rated' : 'No rating was cleared';
                        CoreAPI.showToast(`${said}: ${e.message}`, 'error');
                        return;
                    }
                }
                const done = n ? `Rated ${affected} character${affected === 1 ? '' : 's'} ${n} of 5` : `Cleared the rating of ${affected} character${affected === 1 ? '' : 's'}`;
                CoreAPI.showToast(skipped ? `${done}; ${skipped} no longer in the library` : done, skipped ? 'warning' : 'success');
            },
        });
    },
};
