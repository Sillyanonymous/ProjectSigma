import fs from 'node:fs';
import crypto from 'node:crypto';

// tmp-then-rename so a crash mid-write never leaves a truncated file behind
export function writeFileAtomic(filePath, data) {
    const tmp = `${filePath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    try {
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, filePath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* never written, or still held: the write's own error is the answer */ }
        throw err;
    }
}
