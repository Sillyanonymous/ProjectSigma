// The single SSE implementation for the LLM layer: adapters parse through parseSse, routes emit through sseWrite

import { LlmError, networkError } from './errors.js';

// fetch body -> { event, data } frames. a failed read is the network's, so before the first frame it retries
export async function* parseSse(body, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            let read;
            try {
                read = await reader.read();
            } catch (err) {
                if (signal?.aborted || err?.name === 'AbortError' || err instanceof LlmError) throw err;
                throw networkError(err);
            }
            const { done, value } = read;
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // normalize frame boundaries, then split complete frames off the buffer
            let boundary;
            while ((boundary = buffer.search(/\r\n\r\n|\n\n|\r\r/)) !== -1) {
                const rawFrame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + (buffer[boundary] === '\r' && buffer[boundary + 1] === '\n' ? 4 : 2));
                const frame = { event: null, data: [] };
                for (const line of rawFrame.split(/\r\n|\n|\r/)) {
                    if (!line || line.startsWith(':')) continue;
                    const colon = line.indexOf(':');
                    const field = colon === -1 ? line : line.slice(0, colon);
                    let value2 = colon === -1 ? '' : line.slice(colon + 1);
                    if (value2.startsWith(' ')) value2 = value2.slice(1);
                    if (field === 'event') frame.event = value2;
                    else if (field === 'data') frame.data.push(value2);
                }
                if (frame.data.length) yield { event: frame.event, data: frame.data.join('\n') };
            }
        }
    } finally {
        reader.cancel().catch(() => { /* a stream already ended or errored has nothing to release */ });
    }
}

// Downstream emitter: one place owns the headers and the wire format.
export function sseOpen(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        // no-transform: a proxy that compresses holds the events back to fill its window
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
}

export function sseWrite(res, event, data) {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
