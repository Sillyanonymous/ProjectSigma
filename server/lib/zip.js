import fs from 'node:fs';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { crc32, crc32Update, crc32Final, CRC32_INIT } from './png-card.js';
import { httpError } from './http-error.js';

// Minimal zip writer/reader for bundles and charx. zip64 only past the classic limits, so stock readers open normal bundles

const U32 = 0xFFFFFFFF;
const U16 = 0xFFFF;
const MB = 1024 * 1024;

// an archive's budget is `ratio` times its size, at least `floor`; a member takes its kind's route cap where one exists
export const ZIP_IMPORT_LIMITS = Object.freeze({ json: 50 * MB, card: 100 * MB, media: 200 * MB, ratio: 20, floor: 512 * MB });

/** A member's name as a message quotes it (a name may run to 64 KB). */
export const quoteName = (name) => JSON.stringify(name.length > 160 ? `${name.slice(0, 160)}...` : name);
const mb = (bytes) => `${Math.ceil(bytes / MB)} MB`;

export class ZipFileWriter {
    constructor(outPath) {
        this.fd = fs.openSync(outPath, 'w');
        this.offset = 0;
        this.central = [];
    }

    #write(buf) {
        fs.writeSync(this.fd, buf);
        this.offset += buf.length;
    }

    /** Append one entry. `source` is a Buffer or a path to stream from disk. */
    add(name, source) {
        const nameBuf = Buffer.from(name, 'utf8');
        const headerOffset = this.offset;
        const fromFile = typeof source === 'string';
        const size = fromFile ? fs.statSync(source).size : source.length;
        if (size >= U32) throw new Error(`zip member too large (>=4GB): ${name}`);

        let crc;
        if (fromFile) {
            // CRC pass then copy pass: the header needs the crc first, and a data descriptor breaks stock readers
            const rfd = fs.openSync(source, 'r');
            try {
                const chunk = Buffer.alloc(1 << 20);
                let c = CRC32_INIT;
                let read;
                while ((read = fs.readSync(rfd, chunk, 0, chunk.length)) > 0) c = crc32Update(c, chunk.subarray(0, read));
                crc = crc32Final(c);
                this.#localHeader(nameBuf, crc, size);
                let pos = 0;
                while ((read = fs.readSync(rfd, chunk, 0, chunk.length, pos)) > 0) { this.#write(chunk.subarray(0, read)); pos += read; }
                if (pos !== size) throw new Error(`zip member changed size while being written: ${name}`);
            } finally { fs.closeSync(rfd); }
        } else {
            crc = crc32(source);
            this.#localHeader(nameBuf, crc, size);
            this.#write(source);
        }
        this.central.push({ nameBuf, crc, size, headerOffset });
    }

    #localHeader(nameBuf, crc, size) {
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(45, 4);           // version needed
        h.writeUInt16LE(0x0800, 6);       // UTF-8 names
        h.writeUInt16LE(0, 8);            // STORE
        h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); // time/date (fixed)
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(size, 18);
        h.writeUInt32LE(size, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        h.writeUInt16LE(0, 28);
        this.#write(h);
        this.#write(nameBuf);
    }

    finalize() {
        const cdStart = this.offset;
        for (const e of this.central) {
            const needs64 = e.headerOffset >= U32;
            const extra = needs64 ? Buffer.alloc(12) : Buffer.alloc(0);
            if (needs64) {
                extra.writeUInt16LE(0x0001, 0);
                extra.writeUInt16LE(8, 2);
                extra.writeBigUInt64LE(BigInt(e.headerOffset), 4);
            }
            const c = Buffer.alloc(46);
            c.writeUInt32LE(0x02014b50, 0);
            c.writeUInt16LE(45, 4); c.writeUInt16LE(45, 6);
            c.writeUInt16LE(0x0800, 8);
            c.writeUInt16LE(0, 10);           // STORE
            c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
            c.writeUInt32LE(e.crc, 16);
            c.writeUInt32LE(e.size, 20);
            c.writeUInt32LE(e.size, 24);
            c.writeUInt16LE(e.nameBuf.length, 28);
            c.writeUInt16LE(extra.length, 30);
            c.writeUInt32LE(needs64 ? U32 : e.headerOffset, 42);
            // record byte order is [fixed 46][name][extra]
            this.#write(c);
            this.#write(e.nameBuf);
            if (extra.length) this.#write(extra);
        }
        const cdSize = this.offset - cdStart;
        const count = this.central.length;
        const needs64 = cdStart >= U32 || cdSize >= U32 || count >= U16;
        if (needs64) {
            const eocd64at = this.offset;
            const r = Buffer.alloc(56);
            r.writeUInt32LE(0x06064b50, 0);
            r.writeBigUInt64LE(44n, 4);
            r.writeUInt16LE(45, 12); r.writeUInt16LE(45, 14);
            r.writeBigUInt64LE(BigInt(count), 24);
            r.writeBigUInt64LE(BigInt(count), 32);
            r.writeBigUInt64LE(BigInt(cdSize), 40);
            r.writeBigUInt64LE(BigInt(cdStart), 48);
            this.#write(r);
            const loc = Buffer.alloc(20);
            loc.writeUInt32LE(0x07064b50, 0);
            loc.writeBigUInt64LE(BigInt(eocd64at), 8);
            loc.writeUInt32LE(1, 16);
            this.#write(loc);
        }
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(Math.min(count, U16), 8);
        eocd.writeUInt16LE(Math.min(count, U16), 10);
        eocd.writeUInt32LE(Math.min(cdSize, U32), 12);
        eocd.writeUInt32LE(Math.min(cdStart, U32), 16);
        this.#write(eocd);
        fs.closeSync(this.fd);
    }
}

