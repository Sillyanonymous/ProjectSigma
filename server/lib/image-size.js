// An image's pixel size read off its header by sharp; kept apart from stored-file.js, whose rules are pure
import sharp from 'sharp';

/** The width and height of the bytes, nulls when sharp cannot read them (an unreadable file still stores). */
export async function imageSizeOf(bytes) {
    try {
        const m = await sharp(bytes).metadata();
        return { width: m.width ?? null, height: m.height ?? null };
    } catch {
        return { width: null, height: null };
    }
}
