// jannyai provider service: registers the hosted browser consumer its Cloudflare-gated card pages need; no routes of its own
import { registerBrowserConsumer } from './browser-service.js';

const JANNYAI_ORIGIN = 'https://jannyai.com';

export function registerJannyBrowserConsumer() {
    // the gate is on the character tree, so the warm page parks where its challenge is issued
    registerBrowserConsumer({ id: 'jannyai', origin: JANNYAI_ORIGIN, fetchPrefix: '/characters/', warmPath: '/characters/' });
}
