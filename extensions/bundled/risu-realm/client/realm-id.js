// a Realm character's id, one grammar for both halves (the server imports ../client/realm-id.js)

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A Realm character's id (a uuid, lowercased), or null. */
export function realmIdOf(value) {
    const id = String(value ?? '').trim().toLowerCase();
    return ID_RE.test(id) ? id : null;
}
