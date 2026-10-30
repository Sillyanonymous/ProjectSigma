// Provider services, mounted at /api/provider-services: the proxies and sessions browsers cant do, and the hosted browser

import { registerBrowserRoutes } from './browser-service.js';
import { registerPygmalionRoutes } from './pygmalion-service.js';
import { registerBotbooruRoutes } from './botbooru-service.js';
import { registerCharacterTavernRoutes } from './charactertavern-service.js';
import { registerDataCatRoutes } from './datacat-service.js';
import { registerImgchestRoutes } from './imgchest-service.js';
import { registerCivitaiRoutes } from './civitai-service.js';
import { registerPixivRoutes } from './pixiv-service.js';
import { registerDropboxRoutes } from './dropbox-service.js';
import { registerJanitoraiBrowserRoutes } from './janitorai-service.js';
import { registerJannyBrowserConsumer } from './janny-service.js';

export function init(router) {
    router.get('/health', (req, res) => {
        const auth = req.headers.authorization;
        res.json({
            ok: true,
            basicAuth: typeof auth === 'string' && auth.startsWith('Basic '),
        });
    });

    // the browser first: a consumer registers itself when its own routes mount
    registerBrowserRoutes(router);
    registerPygmalionRoutes(router);
    registerBotbooruRoutes(router);
    registerCharacterTavernRoutes(router);
    registerDataCatRoutes(router);
    registerImgchestRoutes(router);
    registerCivitaiRoutes(router);
    registerPixivRoutes(router);
    registerDropboxRoutes(router);
    registerJanitoraiBrowserRoutes(router);
    registerJannyBrowserConsumer();
}