/**
 * Parse the central directory of a zip on disk; offsets are the file's even with bytes ahead of the zip.
 * @returns {Array<{name: string, method: number, size: number, compressedSize: number, offset: number}>}
 */
export function readZipIndex(zipPath) {
    const fd = fs.openSync(zipPath, 'r');
    try {
        const fileSize = fs.fstatSync(fd).size;
        const tailLen = Math.min(fileSize, U16 + 22);
        const tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tailLen, fileSize - tailLen);
        let eocdAt = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06054b50) { eocdAt = i; break; }
        }
        if (eocdAt < 0) throw new Error('not a zip archive (no end-of-central-directory)');
        const eocdAbs = fileSize - tailLen + eocdAt;
        let count = tail.readUInt16LE(eocdAt + 10);
        let cdSize = tail.readUInt32LE(eocdAt + 12);
        let cdStart = tail.readUInt32LE(eocdAt + 16);
        const maxed = count === U16 || cdStart === U32 || cdSize === U32;
        // the directory ends where the record after it begins; a gap before that is bytes
        // written ahead of the archive
        let dirEnd = eocdAbs;
        // zip64: a locator 20 bytes before the EOCD names the record that follows the directory
        if (eocdAt >= 20 && tail.readUInt32LE(eocdAt - 20) === 0x07064b50) {
            const recorded = Number(tail.readBigUInt64LE(eocdAt - 20 + 8));
            // the record sits right before its locator (56 bytes without extensible data), which
            // finds it after a prefix; the recorded offset serves a record carrying more
            const r = Buffer.alloc(56);
            const isRecord = (at) => at >= 0 && fs.readSync(fd, r, 0, 56, at) === 56 && r.readUInt32LE(0) === 0x06064b50;
            let at = eocdAbs - 20 - 56;
            if (!isRecord(at)) at = recorded;
            if (isRecord(at)) {
                dirEnd = at;
                if (maxed) {
                    count = Number(r.readBigUInt64LE(32));
                    cdSize = Number(r.readBigUInt64LE(40));
                    cdStart = Number(r.readBigUInt64LE(48));
                }
            } else if (maxed) throw new Error('corrupt zip64 end-of-central-directory');
        }
        const delta = dirEnd - (cdStart + cdSize);
        if (delta < 0) throw new Error('corrupt zip (the central directory overruns its end record)');
        cdStart += delta;
        const cd = Buffer.alloc(cdSize);
        fs.readSync(fd, cd, 0, cdSize, cdStart);
        const entries = [];
        let p = 0;
        for (let i = 0; i < count; i++) {
            if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
            const method = cd.readUInt16LE(p + 10);
            const crc = cd.readUInt32LE(p + 16);
            let compressedSize = cd.readUInt32LE(p + 20);
            let size = cd.readUInt32LE(p + 24);
            const nameLen = cd.readUInt16LE(p + 28);
            const extraLen = cd.readUInt16LE(p + 30);
            const commentLen = cd.readUInt16LE(p + 32);
            let offset = cd.readUInt32LE(p + 42);
            const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
            if (size === U32 || compressedSize === U32 || offset === U32) {
                // the 0x0001 extra holds an 8-byte field for each maxed one, in the spec's order:
                // size, compressed size, offset
                let ep = p + 46 + nameLen;
                const end = ep + extraLen;
                while (ep + 4 <= end) {
                    const id = cd.readUInt16LE(ep), len = cd.readUInt16LE(ep + 2);
                    if (id === 0x0001) {
                        let fp = ep + 4;
                        const field = () => {
                            if (fp + 8 > ep + 4 + len) throw new Error(`${quoteName(name)} has a short zip64 extra`);
                            const v = Number(cd.readBigUInt64LE(fp));
                            fp += 8;
                            return v;
                        };
                        if (size === U32) size = field();
                        if (compressedSize === U32) compressedSize = field();
                        if (offset === U32) offset = field();
                        break;
                    }
                    ep += 4 + len;
                }
            }
            // a directory that claims more bytes than the file holds is lying; the read would
            // allocate what it claims
            if (offset + delta + compressedSize > fileSize) throw new Error(`${quoteName(name)} runs past the end of the archive`);
            entries.push({ name, method, crc, size, compressedSize, offset: offset + delta });
            p += 46 + nameLen + extraLen + commentLen;
        }
        return entries;
    } finally { fs.closeSync(fd); }
}

