// A server check an admin's tab keeps: the read (a 403 marks an account that cannot act), the check, and the daily look.

/** The most a switched-on check waits before it asks again. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One admin-gated check against the server; the last read or check sent wins, so an answer overtaken by a later one is dropped.
 * @param {object} o readAnswer, read() and ask(maxAge) (the caller's own requests), adopt(answer), onChecking(bool), isOn(), checkedAt()
 * @returns {{ read: Function, check: Function, lookIfDue: Function, isAdmin: Function }}
 */
export function adminCheck({ readAnswer, read: readCall, ask, adopt, onChecking, isOn, checkedAt }) {
    let admin = false;
    let checking = false;
    let seq = 0;

    /** Read the last check; a non-admin reads nothing. */
    async function read() {
        const mine = ++seq;
        try {
            const resp = await readCall();
            if (resp.status === 403) { admin = false; return; }
            if (!resp.ok) return;
            const answer = await resp.json();
            if (mine !== seq) return;
            admin = true;
            adopt(answer);
        } catch { /* the next record or a resync reads again */ }
    }

    /** Ask the server now, or answer a check younger than maxAge milliseconds; null for an account that cannot act. */
    async function check({ maxAge = 0 } = {}) {
        if (!admin) return null;
        const mine = ++seq;
        checking = true;
        onChecking(true);
        try {
            const answer = await readAnswer(await ask(maxAge));
            if (mine === seq) adopt(answer);
            return answer;
        } catch (e) {
            if (mine === seq) onChecking(false);
            throw e;
        } finally {
            checking = false;
        }
    }

    /** With the switch on, a check a day old or never made is made now; answers whether it asked. */
    async function lookIfDue(now = Date.now()) {
        if (!admin || !isOn() || checking) return false;
        const at = checkedAt();
        if (at && now - at < DAY_MS) return false;
        try { await check({ maxAge: DAY_MS }); } catch { /* the next look asks again */ }
        return true;
    }

    return { read, check, lookIfDue, isAdmin: () => admin };
}
