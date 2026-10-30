// pygmalion provider service, mounted by provider-services.js init() under /api/provider-services
import { formLoginRelay } from './shared.js';

// =============================================================================
// Pygmalion: login proxy
// =============================================================================

const PYGMALION_AUTH_URL = 'https://auth.pygmalion.chat/session';
const PYGMALION_ORIGIN = 'https://pygmalion.chat';

export function registerPygmalionRoutes(router) {
    formLoginRelay(router, '/pyg-login', { url: PYGMALION_AUTH_URL, headers: { 'Origin': PYGMALION_ORIGIN, 'Referer': PYGMALION_ORIGIN + '/' }, label: 'Pygmalion' });
}
