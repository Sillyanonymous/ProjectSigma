// A JSON file read where a missing or unparsable file is simply absent.

import fs from 'node:fs';

/** The parsed file, or null when it cannot be read or parsed. */
export function readJsonFile(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
