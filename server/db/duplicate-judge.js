// The rule's verdict on pairs of library characters for one run: the fingerprint gate first, then the full score, each card read once
import { prepareCard, scorePrepared, worthScoring, listingKeysOf, differentListings, listingVerdict } from '../lib/duplicate-match.js';
import { fingerprintsOf, listingTitlesOf, listingsOf } from './fingerprint-index.js';

// a run past this many prepared cards forgets its oldest: the scan visits names in order, so a card is wanted again soon or never
const CARD_CACHE = 4000;
// a card with no fingerprint yet: its keys and signature unknown, so the gate lets its pairs through to the score
const UNKNOWN = Object.freeze({ creatorKey: '', sig: null, mask: 0, unknown: true });

/**
 * A judge for one run, its cards, fingerprints, listing titles and links cached for the run's life. A probe hands judgeAgainst its own links.
 * @returns {{ print: Function, remember: Function, knowTitles: Function, card: Function, judge: Function, judgeAgainst: Function }} a verdict is the score, or null
 */
export function pairJudge(db) {
    // the fields the score reads, off the card's columns: a whole card (its lorebook too) is never parsed for this
    const readCard = db.prepare('SELECT name, creator, description, first_mes, personality, scenario, creator_notes, mes_example, system_prompt FROM characters WHERE id = ?');
    const cards = new Map();
    const prints = new Map();
    // a card's provider page titles are names of it too: the gate reads their keys, the score their variants
    const titles = new Map();
    const titlesOf = (id) => {
        if (!titles.has(id)) titles.set(id, listingTitlesOf(db, [id]).get(id) || []);
        return titles.get(id);
    };
    const withTitles = (p) => ({ ...p, listingKeys: listingKeysOf(titlesOf(p.id)) });
    const links = new Map();
    const linksOf = (id) => {
        if (!links.has(id)) links.set(id, listingsOf(db, [id]).get(id) || []);
        return links.get(id);
    };
    const card = (id) => {
        if (cards.has(id)) {
            const hit = cards.get(id);
            cards.delete(id);
            cards.set(id, hit);
            return hit;
        }
        const row = readCard.get(id);
        const prepared = row ? prepareCard(row, { listingTitles: titlesOf(id) }) : null;
        cards.set(id, prepared);
        if (cards.size > CARD_CACHE) cards.delete(cards.keys().next().value);
        return prepared;
    };
    const print = (id) => {
        if (!prints.has(id)) {
            const found = fingerprintsOf(db, [id]).get(id);
            prints.set(id, found ? withTitles(found) : null);
        }
        return prints.get(id);
    };
    /** Titles for many cards at once (the scan's one pass of the link rows), so no card asks for its own. */
    const knowTitles = (map, ids) => { for (const id of ids) titles.set(id, map.get(id) || []); };
    // any iterable (Related hands a Map's values): read once into a list, both passes walk it
    const remember = (list) => {
        const items = [...list];
        const fresh = items.filter(p => !titles.has(p.id));
        if (fresh.length) knowTitles(listingTitlesOf(db, fresh.map(p => p.id)), fresh.map(p => p.id));
        for (const p of items) prints.set(p.id, withTitles(p));
    };
    const verdict = (pa, cardA, pb, idB, linksA) => {
        if (!worthScoring(pa || UNKNOWN, pb || UNKNOWN)) return null;
        const ca = cardA(), cb = card(idB);
        const v = ca && cb ? scorePrepared(ca, cb) : null;
        if (!v?.confidence) return v;
        const site = differentListings(linksA(), linksOf(idB));
        if (!site) return v;
        // one site's two listings: the author's other card, the same card uploaded twice, or a text that cannot tell
        const said = listingVerdict(ca, cb);
        if (said === 'different') return null;
        const listed = said === 'same' ? `Uploaded twice on ${site}` : `Another ${site} listing, not confirmed by its text`;
        const matchReasons = [...v.matchReasons, listed];
        // the reason the reader most needs is never the one cut off
        return { ...v, listing: said, matchReasons, matchReason: [...v.matchReasons.slice(0, 2), listed].join(', ') };
    };
    return {
        print, remember, knowTitles, card,
        judge: (a, b) => (a === b ? null : verdict(print(a), () => card(a), print(b), b, () => linksOf(a))),
        judgeAgainst: (probe, id) => verdict(probe.print, () => probe.card, print(id), id, () => probe.links || []),
    };
}
