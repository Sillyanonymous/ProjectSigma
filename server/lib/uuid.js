// The one uuid grammar; a route building a path from an id refuses anything else first

/** The grammar's source, for a pattern that wraps a uuid (a file name, a temp name). */
export const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const UUID_RE = new RegExp(`^${UUID_SOURCE}$`, 'i');

/** Whether v is a uuid string, in either case. */
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