/**
 * Refuse an archive before any read: members over the budget in all, or one over its cap. Throws a 400.
 * @param {string} zipPath
 * @param {object[]} index readZipIndex's answer
 * @param {((name: string) => number) | null} [capOf] the most a member of that name may declare
 * @returns {number} the archive's budget in bytes
 */
export function checkArchive(zipPath, index, capOf = null) {
    const budget = Math.max(ZIP_IMPORT_LIMITS.floor, ZIP_IMPORT_LIMITS.ratio * fs.statSync(zipPath).size);
    let total = 0;
    for (const entry of index) {
        const cap = capOf ? capOf(entry.name) : budget;
        if (entry.size > cap) throw httpError(400, `the archive's member ${quoteName(entry.name)} unpacks to ${mb(entry.size)}; an import reads at most ${mb(cap)} from one member`);
        total += entry.size;
    }
    if (total > budget) throw httpError(400, `the archive unpacks to ${mb(total)}, more than an import takes from it (${ZIP_IMPORT_LIMITS.ratio} times its own size, at least ${mb(ZIP_IMPORT_LIMITS.floor)})`);
    return budget;
}

/**
 * Read one entry's bytes, bounded by `max` and its declared size, checked against size and crc; a refusal is a 400.
 * @param {object} [opts]
 * @param {number} [opts.max] the most the entry may declare (a media file's cap unless said)
 */
export function readZipEntry(zipPath, entry, { max = ZIP_IMPORT_LIMITS.media } = {}) {
    refuseDeclared(entry, max);
    const fd = fs.openSync(zipPath, 'r');
    let raw;
    try {
        const lh = Buffer.alloc(30);
        fs.readSync(fd, lh, 0, 30, entry.offset);
        // readZipIndex held compressedSize to the file's own size, so this allocation is bounded
        raw = Buffer.alloc(entry.compressedSize);
        fs.readSync(fd, raw, 0, entry.compressedSize, dataStart(entry, lh));
    } finally { fs.closeSync(fd); }
    if (!isDeflated(entry)) return checkedBytes(entry, raw);
    let out;
    try { out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }); } catch (e) { throw httpError(400, inflateFailure(entry, e)); }
    return checkedBytes(entry, out);
}

const inflateRawAsync = promisify(zlib.inflateRaw);

/** readZipEntry with the read and inflate off the main thread, same bounds and checks. */
export async function readZipEntryAsync(zipPath, entry, { max = ZIP_IMPORT_LIMITS.media } = {}) {
    refuseDeclared(entry, max);
    const fh = await fs.promises.open(zipPath, 'r');
    let raw;
    try {
        const lh = Buffer.alloc(30);
        await fh.read(lh, 0, 30, entry.offset);
        raw = Buffer.alloc(entry.compressedSize);
        await fh.read(raw, 0, entry.compressedSize, dataStart(entry, lh));
    } finally { await fh.close(); }
    if (!isDeflated(entry)) return checkedBytes(entry, raw);
    let out;
    try { out = await inflateRawAsync(raw, { maxOutputLength: Math.max(1, entry.size) }); } catch (e) { throw httpError(400, inflateFailure(entry, e)); }
    return checkedBytes(entry, out);
}

// ---- the rules both entry readers share, each a 400 naming the entry

function refuseDeclared(entry, max) {
    if (entry.size > max) throw httpError(400, `the archive's member ${quoteName(entry.name)} unpacks to ${mb(entry.size)}; at most ${mb(max)} is read from one member`);
}

// where the entry's bytes start, past its local header and the name and extra that header declares
function dataStart(entry, lh) {
    if (lh.readUInt32LE(0) !== 0x04034b50) throw httpError(400, `corrupt local header for ${quoteName(entry.name)}`);
    return entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
}

// STORE answers false, DEFLATE true, anything else is refused
function isDeflated(entry) {
    if (entry.method === 0) return false;
    if (entry.method === 8) return true;
    throw httpError(400, `unsupported compression method ${entry.method} for ${quoteName(entry.name)}`);
}

function inflateFailure(entry, e) {
    return e.code === 'ERR_BUFFER_TOO_LARGE' ? `${quoteName(entry.name)} unpacks past the size it declares` : `${quoteName(entry.name)} cannot be inflated: ${e.message}`;
}

function checkedBytes(entry, out) {
    if (out.length !== entry.size || crc32(out) !== entry.crc) throw httpError(400, `${quoteName(entry.name)} does not match its size or checksum in the archive's directory`);
    return out;
}
