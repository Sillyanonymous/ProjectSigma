/* ========================================
   Project Σ - Mobile JS
   Clean mobile enhancements - no main code changes
   ======================================== */

/* ========================================
   DATE COMPATIBILITY FIX
   Mobile Chromium (Samsung Internet, Brave) rejects date strings that desktop
   Chrome accepts, so a manual regex parser backs the Date constructor, the
   toLocaleDateString safety net and the DOM-level chat-card fixer.
   NO Response/fetch/JSON.parse patching - those break imports.
   ======================================== */
(function datePatch() {
    var OrigDate = Date;

    // month names for the manual parser
    var MONTHS = {
        jan:0, january:0, feb:1, february:1, mar:2, march:2,
        apr:3, april:3, may:4, jun:5, june:5, jul:6, july:6,
        aug:7, august:7, sep:8, sept:8, september:8,
        oct:9, october:9, nov:10, november:10, dec:11, december:11
    };

    // Reads the chat date forms the app meets (ST's send_date among them) without the Date
    // constructor, whose string parsing varies by engine.
    function manualParse(s) {
        if (typeof s !== 'string') return null;
        s = s.trim();
        if (!s) return null;

        var y, m, d;

        // epoch seconds or milliseconds, as digits
        if (/^\d{10,13}(\.\d+)?$/.test(s)) {
            var n = Number(s);
            if (n > 0 && n < 1e10) n *= 1000;
            var dt = new OrigDate(n);
            return isNaN(dt.getTime()) ? null : dt;
        }

        // "YYYY-MM-DD..." or "YYYY/MM/DD...", any time after it: "2024-07-19 @ 16h57m30s",
        // "2024-07-19T16:57:30", "2024-07-19 16:57:30"
        var isoMatch = s.match(/^(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})/);
        if (isoMatch) {
            y = parseInt(isoMatch[1], 10);
            m = parseInt(isoMatch[2], 10) - 1;
            d = parseInt(isoMatch[3], 10);
            if (y > 1970 && m >= 0 && m <= 11 && d >= 1 && d <= 31) {
                return new OrigDate(y, m, d);
            }
        }

        // "Month DD, YYYY...", eg. "July 19, 2024 4:57:30 PM"
        var longMatch = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
        if (longMatch) {
            var mName = longMatch[1].toLowerCase();
            if (mName in MONTHS) {
                y = parseInt(longMatch[3], 10);
                m = MONTHS[mName];
                d = parseInt(longMatch[2], 10);
                if (y > 1970 && d >= 1 && d <= 31) {
                    return new OrigDate(y, m, d);
                }
            }
        }

        // "DD Month YYYY", eg. "19 July 2024"
        var dmyMatch = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
        if (dmyMatch) {
            var mName2 = dmyMatch[2].toLowerCase();
            if (mName2 in MONTHS) {
                y = parseInt(dmyMatch[3], 10);
                m = MONTHS[mName2];
                d = parseInt(dmyMatch[1], 10);
                if (y > 1970 && d >= 1 && d <= 31) {
                    return new OrigDate(y, m, d);
                }
            }
        }

        // the US "MM/DD/YYYY"
        var usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (usMatch) {
            y = parseInt(usMatch[3], 10);
            m = parseInt(usMatch[1], 10) - 1;
            d = parseInt(usMatch[2], 10);
            if (y > 1970 && m >= 0 && m <= 11 && d >= 1 && d <= 31) {
                return new OrigDate(y, m, d);
            }
        }

        return null;
    }

    // a date string reshaped into a form the mobile engines' Date accepts
    function fixDateString(s) {
        if (typeof s !== 'string') return s;
        s = s.trim();
        if (s === '') return s;

        // Numeric string → epoch ms
        if (/^\d+(\.\d+)?$/.test(s)) {
            var n = Number(s);
            return (n > 0 && n < 1e10) ? n * 1000 : n;
        }

        // Strip @ and everything after for SillyTavern datetime strings
        var at = s.indexOf('@');
        if (at > 0) s = s.substring(0, at).trim();

        // "YYYY-MM-DD ..." (no T) → slash separators for mobile compat
        if (/^\d{4}-\d{1,2}-\d{1,2}(\s|$)/.test(s)) {
            s = s.replace(/^(\d{4})-(\d{1,2})-(\d{1,2})/, '$1/$2/$3');
        }

        return s;
    }

    // the manual parser first, the Date constructor as the fallback
    function parseDate(v) {
        if (v == null || v === '') return null;

        if (typeof v === 'number') {
            var d = new OrigDate(v > 0 && v < 1e10 ? v * 1000 : v);
            return isNaN(d.getTime()) ? null : d;
        }

        var manual = manualParse(String(v));
        if (manual) return manual;

        // Last resort: try Date constructor with fixDateString
        try {
            var fixed = fixDateString(v);
            if (typeof fixed === 'number') {
                d = new OrigDate(fixed);
                if (!isNaN(d.getTime())) return d;
            }
            d = new OrigDate(fixed);
            if (!isNaN(d.getTime())) return d;
            d = new OrigDate(v);
            if (!isNaN(d.getTime())) return d;
        } catch (e) { /* a value whose conversion throws reads as no date */ }

        return null;
    }

    // M/D/YYYY by hand, for the engines whose toLocaleDateString throws
    function formatDate(d) {
        if (!d || isNaN(d.getTime())) return null;
        return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
    }

    // the Date constructor replaced, best effort: a refused replacement keeps the native one
    try {
        function SmartDate(a, b, c, d, e, f, g) {
            var len = arguments.length;
            if (!(this instanceof SmartDate)) return OrigDate();
            if (len === 0) return new OrigDate();
            if (len === 1) {
                if (typeof a === 'string') {
                    // Date-only "YYYY-MM-DD" stays LOCAL midnight: the spec parses it as UTC, and every
                    // day-boundary consumer assumes local.
                    if (/^\s*\d{4}-\d{2}-\d{2}\s*$/.test(a)) {
                        var dp = manualParse(a);
                        if (dp) return dp;
                    }
                    // Native first, so ISO timestamps keep their time (the manual parser is date-only); manual is
                    // the fallback for engines that reject ST's formats
                    var nd = new OrigDate(a);
                    if (!isNaN(nd.getTime())) return nd;
                    var mp = manualParse(a);
                    if (mp) return mp;
                    return new OrigDate(fixDateString(a));
                }
                return new OrigDate(a);
            }
            if (len === 2) return new OrigDate(a, b);
            if (len === 3) return new OrigDate(a, b, c);
            if (len === 4) return new OrigDate(a, b, c, d);
            if (len === 5) return new OrigDate(a, b, c, d, e);
            if (len === 6) return new OrigDate(a, b, c, d, e, f);
            return new OrigDate(a, b, c, d, e, f, g);
        }
        SmartDate.prototype = OrigDate.prototype;
        SmartDate.now = OrigDate.now;
        SmartDate.parse = function (s) {
            if (typeof s === 'string') {
                // Same order as the constructor: date-only stays local, then native-first
                if (/^\s*\d{4}-\d{2}-\d{2}\s*$/.test(s)) {
                    var dp = manualParse(s);
                    if (dp) return dp.getTime();
                }
                var nt = OrigDate.parse(s);
                if (!isNaN(nt)) return nt;
                var mp = manualParse(s);
                if (mp) return mp.getTime();
                return OrigDate.parse(fixDateString(s));
            }
            return OrigDate.parse(s);
        };
        SmartDate.UTC = function () { return OrigDate.UTC.apply(OrigDate, arguments); };
        try { Object.defineProperty(SmartDate, 'length', { value: 7 }); } catch (e) { /* cosmetic; older engines refuse it */ }
        try { Object.defineProperty(SmartDate, 'name', { value: 'Date' }); } catch (e) { /* cosmetic; older engines refuse it */ }

        // engines differ in which assignment sticks, so all three are tried
        try { window.Date = SmartDate; } catch (e) { /* refused here; the next may stick */ }
        try { Date = SmartDate; } catch (e) { /* refused here; the next may stick */ }
        try {
            Object.defineProperty(window, 'Date', {
                value: SmartDate, writable: true, configurable: true
            });
        } catch (e) { /* refused: an earlier assignment may have stuck */ }
    } catch (e) { /* the native Date stays */ }

    // toLocaleDateString answers 'Unknown' for an invalid date instead of throwing
    try {
        var OrigToLocale = OrigDate.prototype.toLocaleDateString;
        OrigDate.prototype.toLocaleDateString = function () {
            try { if (isNaN(this.getTime())) return 'Unknown'; } catch (ex) { return 'Unknown'; }
            try { return OrigToLocale.apply(this, arguments); } catch (ex2) {
                return formatDate(this) || 'Unknown';
            }
        };
    } catch (e) { /* the native toLocaleDateString stays */ }

    // the chat-card date fixer reads these two
    window.__mobileDateParse = parseDate;
    window.__mobileDateFormat = formatDate;
})();

/* ========================================
   OVERLAY REGISTRY
   Modules call window.registerOverlay(config) to register overlays.
   The back-button stack (mobile) and global Escape handler (all platforms)
   both read from this registry so new overlays don't require editing
   library-mobile.js or wiring their own Escape listeners.

   Config shape:
     id        {string}   - DOM element ID
     tier      {number}   - z-order priority (lower number = closes first = higher z-index)
     close     {function} - called with the element to close it
     static    {boolean}  - protect from catch-all el.remove() (default: true)
     escape    {boolean}  - respond to Escape key (default: true)
     visible   {function} - optional override: (el) => bool. Default auto-detects: cl-modal uses .visible, others use !.hidden.
   ======================================== */
window._overlayRegistry = window._overlayRegistry || [];
// Replace-by-id (mirrors the library.js bootstrap, which normally wins the || race)
window.registerOverlay = window.registerOverlay || function(cfg) {
    const i = window._overlayRegistry.findIndex(r => r.id === cfg.id);
    if (i !== -1) window._overlayRegistry[i] = cfg;
    else window._overlayRegistry.push(cfg);
};

/* ========================================
   MAIN MOBILE ENHANCEMENTS IIFE
   ======================================== */
(function MobileEnhancements() {
    'use strict';

    // Only run in mobile mode (html.cl-mobile, owned by the boot policy + the mode-sync block below)
    function isMobile() {
        return document.documentElement.classList.contains('cl-mobile');
    }

    // Shared signal: card-swipe sets this true when it commits to a horizontal
    // gesture so pull-to-refresh and view-swipe back off in the same touch.
    let activeCardSwipe = false;

    // one list for every "is an overlay open" question, so no site can drop a family
    const OPEN_OVERLAY_FAMILIES = [
        ['modal-overlay', ':not(.hidden)'],
        ['cl-modal', '.visible'],
        ['confirm-modal', ':not(.hidden)'],
        ['cl-confirm-overlay', ':not(.hidden)'],
        ['mobile-online-search-overlay', ':not(.hidden)'],
    ];
    const OPEN_OVERLAY_SEL = OPEN_OVERLAY_FAMILIES.map(([c, open]) => `.${c}${open}`).join(', ');
    const OVERLAY_FAMILY_SEL = OPEN_OVERLAY_FAMILIES.map(([c]) => `.${c}`).join(', ');
    const OVERLAY_FAMILY_CLASS = new RegExp(`(^|\\s)(${OPEN_OVERLAY_FAMILIES.map(([c]) => c).join('|')})(\\s|$)`);
    // a dropdown a sheet hosts stays unhidden after the sheet closes, so the sheet answers for it
    const openTopbarDropdown = () => (window.TOPBAR_DROPDOWN_IDS || [])
        .map(id => document.getElementById(id))
        .find(el => el && !el.classList.contains('hidden') && !el.closest('[data-notif-host]'));

    function fixViewport() {
        var meta = document.querySelector('meta[name="viewport"]');
        if (meta && meta.content.indexOf('viewport-fit') === -1) {
            meta.content += ', viewport-fit=cover';
        }
    }

    // Lifecycle: run/teardown so a live mode flip re-inits cleanly
    // mobileLive is the active session (null when torn down); teardown reverses all setup() captured.
    let mobileLive = null;

    function runMobile() {
        if (mobileLive) return; // already active
        const ctx = mobileLive = {
            capturing: false, // gate: wrappers record into ctx only while true (setup + armed callbacks)
            uninstall: null,  // removes the session patches; called first in teardown
            captured: [],  // [target, type, handler, opts] from setup + armed observer callbacks
            adds: [],      // nodes the layer created (no prior parent) -> removed on teardown
            moves: [],     // nodes the layer reparented (had a prior parent) -> moved back on teardown
            observers: [],
            timers: [],
            restore: [],   // explicit undo fns: globals, viewport meta, body styles
        };
        // Snapshot the true viewport baseline before fixViewport() mutates it, so teardown restores the
        // real desktop value rather than the viewport-fit=cover-polluted one.
        const vp = document.querySelector('meta[name="viewport"]');
        if (vp) { const vpBefore = vp.content; ctx.restore.push(() => { vp.content = vpBefore; }); }
        ctx.uninstall = installSessionPatches(ctx);
        fixViewport();
        setup(ctx);
    }

    function teardownMobile() {
        const ctx = mobileLive;
        if (!ctx) return;
        mobileLive = null;
        const step = (fn) => { try { fn(); } catch { /* best effort: one failed step never strands the rest */ } };
        step(() => ctx.uninstall?.()); // restore the real globals before anything else runs
        ctx.observers.forEach(o => step(() => o.disconnect())); // before the moves, so they don't react to them
        ctx.timers.forEach(t => step(() => clearInterval(t)));
        ctx.captured.forEach(([t, ty, h, o]) => step(() => t.removeEventListener(ty, h, o)));
        ctx.adds.forEach(n => step(() => n.remove()));
        ctx.moves.reverse().forEach(({ node, parent, next }) => step(() => {
            if (!parent) return;
            // a captured anchor can be gone by restore time, and insertBefore would throw and strand the node
            parent.insertBefore(node, next && next.parentNode === parent ? next : null);
        }));
        while (ctx.restore.length) step(ctx.restore.pop()); // globals, viewport meta, body styles
        // Reset guard flags + residual classes so a re-run re-applies relocations / swipe wiring cleanly.
        document.querySelectorAll('[data-relocated], [data-swipe-init], .mobile-reparented').forEach(el => {
            el.removeAttribute('data-relocated');
            el.removeAttribute('data-swipe-init');
            el.classList.remove('mobile-reparented');
        });
        document.documentElement.classList.remove('cl-keyboard-open');
    }

    // Mode sync: this block and the boot policy alone write html.cl-mobile
    // the class flips at once, run/teardown debounces so dragging across doesnt thrash
    const mq = window.matchMedia('(max-width: 768px)');
    function syncModeClass() {
        const mobile = window.computeMobileMode ? window.computeMobileMode() : mq.matches;
        document.documentElement.classList.toggle('cl-mobile', mobile);
        return mobile;
    }
    let crossTimer = 0;
    let appliedMode = null;
    function onModeInputChange() {
        syncModeClass();
        clearTimeout(crossTimer);
        crossTimer = setTimeout(() => {
            const mobile = syncModeClass();
            if (mobile === appliedMode) return;
            appliedMode = mobile;
            mobile ? runMobile() : teardownMobile();
            document.dispatchEvent(new CustomEvent('cl-mobile-mode-change', { detail: { mobile } }));
            // chrome rebuild and mode-change subscribers relayout after the resize settled; nudge the grid
            // to re-measure last or it keeps stale columns
            window.dispatchEvent(new Event('resize'));
        }, 250);
    }
    if (mq.addEventListener) mq.addEventListener('change', onModeInputChange);
    else if (mq.addListener) mq.addListener(onModeInputChange); // older Safari/iOS
    // The other two policy inputs: touch capability (eg. a convertible losing its keyboard) and
    // the per-device settings override.
    const touchMq = window.matchMedia('(pointer: coarse) and (hover: none)');
    if (touchMq.addEventListener) touchMq.addEventListener('change', onModeInputChange);
    else if (touchMq.addListener) touchMq.addListener(onModeInputChange); // older Safari/iOS
    document.addEventListener('cl-mobile-override-changed', onModeInputChange);

    // First load: run only on mobile, after a short delay so library.js finishes its own init.
    function init() {
        appliedMode = syncModeClass();
        if (isMobile()) setTimeout(runMobile, 200);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function recordInsert(ctx, node) {
        if (!node || node.nodeType !== 1) return;
        // a parented node is a reparent (restored on teardown), a fresh one is created chrome (removed)
        if (node.parentNode) ctx.moves.push({ node, parent: node.parentNode, next: node.nextSibling });
        else ctx.adds.push(node);
    }

    // capture on during observer callbacks: lazy wiring fires after setup, and uncaptured attaches
    // would leak past teardown
    function armObserverCb(ctx, cb) {
        return function (...args) {
            if (mobileLive !== ctx) return cb.apply(this, args); // session ended/replaced; don't capture
            const prev = ctx.capturing;
            const before = ctx.captured.length + ctx.adds.length;
            ctx.capturing = true;
            try { return cb.apply(this, args); } finally {
                ctx.capturing = prev;
                if (ctx.captured.length + ctx.adds.length !== before) {
                    // This fire captured something; drop entries whose node left the DOM (transient
                    // viewers are create-per-open) so long sessions dont pin detached trees.
                    ctx.captured = ctx.captured.filter(([t]) => !(t instanceof Node) || t.isConnected);
                    ctx.adds = ctx.adds.filter(n => n.isConnected);
                }
            }
        };
    }

    // Patches the globals once per session, gated on ctx.capturing: swapping prototype methods per
    // observer fire would deopt the virtual-scroll hot path. Returns the uninstaller.
    function installSessionPatches(ctx) {
        const realAEL = EventTarget.prototype.addEventListener;
        const realMO = window.MutationObserver;
        const realAppend = Node.prototype.appendChild;
        const realInsert = Node.prototype.insertBefore;
        const realIAE = Element.prototype.insertAdjacentElement; // lives on Element, not Node
        EventTarget.prototype.addEventListener = function (type, handler, opts) {
            if (ctx.capturing) ctx.captured.push([this, type, handler, opts]);
            return realAEL.call(this, type, handler, opts);
        };
        window.MutationObserver = function (cb) {
            const o = new realMO(ctx.capturing ? armObserverCb(ctx, cb) : cb);
            if (ctx.capturing) ctx.observers.push(o);
            return o;
        };
        window.MutationObserver.prototype = realMO.prototype;
        Node.prototype.appendChild = function (node) { if (ctx.capturing) recordInsert(ctx, node); return realAppend.call(this, node); };
        Node.prototype.insertBefore = function (node, ref) { if (ctx.capturing) recordInsert(ctx, node); return realInsert.call(this, node, ref); };
        Element.prototype.insertAdjacentElement = function (pos, el) { if (ctx.capturing) recordInsert(ctx, el); return realIAE.call(this, pos, el); };
        return function uninstallSessionPatches() {
            EventTarget.prototype.addEventListener = realAEL;
            window.MutationObserver = realMO;
            Node.prototype.appendChild = realAppend;
            Node.prototype.insertBefore = realInsert;
            Element.prototype.insertAdjacentElement = realIAE;
        };
    }

    function setup(ctx) {
        const topbar = document.querySelector('.topbar');
        if (!topbar) return;

        // snapshot the globals this layer assigns, restored on teardown; a stale pushOverlayGuard would
        // push orphan guards on desktop
        const g = {
            switchView: window.switchView, addTag: window.addTag,
            removeTag: window.removeTag,
            pushOverlayGuard: window.pushOverlayGuard,
            clCreateMobileSheet: window.clCreateMobileSheet,
        };
        ctx.restore.push(() => { Object.keys(g).forEach(k => { try { window[k] = g[k]; } catch { /* a non-writable global keeps its value */ } }); });

        // Absent on desktop by design, same contract as pushOverlayGuard: a module calls it
        // with ?. and falls back to its own desktop surface.
        window.clCreateMobileSheet = makeSheet;

        // setup() runs fully synchronously, so capture sees only this layer's setup-time work.
        ctx.capturing = true;
        try {
            applySetup(topbar);
        } finally {
            ctx.capturing = false;
        }
    }

    function applySetup(topbar) {
        // Isolated so one failing step cant silently kill every later one; failures log the step name.
        [
            createSearchButton, createSettingsButton, createMenuButton, createProviderQuickSwitch,
            setupBottomNav, migrateTopbarToBottomNav, setupHideTopbarOnScroll, setupBottomSheetDismiss,
            setupPullToRefresh, setupCardSwipeGestures, setupOnlineSearchOverlay, setupModalAvatar,
            setupGallerySwipe, setupGreetingsSwipe, setupTabSwipe,
            setupCharModalNavSwipe, setupViewSwipe, setupContextMenu, setupViewportFix,
            relocateTagPopup, relocatePlaylistPopup, relocateAdvFilterPanel, setDefaultExpandZoom,
            setupLorebookModalToolbar, fixInvalidDateText, setupChubFilterArea, setupNotificationsSheet,
            fixRefreshLoadingStuck, preventAutoFocusOnOpen, setupMobileTagEditor, setupModalHeaderCollapse,
            setupTitleScrollReveal, setupMultiSelectConfirm, setupBrowseModalActionsMenu, setupBackButton,
        ].forEach(step => {
            try { step(topbar); } catch (e) { console.error('[CL mobile] setup step failed:', step.name, e); }
        });
    }

    /* ========================================
       BOTTOM NAVIGATION + FAB
       ======================================== */

    function setupBottomNav() {
        const bottomNav = document.getElementById('mobileBottomNav');
        const fab = document.getElementById('mobileFab');
        if (!bottomNav) return;

        const tabs = bottomNav.querySelectorAll('.mobile-bottom-nav-tab');

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const view = tab.dataset.view;
                window.goToView(view);
                window.hapticFeedback?.(8);
            });
        });

        // Mirror .view-toggle.active so library.js doesn't need to know about us
        const desktopToggle = document.querySelector('.view-toggle');
        if (desktopToggle) {
            const filtersBtn = document.getElementById('mobileNavFiltersBtn');
            const syncBottomNav = () => {
                const activeBtn = desktopToggle.querySelector('.view-toggle-btn.active');
                if (!activeBtn) return;
                const activeView = activeBtn.dataset.view;
                tabs.forEach(t => t.classList.toggle('active', t.dataset.view === activeView));
                // an extension's view has no filters of the app's to open
                if (filtersBtn) filtersBtn.hidden = isExtensionView(activeView);
                updateFab(activeView);
            };
            const observer = new MutationObserver(syncBottomNav);
            observer.observe(desktopToggle, {
                subtree: true,
                attributes: true,
                attributeFilter: ['class'],
            });
            syncBottomNav();
        }

        // Soft keyboard open: hide nav so it doesnt stack above the keyboard
        if (window.visualViewport) {
            const KEYBOARD_THRESHOLD = 150; // px of viewport reduction = keyboard
            const checkKeyboard = () => {
                const reduction = window.innerHeight - window.visualViewport.height;
                const open = reduction > KEYBOARD_THRESHOLD;
                bottomNav.classList.toggle('hidden-by-keyboard', open);
                if (fab) fab.classList.toggle('hidden-by-keyboard', open);
                document.documentElement.classList.toggle('cl-keyboard-open', open);
            };
            window.visualViewport.addEventListener('resize', checkKeyboard);
        }

        // An open overlay owns the screen, so the chrome steps aside; derived here since a body:has()
        // rule restyled the page per insertion
        const syncOverlayChrome = () => {
            const open = !!document.querySelector(OPEN_OVERLAY_SEL);
            bottomNav.classList.toggle('hidden-by-overlay', open);
            if (fab) fab.classList.toggle('hidden-by-overlay', open);
        };
        const holdsOverlay = (n) => n.nodeType === 1 && (n.matches(OVERLAY_FAMILY_SEL) || !!n.querySelector(OVERLAY_FAMILY_SEL));
        new MutationObserver((records) => {
            const moved = records.some(r => r.type === 'attributes'
                ? OVERLAY_FAMILY_CLASS.test(r.target.getAttribute('class') || '') || OVERLAY_FAMILY_CLASS.test(r.oldValue || '')
                : [...r.addedNodes, ...r.removedNodes].some(holdsOverlay));
            if (moved) syncOverlayChrome();
        }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
        syncOverlayChrome();
    }

    /* ========================================
       TOPBAR MIGRATION (mobile only)
       ======================================== */

    function migrateTopbarToBottomNav() {
        const filtersBtn = document.getElementById('mobileNavFiltersBtn');
        const moreBtn = document.getElementById('mobileNavMoreBtn');

        if (filtersBtn) {
            filtersBtn.addEventListener('click', () => {
                window.hapticFeedback?.(8);
                document.getElementById('mobileSettingsBtn')?.click();
            });
        }
        if (moreBtn) {
            moreBtn.addEventListener('click', () => {
                window.hapticFeedback?.(8);
                document.getElementById('mobileMenuBtn')?.click();
            });
        }

        // Reparent as a SIBLING of #onlineView (not child); activateProvider
        // does container.innerHTML = renderView() and would wipe a child.
        const onlineFilterArea = document.getElementById('onlineFilterArea');
        const onlineView = document.getElementById('onlineView');
        if (onlineFilterArea && onlineView && onlineFilterArea.parentElement !== onlineView.parentElement) {
            onlineView.parentNode.insertBefore(onlineFilterArea, onlineView);
            onlineFilterArea.classList.add('mobile-reparented');
        }

    }

    /* ========================================
       HIDE TOPBAR ON SCROLL
       ======================================== */

    function setupHideTopbarOnScroll() {
        const topbar = document.querySelector('.topbar');
        const gallery = document.querySelector('.gallery-content');
        if (!topbar || !gallery) return;

        const HIDE_THRESHOLD = 80;   // scrollTop < this -> always show
        const DELTA_THRESHOLD = 6;   // ignore micro-deltas (touch jitter)
        let lastY = gallery.scrollTop;
        let ticking = false;

        function getFab() { return document.querySelector('.mobile-fab'); }

        function onScroll() {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                const curY = gallery.scrollTop;
                const delta = curY - lastY;
                const fab = getFab();

                if (curY < HIDE_THRESHOLD) {
                    topbar.classList.remove('topbar-hidden-on-scroll');
                    fab?.classList.remove('fab-hidden-on-scroll');
                } else if (Math.abs(delta) > DELTA_THRESHOLD) {
                    if (delta > 0) {
                        topbar.classList.add('topbar-hidden-on-scroll');
                        fab?.classList.add('fab-hidden-on-scroll');
                    } else {
                        topbar.classList.remove('topbar-hidden-on-scroll');
                        fab?.classList.remove('fab-hidden-on-scroll');
                    }
                }

                lastY = curY;
                ticking = false;
            });
        }

        gallery.addEventListener('scroll', onScroll, { passive: true });

        const desktopToggle = document.querySelector('.view-toggle');
        if (desktopToggle) {
            new MutationObserver(() => {
                topbar.classList.remove('topbar-hidden-on-scroll');
                getFab()?.classList.remove('fab-hidden-on-scroll');
                lastY = 0;
            }).observe(desktopToggle, {
                subtree: true,
                attributes: true,
                attributeFilter: ['class'],
            });
        }
    }

    /* ========================================
       BOTTOM-SHEET DRAG-TO-DISMISS
       ======================================== */

    function setupBottomSheetDismiss() {
        const DRAG_ZONE_HEIGHT = 80;     // upper area where drag activates
        const DISMISS_THRESHOLD = 100;   // px of downward drag = dismiss
        let activeSheet = null;
        let startY = 0;
        let currentY = 0;
        let dragging = false;

        const DRAGGABLE_SHEET_SELECTOR = [
            '.cl-confirm-overlay:not(.hidden) .confirm-modal-content',
            '.cl-modal.cl-modal-drawer.visible .cl-modal-content',
            '.mobile-sheet-overlay:not(.hidden) .mobile-sheet',
            '.mobile-fixed-popup:not(.hidden)',
            '.ccss-sidebar.drawer-open',
        ].join(', ');

        document.addEventListener('touchstart', (e) => {
            const sheet = e.target.closest(DRAGGABLE_SHEET_SELECTOR);
            if (!sheet) return;
            // Don't hijack touches on interactive controls (buttons, inputs).
            if (e.target.closest('button, a, input, textarea, select, label')) return;
            const rect = sheet.getBoundingClientRect();
            const offsetY = e.touches[0].clientY - rect.top;
            if (offsetY > DRAG_ZONE_HEIGHT) return;
            // Only start a dismiss-drag when the content under the touch is at the top.
            // A scrolled-down list/sheet should scroll up, not drag the sheet shut.
            for (let n = e.target; n && n !== sheet.parentElement; n = n.parentElement) {
                if (n.scrollTop > 0) return;
            }
            activeSheet = sheet;
            startY = e.touches[0].clientY;
            currentY = startY;
            dragging = true;
            sheet.style.transition = 'none';
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!dragging || !activeSheet) return;
            currentY = e.touches[0].clientY;
            const delta = Math.max(0, currentY - startY);
            activeSheet.style.transform = `translateY(${delta}px)`;
            // Non-passive: stop the browser co-opting the downward drag for
            // pull-to-refresh / overscroll while a sheet is being dismissed.
            if (e.cancelable) e.preventDefault();
        }, { passive: false });

        // Route drag-close through each sheet's own close so its cleanup (picker state, back-guards, checkbox revert) runs.
        function closeDraggedSheet(overlay) {
            if (!overlay) return;
            if (typeof overlay._closeFn === 'function') {
                overlay._closeFn(overlay);
            } else {
                const reg = (window._overlayRegistry || []).find(o => o.id && o.id === overlay.id && typeof o.close === 'function');
                if (reg) reg.close(overlay);
                // Legacy fallback for any unregistered drawer: toggle the family's own class.
                else if (overlay.classList.contains('cl-modal')) overlay.classList.remove('visible');
                else overlay.classList.add('hidden');
            }
            overlay._resolve?.(false);
        }

        function endDrag() {
            if (!dragging || !activeSheet) return;
            const delta = currentY - startY;
            const sheet = activeSheet;
            // For .mobile-fixed-popup the panel IS the toggled element; the others wrap it.
            const overlay = sheet.closest('.cl-confirm-overlay, .cl-modal, .mobile-sheet-overlay') || sheet;
            sheet.style.transition = 'transform 0.22s var(--ease-drawer)';

            if (delta > DISMISS_THRESHOLD) {
                sheet.style.transform = 'translateY(100%)';
                setTimeout(() => {
                    closeDraggedSheet(overlay);
                    sheet.style.transition = '';
                    sheet.style.transform = '';
                }, 220);
            } else {
                sheet.style.transform = '';
                setTimeout(() => { sheet.style.transition = ''; }, 220);
            }
            activeSheet = null;
            dragging = false;
        }

        document.addEventListener('touchend', endDrag);
        document.addEventListener('touchcancel', endDrag);
    }

    /* ========================================
       PULL TO REFRESH
       ======================================== */

    // an extension view refreshes through its spec's refresh; one with none never arms the pull
    function viewRefreshes(view) {
        return (window.ExtensionHost?.getViews?.() || []).some(v => v.name === view && v.refresh);
    }
    function pullRefreshable(view) {
        return !isExtensionView(view) || viewRefreshes(view);
    }

    function setupPullToRefresh() {
        const scrollContainer = document.querySelector('.gallery-content');
        if (!scrollContainer) return;

        const indicator = document.createElement('div');
        indicator.className = 'mobile-pull-refresh-indicator';
        const ICON_PULL = '<i class="fa-solid fa-arrow-down"></i>';
        const ICON_LOAD = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
        indicator.innerHTML = ICON_PULL;
        scrollContainer.style.position = scrollContainer.style.position || 'relative';
        scrollContainer.appendChild(indicator);

        const PULL_THRESHOLD = 80;     // px past which release triggers refresh
        const MAX_PULL = 140;          // px upper clamp on visual travel
        const REST_POSITION = 36;      // px the indicator parks at while refreshing
        let startY = 0;
        let curY = 0;
        let pullDist = 0;
        let pulling = false;
        let refreshing = false;

        // a gesture starting inside a nested scroller belongs to it: this container's scrollTop stays 0
        // there, so the pull would arm
        function insideNestedScroller(target) {
            for (let el = target; el && el !== scrollContainer; el = el.parentElement) {
                if (el.scrollHeight > el.clientHeight + 1
                    && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return true;
            }
            return false;
        }

        // the walk only catches panes that overflow; a gesture born inside any overlay surface is never
        // the pull's
        const PULL_EXEMPT = '.chat-conv, .cl-cwin, .cl-modal, .modal-glass, .confirm-modal, .cl-confirm-overlay, .mobile-sheet-overlay, .mobile-fixed-popup, .dropdown-menu';

        scrollContainer.addEventListener('touchstart', (e) => {
            if (refreshing) return;
            if (scrollContainer.scrollTop > 0) return;
            if (e.target?.closest?.(PULL_EXEMPT)) return;
            if (insideNestedScroller(e.target)) return;
            if (!pullRefreshable(getActiveView())) return;
            startY = e.touches[0].clientY;
            curY = startY;
            pulling = true;
        }, { passive: true });

        scrollContainer.addEventListener('touchmove', (e) => {
            if (!pulling || refreshing) return;
            if (activeCardSwipe) {
                // Card swipe has committed horizontally; release pull state cleanly.
                pulling = false;
                pullDist = 0;
                indicator.style.transform = 'translateY(-100%)';
                indicator.classList.remove('ready');
                return;
            }
            if (scrollContainer.scrollTop > 0) { pulling = false; return; }
            curY = e.touches[0].clientY;
            const raw = curY - startY;
            if (raw <= 0) {
                pullDist = 0;
                indicator.style.transform = 'translateY(-100%)';
                indicator.classList.remove('ready');
                return;
            }
            // dampened pull: resistance grows with distance
            pullDist = Math.min(MAX_PULL, raw * 0.6);
            indicator.style.transform = `translateY(${pullDist}px)`;
            indicator.style.opacity = String(Math.min(1, pullDist / 40));
            indicator.classList.toggle('ready', pullDist >= PULL_THRESHOLD);
        }, { passive: true });

        async function endPull() {
            if (!pulling || refreshing) {
                pulling = false;
                return;
            }
            pulling = false;

            if (pullDist >= PULL_THRESHOLD) {
                refreshing = true;
                indicator.classList.remove('ready');
                indicator.classList.add('refreshing');
                indicator.innerHTML = ICON_LOAD;
                indicator.style.transition = 'transform 0.22s var(--ease-drawer), opacity 0.22s ease';
                indicator.style.transform = `translateY(${REST_POSITION}px)`;
                window.hapticFeedback?.(15);

                try {
                    await triggerViewRefresh();
                } finally {
                    indicator.classList.remove('refreshing');
                    indicator.style.transition = 'transform 0.22s var(--ease-drawer), opacity 0.18s ease';
                    indicator.style.transform = 'translateY(-100%)';
                    indicator.style.opacity = '0';
                    setTimeout(() => {
                        indicator.innerHTML = ICON_PULL;
                        indicator.style.transition = '';
                        refreshing = false;
                    }, 240);
                }
            } else {
                indicator.style.transition = 'transform 0.18s ease, opacity 0.18s ease';
                indicator.style.transform = 'translateY(-100%)';
                indicator.style.opacity = '0';
                setTimeout(() => {
                    indicator.style.transition = '';
                }, 180);
            }
            pullDist = 0;
        }

        scrollContainer.addEventListener('touchend', endPull);
        scrollContainer.addEventListener('touchcancel', endPull);
    }

    async function triggerViewRefresh() {
        const view = getActiveView() || 'characters';

        if (isExtensionView(view)) {
            if (!viewRefreshes(view)) return;
            try { await window.ExtensionHost.refreshView(view); } catch (err) { console.warn('[PullToRefresh] the view\'s refresh failed:', err); }
            return;
        }

        if (view === 'characters') {
            // the reader asked for fresh rows: the held ones re-read too
            await window.fetchCharacters(true, { held: true });
            return;
        }

        if (view === 'chats') {
            document.getElementById('refreshChatsViewBtn')?.click();
            await new Promise(r => setTimeout(r, 600));
            return;
        }

        if (view === 'online') {
            const reg = window.ProviderRegistry;
            const view = reg?.getActiveView?.();
            if (view) {
                const container = document.querySelector('#onlineView .online-kind-pane:not([hidden])') || document.getElementById('onlineView');
                try {
                    view.deactivate?.();
                    view.activate?.(container, { domRecreated: false });
                } catch (err) {
                    console.warn('[PullToRefresh] online refresh failed:', err);
                }
            }
            await new Promise(r => setTimeout(r, 600));
        }
    }

    /* ========================================
       CARD SWIPE GESTURES
       ======================================== */

    function setupCardSwipeGestures() {
        const grid = document.getElementById('characterGrid');
        if (!grid) return;

        const HORIZONTAL_INTENT = 10;    // px to commit to horizontal swipe
        const TRIGGER_THRESHOLD = 60;    // px of damped drag to fire action
        const DAMP = 0.7;                // resistance factor on the drag
        // Card-edge dead zones so a tab swipe starting on a card edge yields to view-swipe instead of triggering favorite/menu.
        const EDGE_DEAD_ZONE = 0.12;     // outer 12% of card width per side
        const BOTTOM_DEAD_ZONE = 0.75;   // touches below 75% of card height yield
        let card = null;
        let chip = null;
        let startX = 0;
        let startY = 0;
        let curX = 0;
        let direction = 0;               // -1 left, 1 right
        let swiping = false;
        let effectiveThreshold = TRIGGER_THRESHOLD;
        let swipedRecently = false;      // suppress synthesized click

        grid.addEventListener('touchstart', (e) => {
            // Re-checked every interaction so the setting toggle takes effect live.
            if (window.getSetting?.('mobileSwipeGestures') === false) return;
            if (e.touches.length > 1) return;
            const target = e.target.closest('.char-card');
            if (!target) return;
            // Don't engage on interactive controls inside the card.
            if (e.target.closest('button, a, .favorite-indicator')) return;
            // Spatial dead zone: edges + bottom overlay belong to view-swipe, only the central card hero engages card-swipe.
            const rect = target.getBoundingClientRect();
            const xFrac = (e.touches[0].clientX - rect.left) / rect.width;
            const yFrac = (e.touches[0].clientY - rect.top) / rect.height;
            if (xFrac < EDGE_DEAD_ZONE || xFrac > 1 - EDGE_DEAD_ZONE || yFrac > BOTTOM_DEAD_ZONE) return;
            card = target;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            curX = startX;
            direction = 0;
            swiping = false;
        }, { passive: true });

        grid.addEventListener('touchmove', (e) => {
            if (!card) return;
            curX = e.touches[0].clientX;
            const dx = curX - startX;
            const dy = e.touches[0].clientY - startY;

            if (!swiping) {
                if (Math.abs(dx) > HORIZONTAL_INTENT && Math.abs(dx) > Math.abs(dy) * 1.2) {
                    swiping = true;
                    activeCardSwipe = true;
                    direction = dx > 0 ? 1 : -1;
                    // Edge-aware: cap threshold to what the user can physically reach.
                    // Available travel from startX to the screen edge, minus 8px margin, damped.
                    const reach = (direction > 0 ? window.innerWidth - startX : startX) - 8;
                    effectiveThreshold = Math.max(28, Math.min(TRIGGER_THRESHOLD, reach * DAMP * 0.85));
                    card.classList.add('swiping');
                    chip = document.createElement('div');
                    chip.className = `char-card-swipe-chip ${direction > 0 ? 'right' : 'left'}`;
                    chip.innerHTML = direction > 0
                        ? '<i class="fa-solid fa-star"></i>'
                        : '<i class="fa-solid fa-ellipsis-vertical"></i>';
                    card.appendChild(chip);
                } else if (Math.abs(dy) > HORIZONTAL_INTENT) {
                    // Vertical intent: abort swipe candidate, let scroll handle it.
                    card = null;
                    return;
                }
            } else if (chip) {
                // Mid-swipe direction reversal: thumb crossed zero and committed
                // the other way. Swap chip side/icon + recompute edge-aware threshold.
                const wantsDir = dx > HORIZONTAL_INTENT ? 1 : dx < -HORIZONTAL_INTENT ? -1 : 0;
                if (wantsDir !== 0 && wantsDir !== direction) {
                    direction = wantsDir;
                    const reach = (direction > 0 ? window.innerWidth - startX : startX) - 8;
                    effectiveThreshold = Math.max(28, Math.min(TRIGGER_THRESHOLD, reach * DAMP * 0.85));
                    chip.classList.remove('right', 'left', 'armed');
                    chip.classList.add(direction > 0 ? 'right' : 'left');
                    chip.innerHTML = direction > 0
                        ? '<i class="fa-solid fa-star"></i>'
                        : '<i class="fa-solid fa-ellipsis-vertical"></i>';
                }
            }

            if (swiping) {
                const damped = dx * DAMP;
                card.style.transform = `translateX(${damped}px)`;
                // Only arm when drag sign matches the committed direction.
                const armed = Math.sign(dx) === direction && Math.abs(damped) >= effectiveThreshold;
                if (chip) chip.classList.toggle('armed', armed);
            }
        }, { passive: true });

        function endSwipe() {
            if (!card) return;
            const cardRef = card;
            const chipRef = chip;
            const wasSwipe = swiping;
            const dx = curX - startX;
            const dir = direction;
            const armed = Math.sign(dx) === direction && Math.abs(dx * DAMP) >= effectiveThreshold;

            card = null;
            chip = null;
            swiping = false;
            activeCardSwipe = false;
            direction = 0;

            if (!wasSwipe) return;

            cardRef.classList.remove('swiping');
            cardRef.classList.add('swiping-released');

            if (armed) {
                const avatar = cardRef.dataset.charId;
                const char = avatar ? window.getCharacterById(avatar) : null;
                window.hapticFeedback?.(20);
                if (dir > 0 && char) {
                    window.toggleCharacterFavorite(char);
                } else if (dir < 0) {
                    // Fire a contextmenu event on the card to open the existing
                    // mobile context sheet (long-press path already wired).
                    const rect = cardRef.getBoundingClientRect();
                    cardRef.dispatchEvent(new MouseEvent('contextmenu', {
                        bubbles: true,
                        cancelable: true,
                        clientX: rect.left + rect.width / 2,
                        clientY: rect.top + rect.height / 2,
                    }));
                }
            }

            cardRef.style.transform = '';
            if (chipRef) {
                chipRef.style.opacity = '0';
                setTimeout(() => chipRef.remove(), 200);
            }
            swipedRecently = true;
            setTimeout(() => {
                cardRef.classList.remove('swiping-released');
                swipedRecently = false;
            }, 240);
        }

        grid.addEventListener('touchend', endSwipe);
        grid.addEventListener('touchcancel', endSwipe);

        // Suppress the synthesized click after a swipe so the card doesn't open.
        grid.addEventListener('click', (e) => {
            if (swipedRecently) {
                e.stopPropagation();
                e.preventDefault();
            }
        }, true);
    }

    function updateFab(view) {
        const fab = document.getElementById('mobileFab');
        if (!fab) return;
        const icon = fab.querySelector('i');

        fab.onclick = null;

        // Shared trigger: clicks the topbar's mobileSearchBtn; one input drives the chars and chats filters.
        const triggerSharedSearch = () => {
            window.hapticFeedback?.(8);
            const mobileSearch = document.getElementById('mobileSearchBtn');
            if (mobileSearch) {
                mobileSearch.click();
            } else {
                document.getElementById('searchInput')?.focus();
            }
        };

        const triggerOnlineSearch = () => {
            window.hapticFeedback?.(8);
            openOnlineSearchOverlay();
        };

        switch (view) {
            case 'characters':
                fab.classList.remove('hidden');
                fab.setAttribute('aria-label', 'Search characters');
                if (icon) icon.className = 'fa-solid fa-magnifying-glass';
                fab.onclick = triggerSharedSearch;
                break;
            case 'chats':
                fab.classList.remove('hidden');
                fab.setAttribute('aria-label', 'Search chats');
                if (icon) icon.className = 'fa-solid fa-magnifying-glass';
                fab.onclick = triggerSharedSearch;
                break;
            case 'online':
                fab.classList.remove('hidden');
                fab.setAttribute('aria-label', 'Search online');
                if (icon) icon.className = 'fa-solid fa-magnifying-glass';
                fab.onclick = triggerOnlineSearch;
                break;
            default:
                fab.classList.add('hidden');
                break;
        }
    }

    /* ========================================
       MOBILE ONLINE SEARCH OVERLAY
       ======================================== */

    function getActiveBrowseView() {
        return window.ProviderRegistry?.getActiveView?.() || null;
    }

    function _hideSearchOverlayUI() {
        const overlay = document.getElementById('mobileOnlineSearchOverlay');
        if (!overlay) return;
        overlay.classList.add('hidden');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.querySelector('.mobile-online-search-input')?.blur();
    }

    function openOnlineSearchOverlay() {
        const overlay = document.getElementById('mobileOnlineSearchOverlay');
        if (!overlay) return;
        const browseView = getActiveBrowseView();
        const modes = browseView?.getSearchModes?.() || ['character'];
        const modesContainer = overlay.querySelector('.mobile-online-search-modes');
        const modeButtons = overlay.querySelectorAll('.mobile-online-search-mode');
        const input = overlay.querySelector('.mobile-online-search-input');
        const title = overlay.querySelector('.mobile-online-search-title');
        const providerName = window.ProviderRegistry?.getActiveProvider?.()?.name || 'online';

        if (modes.length > 1) {
            modesContainer.hidden = false;
            modeButtons.forEach(btn => {
                const mode = btn.dataset.mode;
                btn.classList.toggle('active', mode === modes[0]);
                btn.hidden = !modes.includes(mode);
                // Per-provider tab label (eg. botbooru calls its creators Uploaders); keep the icon
                const label = browseView?.getSearchModeLabel?.(mode);
                if (label) {
                    const icon = btn.querySelector('i')?.outerHTML || '';
                    btn.innerHTML = `${icon} ${label}`;
                }
            });
        } else {
            modesContainer.hidden = true;
        }

        const initialMode = modes[0];
        title.textContent = `Search ${providerName}`;
        input.placeholder = browseView?.getSearchPlaceholder?.(initialMode)
            || (initialMode === 'creator' ? 'Creator name...' : 'Character name...');
        input.dataset.activeMode = initialMode;
        input.value = '';
        overlay.querySelector('.mobile-online-search-clear').classList.add('hidden');

        overlay.classList.remove('hidden');
        overlay.setAttribute('aria-hidden', 'false');

        // Tier 1.55 in setupBackButton handles the rest
        window.pushOverlayGuard?.();

        // iOS only surfaces the keyboard if focus lands on the next frame
        requestAnimationFrame(() => input.focus());
    }

    function closeOnlineSearchOverlay() {
        _hideSearchOverlayUI();
    }

    function setupOnlineSearchOverlay() {
        const overlay = document.getElementById('mobileOnlineSearchOverlay');
        if (!overlay) return;

        const modeButtons = overlay.querySelectorAll('.mobile-online-search-mode');
        const form = overlay.querySelector('.mobile-online-search-form');
        const input = overlay.querySelector('.mobile-online-search-input');
        const clearBtn = overlay.querySelector('.mobile-online-search-clear');

        // Scrim tap dismisses (close button is hidden via CSS, scrim + back are the dismissal paths)
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeOnlineSearchOverlay();
        });

        modeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                modeButtons.forEach(b => b.classList.toggle('active', b === btn));
                input.dataset.activeMode = mode;
                input.placeholder = getActiveBrowseView()?.getSearchPlaceholder?.(mode)
                    || (mode === 'creator' ? 'Creator name...' : 'Character name...');
                input.focus();
            });
        });

        input.addEventListener('input', () => {
            clearBtn.classList.toggle('hidden', input.value.length === 0);
        });
        clearBtn.addEventListener('click', () => {
            input.value = '';
            clearBtn.classList.add('hidden');
            input.focus();
        });

        // Submit proxies to the provider's inline search via performSearch.
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const mode = input.dataset.activeMode || 'character';
            const query = input.value.trim();
            const browseView = getActiveBrowseView();
            if (!browseView) return;
            window.hapticFeedback?.(10);
            browseView.performSearch?.(mode, query);
            closeOnlineSearchOverlay();
        });

        // Escape only; back-button handled by Tier 1.55 in setupBackButton
        window.registerOverlay?.({
            id: 'mobileOnlineSearchOverlay',
            tier: 2,
            close: closeOnlineSearchOverlay,
        });
    }

    /* ========================================
       ANDROID BACK BUTTON
       ======================================== */
    function setupBackButton() {
        // Derived per call, never cached: overlays register lazily (modules, providers), and a set
        // built before one registered read its element as dynamic, which tier 1.5 REMOVES.
        const BASE_STATIC_HARDCODED = ['charModal', 'chubLoginModal', 'creatorModal'];
        function getStaticOverlays() {
            const providerIds = window.ProviderRegistry?.getPreviewModalIds?.() || [];
            const registryIds = (window._overlayRegistry || []).filter(r => r.static !== false).map(r => r.id);
            return new Set([...BASE_STATIC_HARDCODED, ...providerIds, ...registryIds]);
        }

        // a tie at the lowest tier goes to the one painted on top, as Escape's getTopmostOverlay decides
        function closeTopRegistered(regs) {
            let top = null;
            for (const r of regs) {
                const el = document.getElementById(r.id);
                if (!el || !window.isOverlayVisible(r, el)) continue;
                if (!top || r.tier < top.r.tier || (r.tier === top.r.tier && window.overlayIsAbove(el, top.el))) top = { r, el };
            }
            if (!top) return false;
            top.r.close(top.el);
            return true;
        }

        function closeTopSheet() {
            const overlays = document.querySelectorAll('.mobile-sheet-overlay:not(.hidden)');
            const el = overlays[overlays.length - 1];
            el.querySelector('.mobile-sheet')?.classList.remove('open');
            setTimeout(() => el.classList.add('hidden'), 300);
        }

        // a sheet opened over a dialog (a preview's kebab, a row's verbs) is painted above it, so it closes before it
        function closeSheetOverDialog() {
            const sheet = [...document.querySelectorAll('.mobile-sheet-overlay:not(.hidden)')].pop();
            if (!sheet) return false;
            const dialogs = (window._overlayRegistry || []).filter(r => !r.viewLevel)
                .map(r => [r, document.getElementById(r.id)]).filter(([r, el]) => el && window.isOverlayVisible(r, el)).map(([, el]) => el);
            const under = [...document.querySelectorAll(OPEN_OVERLAY_SEL), ...dialogs].filter(el => el !== sheet && !sheet.contains(el));
            if (!under.length || under.some(el => window.overlayIsAbove(el, sheet))) return false;
            closeTopSheet();
            return true;
        }

        const stack = [
            // Tier 0 - avatar/gallery quick-view (highest z-index)
            ['#browseAvatarViewer', el => el.remove()],
            ['.mobile-avatar-viewer', () => closeAvatarViewer()],

            // Tier 1 - top z-index overlays
            ['#galleryViewerModal.visible',    () => window.closeGalleryViewer?.()],
            ['#clContextMenu.visible',         el => el.classList.remove('visible')],
            ['.custom-select-menu:not(.hidden)', el => el.classList.add('hidden')],
            closeSheetOverDialog,

            // When char details is stacked above another modal, unwind its layers first
            () => {
                if (!document.body.classList.contains('char-modal-above')) return false;
                // A visible showConfirm outranks everything here (z-10003) but matches neither
                // selector below; close it via its registry entry so the promise resolves as cancel
                const cc = document.getElementById('clConfirmOverlay');
                if (cc && !cc.classList.contains('hidden')) {
                    (window._overlayRegistry || []).find(r => r.id === 'clConfirmOverlay')?.close(cc);
                    return true;
                }
                // Close the topmost unpinned modal first (one opened over charModal); an elevated open pins
                // the ones below with an important z-index.
                const visible = [...document.querySelectorAll('.confirm-modal:not(.hidden), .cl-modal.visible')];
                const unpinned = visible.filter(m => !m.style.getPropertyPriority('z-index'));
                if (unpinned.length > 0) {
                    const top = unpinned[unpinned.length - 1];
                    // its own close first, as a drag-close does, so a dialog waiting on an answer gets one
                    const reg = (window._overlayRegistry || []).find(o => o.id && o.id === top.id && typeof o.close === 'function');
                    if (typeof top._closeFn === 'function') top._closeFn(top);
                    else if (reg) reg.close(top);
                    else if (top.classList.contains('cl-modal')) top.classList.remove('visible');
                    else top.classList.add('hidden');
                    return true;
                }
                const charModal = document.getElementById('charModal');
                if (charModal && !charModal.classList.contains('hidden')) { window.maybeCloseModal?.(); return true; }
                return false;
            },

            // Tier 1.5 - catch-all for dynamic modal-overlays
            () => {
                for (const el of document.querySelectorAll('.modal-overlay:not(.hidden)')) {
                    if (!getStaticOverlays().has(el.id)) {
                        el.remove();
                        return true;
                    }
                }
                return false;
            },

            // Tier 1.55 - online search overlay (close + rearm in one shot)
            // Must run before Tier 1.6 so the rearm isn't bypassed
            () => {
                const ov = document.getElementById('mobileOnlineSearchOverlay');
                if (!ov || ov.classList.contains('hidden')) return false;
                const reg = (window._overlayRegistry || []).find(r => r.id === 'mobileOnlineSearchOverlay');
                if (reg?.close) reg.close(ov);
                else ov.classList.add('hidden');
                // Rearm if provider query active so next back pops Tier 7
                const browseView = getActiveBrowseView();
                if (browseView) {
                    const modes = browseView.getSearchModes?.() || ['character'];
                    for (const mode of modes) {
                        const inputId = browseView.getSearchInputId?.(mode);
                        if (!inputId) continue;
                        const input = document.getElementById(inputId);
                        if (input && input.value.trim()) { pushGuard(); break; }
                    }
                }
                return true;
            },

            // Tier 1.56 - mobile chars search overlay (close only; rearm comes from input listener)
            () => {
                const ov = document.querySelector('.mobile-search-overlay:not(.hidden)');
                if (!ov) return false;
                ov.classList.add('hidden');
                const searchBox = document.querySelector('.search-box');
                const searchArea = document.querySelector('.search-area');
                if (searchBox && searchArea) searchArea.insertBefore(searchBox, searchArea.firstChild);
                return true;
            },

            // Tier 1.6 - registered overlays, before Tier 2 confirm modals.
            // viewLevel ones close at Tier 5.5, else a view here swallows the back meant for a modal over it.
            () => closeTopRegistered((window._overlayRegistry || []).filter(r => !r.viewLevel)),

            // Tier 2.5 - mobile sheets & overlays (.mobile-search-overlay lives in Tier 1.56).
            ['.mobile-sheet-overlay:not(.hidden)', closeTopSheet],
            ['#tagFilterPopup:not(.hidden)', el => el.classList.add('hidden')],
            ['#playlistFilterPopup:not(.hidden)', el => el.classList.add('hidden')],

            // Tier 3 - tag editor sheet
            ['.tag-editor-sheet:not(.hidden)', el => { el.classList.add('hidden'); document.getElementById('tagEditorSheetAutocomplete')?.classList.add('hidden'); }],

            // Tier 3 - full-screen modals
            ['#chubLoginModal:not(.hidden)',    el => el.classList.add('hidden')],
            () => {
                const reg = window.ProviderRegistry;
                const ids = reg?.getPreviewModalIds?.() || [];
                for (const id of ids) {
                    const el = document.getElementById(id);
                    if (el && !el.classList.contains('hidden')) {
                        reg.closeActivePreviewModal();
                        return true;
                    }
                }
                return false;
            },

            // Tier 4 - in-modal sub-views
            ['.vt-container.vt-detail-open', el => el.classList.remove('vt-detail-open')],

            // Tier 5 - main modals (lowest priority full-screen)
            ['#charModal:not(.hidden)',    () => window.maybeCloseModal?.()],
            ['#creatorModal:not(.hidden)', () => window.closeCharacterCreator?.()],

            // Tier 5.5 - view-level registered overlays (the conversation): below every modal tier, so
            // anything opened on it unwinds first.
            () => closeTopRegistered((window._overlayRegistry || []).filter(r => r.viewLevel)),

            // Tier 6 - dropdowns (browse filter dropdowns are relocated to body on mobile)
            () => {
                const el = openTopbarDropdown();
                if (!el) return false;
                el.classList.add('hidden');
                return true;
            },
            () => {
                // .browse-tags-dropdown and .browse-features-dropdown are also .dropdown-menu,
                // so this single query catches all three.
                const dd = document.querySelector('body > .dropdown-menu[data-mobile-relocated]:not(.hidden)');
                if (dd) { dd.classList.add('hidden'); return true; }
                return false;
            },

            // Tier 7 - active text search on characters / chats view
            // (both views share #searchInput; chats listens to 'input' for re-render)
            () => {
                const view = window.getCurrentView?.();
                if (view !== 'characters' && view !== 'chats') return false;
                const input = document.getElementById('searchInput');
                if (!input || !input.value.trim()) return false;
                input.value = '';
                document.getElementById('clearSearchBtn')?.classList.add('hidden');
                if (view === 'characters') window.performSearch?.();
                // Always fire input event so the chats module (and any other
                // input listeners) pick up the cleared state too.
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            },

            // Tier 7 - active search on online view (current provider, any mode)
            () => {
                if (window.getCurrentView?.() !== 'online') return false;
                const browseView = getActiveBrowseView();
                if (!browseView) return false;
                const modes = browseView.getSearchModes?.() || ['character'];
                let cleared = false;
                for (const mode of modes) {
                    const inputId = browseView.getSearchInputId?.(mode);
                    if (!inputId) continue;
                    const input = document.getElementById(inputId);
                    if (input && input.value.trim()) {
                        browseView.performSearch?.(mode, '');
                        cleared = true;
                    }
                }
                return cleared;
            },
        ];

        // Hash guards: Chromium skips pushState entries on back. A reload keeps the hash, so seed past
        // a stale #gN (an equal write adds no entry).
        const staleGuard = /^#g(\d+)$/.exec(location.hash);
        let guardId = staleGuard ? Number(staleGuard[1]) : 0;
        let processedHash = null;
        if (staleGuard && !hasOpenModals()) {
            history.replaceState(null, '', location.pathname + location.search);
            guardId = 0;
        }

        function pushGuard() {
            guardId++;
            processedHash = null;
            location.hash = 'g' + guardId;
            // Chromium can drop a hash write inside a traversal task (where onBack re-arms): verify it
            // landed, else re-arm on the next pointerdown.
            setTimeout(() => {
                if (location.hash === '#g' + guardId || !hasOpenModals()) return;
                document.addEventListener('pointerdown', function rearm() {
                    if (hasOpenModals() && location.hash !== '#g' + guardId) {
                        guardId++;
                        processedHash = null;
                        location.hash = 'g' + guardId;
                    }
                }, { capture: true, once: true });
            }, 0);
        }
        window.pushOverlayGuard = pushGuard;

        function closeTopLayer() {
            for (let i = 0; i < stack.length; i++) {
                const entry = stack[i];
                if (typeof entry === 'function') {
                    if (entry()) return true;
                    continue;
                }
                const [selector, closeFn] = entry;
                const el = document.querySelector(selector);
                if (el) { closeFn(el); return true; }
            }
            return false;
        }

        // an open member of the shared overlay list counts, registered or not, as the phone chrome counts it
        function hasOpenModals() {
            for (let i = 0; i < stack.length; i++) {
                const entry = stack[i];
                if (typeof entry === 'function') continue;
                const [selector] = entry;
                if (document.querySelector(selector)) return true;
            }
            return !!openTopbarDropdown() || !!document.querySelector(OPEN_OVERLAY_SEL) || window.hasOpenOverlay();
        }

        const classObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                const el = m.target;
                const oldClasses = m.oldValue || '';

                if (el.classList.contains('modal-overlay') || el.classList.contains('confirm-modal') ||
                    el.classList.contains('ccs-panel') || el.classList.contains('creator-import-overlay')) {
                    const wasHidden = oldClasses.includes('hidden');
                    const isHidden = el.classList.contains('hidden');
                    if (wasHidden && !isHidden) {
                        pushGuard();
                        return;
                    }
                }
                if (el.classList.contains('gv-modal') || el.classList.contains('cl-modal')) {
                    const wasVisible = oldClasses.includes('visible');
                    const isVisible = el.classList.contains('visible');
                    if (!wasVisible && isVisible) {
                        pushGuard();
                        return;
                    }
                }
                // Browse filter drawers (relocated to body on mobile, bottom-sheet styled).
                // They sit outside the modal classes so they need their own watcher.
                if (el.classList.contains('browse-tags-dropdown') || el.classList.contains('browse-features-dropdown')) {
                    const wasHidden = oldClasses.includes('hidden');
                    const isHidden = el.classList.contains('hidden');
                    if (wasHidden && !isHidden) {
                        pushGuard();
                        return;
                    }
                }
                if (el === document.body) {
                    const had = oldClasses.includes('multi-select-mode');
                    const has = el.classList.contains('multi-select-mode');
                    if (!had && has) { pushGuard(); return; }
                }
            }
        });

        document.querySelectorAll('.modal-overlay, .cl-modal, .gv-modal, .confirm-modal, .browse-tags-dropdown, .browse-features-dropdown').forEach(el => {
            classObserver.observe(el, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
        });
        classObserver.observe(document.body, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });

        const childObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.classList.contains('modal-overlay') ||
                        node.classList.contains('confirm-modal') ||
                        node.classList.contains('mobile-avatar-viewer') ||
                        node.classList.contains('browse-avatar-viewer')) {
                        if (!node.classList.contains('hidden')) pushGuard();
                        classObserver.observe(node, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
                    }
                    if (node.classList.contains('gv-modal') || node.classList.contains('cl-modal')) {
                        classObserver.observe(node, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
                    }
                    if (node.classList.contains('ccs-panel') ||
                        node.classList.contains('creator-import-overlay')) {
                        classObserver.observe(node, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
                        // Inject + show fire same tick; push guard if already visible
                        if (!node.classList.contains('hidden')) pushGuard();
                    }
                    // Filter dropdowns get appendChild-relocated to body on mobile.
                    // Observe them so .hidden toggles emit a guard.
                    if (node.classList.contains('browse-tags-dropdown') || node.classList.contains('browse-features-dropdown')) {
                        classObserver.observe(node, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
                        if (!node.classList.contains('hidden')) pushGuard();
                    }
                }
            }
        });
        childObserver.observe(document.body, { childList: true });

        // the back-press handler
        function onBack() {
            const h = location.hash;
            if (h === '#g' + guardId || (processedHash !== null && h === processedHash)) return;
            processedHash = h;
            if (closeTopLayer() && !location.hash && hasOpenModals()) {
                pushGuard();
            }
        }

        window.addEventListener('hashchange', onBack);
        window.addEventListener('popstate', onBack);

        // Safety net for Android skipping our guards: show "Leave site?" instead of dropping the tab.
        window.addEventListener('beforeunload', function(e) {
            if (hasOpenModals()) {
                e.preventDefault();
                e.returnValue = '';
                return '';
            }
        });

        // Scan-then-observe: a fast first tap can open a modal before this layer arms, and an
        // already-open one makes no mutation.
        if (hasOpenModals()) pushGuard();
    }

    /* ========================================
       SEARCH OVERLAY
       ======================================== */
    function createSearchButton(topbar) {
        const searchArea = topbar.querySelector('.search-area');
        if (!searchArea) return;

        const btn = document.createElement('button');
        btn.id = 'mobileSearchBtn';
        btn.classList.add('mobile-search-btn');
        btn.innerHTML = '<i class="fa-solid fa-search"></i>';
        btn.title = 'Search';
        btn.style.cssText = 'display:flex!important;align-items:center;justify-content:center';
        searchArea.appendChild(btn);

        const overlay = document.createElement('div');
        overlay.className = 'mobile-search-overlay hidden';

        const container = document.createElement('div');
        container.className = 'mobile-search-container';

        overlay.appendChild(container);
        document.body.appendChild(overlay);

        const searchBox = searchArea.querySelector('.search-box');

        // Brave/Chrome mobile drop hash pushes made from inside hashchange/popstate;
        // rearm from the input event (a fresh task). Resets on overlay close.
        let filterGuardPushed = false;

        // Lock the grid scroll while search is open so Android keyboard transitions dont drift the list.
        let scrollLock = null;
        // Keyboard tracker: the layout viewport stays full size (overlays-content), so visualViewport gives the OSK height to lift the overlay by.
        let viewportTracker = null;
        function openSearch() {
            if (searchBox) {
                container.appendChild(searchBox);
            }
            overlay.style.top = `${topbar.offsetHeight}px`;
            overlay.classList.remove('hidden');

            const galleryContent = document.querySelector('.gallery-content');
            if (galleryContent) {
                const savedTop = galleryContent.scrollTop;
                const onScroll = () => { if (galleryContent.scrollTop !== savedTop) galleryContent.scrollTop = savedTop; };
                galleryContent.addEventListener('scroll', onScroll, { passive: true });
                scrollLock = { galleryContent, onScroll };
            }

            if (window.visualViewport) {
                const sync = () => {
                    const vv = window.visualViewport;
                    const keyboardH = Math.max(0, window.innerHeight - vv.height);
                    overlay.style.bottom = keyboardH > 0 ? `${keyboardH}px` : '';
                };
                window.visualViewport.addEventListener('resize', sync);
                window.visualViewport.addEventListener('scroll', sync);
                viewportTracker = sync;
                sync();
            }

            window.pushOverlayGuard?.();

            setTimeout(() => {
                const input = document.getElementById('searchInput');
                // preventScroll: some Android Chromes scroll the nearest scroller (even a sibling .gallery-content) on focus, drifting the grid.
                if (input) input.focus({ preventScroll: true });
            }, 50);
        }

        function closeSearch() {
            overlay.classList.add('hidden');
            overlay.style.bottom = '';
            if (searchBox) {
                searchArea.insertBefore(searchBox, searchArea.firstChild);
            }
            if (scrollLock) {
                scrollLock.galleryContent.removeEventListener('scroll', scrollLock.onScroll);
                scrollLock = null;
            }
            if (viewportTracker && window.visualViewport) {
                window.visualViewport.removeEventListener('resize', viewportTracker);
                window.visualViewport.removeEventListener('scroll', viewportTracker);
                viewportTracker = null;
            }
        }

        btn.addEventListener('click', openSearch);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeSearch();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
                closeSearch();
            }
        });

        const searchInputForGuard = document.getElementById('searchInput');
        if (searchInputForGuard) {
            searchInputForGuard.addEventListener('input', () => {
                if (overlay.classList.contains('hidden')) return;
                const hasValue = !!searchInputForGuard.value.trim();
                if (hasValue && !filterGuardPushed) {
                    window.pushOverlayGuard?.();
                    filterGuardPushed = true;
                }
            });
        }

        new MutationObserver(() => {
            if (overlay.classList.contains('hidden')) filterGuardPushed = false;
        }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }

    /* ========================================
       SETTINGS BOTTOM SHEET (view-aware)
       ======================================== */
    function createSettingsButton(topbar) {
        const btn = document.createElement('button');
        btn.id = 'mobileSettingsBtn';
        btn.classList.add('mobile-settings-btn');
        btn.innerHTML = '<i class="fa-solid fa-sliders"></i>';
        btn.title = 'Settings';
        btn.style.cssText = 'display:flex!important;align-items:center;justify-content:center';
        topbar.appendChild(btn);

        const { overlay, sheet, close } = createBottomSheet({ label: 'Filters and sort' });

        addSheetHandle(sheet);

        const body = document.createElement('div');
        body.className = 'mobile-settings-body';
        sheet.appendChild(body);

        // Characters section
        const charSection = document.createElement('div');
        charSection.className = 'mobile-settings-view-section';
        charSection.dataset.view = 'characters';
        body.appendChild(charSection);

        // Sort
        const sortSection = createSection('Sort By');
        const sortChip = createSettingsSelectChip(() => document.getElementById('sortSelect'), 'Sort By');
        sortSection.appendChild(sortChip);
        charSection.appendChild(sortSection);

        // Filters
        const filterSection = createSection('Filters');
        const filterRow = document.createElement('div');
        filterRow.className = 'mobile-settings-row';

        const favChip = createChip('<i class="fa-solid fa-star"></i> Favorites');
        const favCheckbox = document.getElementById('searchFavoritesOnly');
        if (favCheckbox && favCheckbox.checked) favChip.classList.add('active');
        favChip.addEventListener('click', () => {
            const cb = document.getElementById('searchFavoritesOnly');
            const newState = cb ? !cb.checked : true;
            window.toggleFavoritesFilter(newState);
            setTimeout(() => {
                const cbNow = document.getElementById('searchFavoritesOnly');
                favChip.classList.toggle('active', cbNow ? cbNow.checked : false);
            }, 50);
        });

        const tagChip = createChip('<i class="fa-solid fa-tags"></i> Tags');
        tagChip.addEventListener('click', () => {
            const tagBtn = document.getElementById('tagFilterBtn');
            if (tagBtn) { close(); setTimeout(() => tagBtn.click(), 300); }
        });

        const playlistChip = createChip('<i class="fa-solid fa-list-ul"></i> Playlists');
        playlistChip.addEventListener('click', () => {
            const plBtn = document.getElementById('playlistFilterBtn');
            if (plBtn) { close(); setTimeout(() => plBtn.click(), 300); }
        });

        function syncCharFilterChips() {
            const s = window.getActiveFilterState?.() || {};
            favChip.classList.toggle('active', !!s.fav);
            tagChip.classList.toggle('active', !!s.tag);
            playlistChip.classList.toggle('active', !!s.playlist);
        }

        filterRow.appendChild(favChip);
        filterRow.appendChild(tagChip);
        filterRow.appendChild(playlistChip);
        filterSection.appendChild(filterRow);
        charSection.appendChild(filterSection);

        // Search In
        const searchSection = createSection('Search in');
        const checksGrid = document.createElement('div');
        checksGrid.className = 'mobile-settings-checks';
        [{ id: 'searchName', label: 'Name' }, { id: 'searchTags', label: 'Tags' },
         { id: 'searchAuthor', label: 'Author' }, { id: 'searchNotes', label: 'Notes' },
         { id: 'searchTagline', label: 'Tagline' }]
        .forEach(field => {
            const realCb = document.getElementById(field.id);
            if (!realCb) return;
            const lbl = document.createElement('label');
            lbl.className = 'mobile-check-label';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = realCb.checked;
            cb.addEventListener('change', () => {
                realCb.checked = cb.checked;
                realCb.dispatchEvent(new Event('change', { bubbles: true }));
            });
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(field.label));
            checksGrid.appendChild(lbl);
        });
        searchSection.appendChild(checksGrid);
        charSection.appendChild(searchSection);

        // Refresh
        const charRefresh = createSection('');
        const charRefreshBtn = createChip('<i class="fa-solid fa-sync"></i> Refresh Characters');
        charRefreshBtn.style.width = '100%';
        charRefreshBtn.addEventListener('click', () => {
            const r = document.getElementById('menuRefreshBtn');
            if (r) r.click();
            close();
        });
        charRefresh.appendChild(charRefreshBtn);
        charSection.appendChild(charRefresh);

        // Online kind section (characters / lorebooks; the topbar switch is hidden on a phone)
        const kindSection = document.createElement('div');
        kindSection.className = 'mobile-settings-view-section';
        kindSection.dataset.view = 'online';
        body.appendChild(kindSection);
        const kindRowSection = createSection('Listing');
        const kindRow = document.createElement('div');
        kindRow.className = 'mobile-settings-row';
        const kindChips = {
            characters: createChip('<i class="fa-solid fa-user"></i> Characters'),
            lorebooks: createChip('<i class="fa-solid fa-book-atlas"></i> Lorebooks'),
        };
        for (const [kind, chip] of Object.entries(kindChips)) {
            chip.addEventListener('click', () => { window.setOnlineKind?.(kind); close(); });
            kindRow.appendChild(chip);
        }
        kindRowSection.appendChild(kindRow);
        kindSection.appendChild(kindRowSection);
        function syncKind() {
            const hasLorebooks = !!window.ProviderRegistry?.getActiveProvider?.()?.lorebookView;
            kindSection.hidden = !hasLorebooks;
            const kind = window.ProviderRegistry?.getActiveKind?.() || 'characters';
            for (const [k, chip] of Object.entries(kindChips)) chip.classList.toggle('active', k === kind);
        }

        // Mode-toggle provider section (Chub, Pyg, any provider with hasModeToggle)
        const modeToggleSection = document.createElement('div');
        modeToggleSection.className = 'mobile-settings-view-section';
        modeToggleSection.dataset.view = 'online';
        body.appendChild(modeToggleSection);

        // Mode toggle (Browse / Following)
        const modeSection = createSection('Mode');
        const modeRow = document.createElement('div');
        modeRow.className = 'mobile-settings-row';

        const browseChip = createChip('<i class="fa-solid fa-compass"></i> Browse');
        const followChip = createChip('<i class="fa-solid fa-users"></i> Following');
        browseChip.classList.add('active');

        function getIds() {
            return window.ProviderRegistry?.getActiveMobileFilterIds?.();
        }

        function syncMode() {
            const ids = getIds();
            if (!ids?.modeBrowseSelector) return;
            const browseBtn = document.querySelector(ids.modeBrowseSelector);
            const followBtn = document.querySelector(ids.modeFollowSelector);
            if (browseBtn) browseChip.classList.toggle('active', browseBtn.classList.contains('active'));
            if (followBtn) followChip.classList.toggle('active', followBtn.classList.contains('active'));
        }

        function syncSort() {
            const isFollowing = followChip.classList.contains('active');
            const hasFollowSort = !!getIds()?.timelineSort;
            // where no sort applies the bar shows its greyed stand-in, and so does the sheet: Sort By never empties or jumps
            const standIn = standInOf(getIds());
            mtStandInChip.hidden = !standIn;
            if (standIn) {
                mtStandInChip._syncLabel();
                mirrorAvailability(mtStandInChip, standIn._customSelect?.trigger);
            }
            mtBrowseSortChip.hidden = isFollowing || !!standIn;
            mtFollowSortChip.hidden = !(isFollowing && hasFollowSort) || !!standIn;
            mtSortSection.hidden = mtBrowseSortChip.hidden && mtFollowSortChip.hidden && mtStandInChip.hidden && mtSubSortChip.hidden;
        }

        browseChip.addEventListener('click', () => {
            const ids = getIds();
            const realBtn = ids?.modeBrowseSelector ? document.querySelector(ids.modeBrowseSelector) : null;
            if (realBtn) { realBtn.click(); setTimeout(syncModeToggleSheet, 100); }
            close();
        });
        followChip.addEventListener('click', () => {
            const ids = getIds();
            const realBtn = ids?.modeFollowSelector ? document.querySelector(ids.modeFollowSelector) : null;
            if (realBtn) { realBtn.click(); setTimeout(syncModeToggleSheet, 100); }
            close();
        });

        modeRow.appendChild(browseChip);
        modeRow.appendChild(followChip);
        modeSection.appendChild(modeRow);
        modeToggleSection.appendChild(modeSection);

        // Sort - browse sort + following sort chips, toggled by mode
        const mtSortSection = createSection('Sort By');

        const mtBrowseSortChip = createSettingsSelectChip(
            () => { const ids = getIds(); return ids?.sort ? document.getElementById(ids.sort) : null; },
            'Sort By',
            () => syncModeToggleSheet(),
        );
        mtSortSection.appendChild(mtBrowseSortChip);

        // A provider's optional sub-sort (mobileFilterIds.subSort): shown while its select is neither browse-filter-hidden nor hidden
        const mtSubSortChip = createSettingsSelectChip(
            () => { const ids = getIds(); return ids?.subSort ? document.getElementById(ids.subSort) : null; },
            'Sort By',
            () => syncModeToggleSheet(),
        );
        mtSubSortChip.hidden = true;
        mtSubSortChip.style.marginTop = 'var(--space-sm)';
        mtSortSection.appendChild(mtSubSortChip);

        function syncSubSort() {
            const ids = getIds();
            const real = ids?.subSort ? document.getElementById(ids.subSort) : null;
            const realTarget = real ? (real._customSelect?.container || real) : null;
            const show = !!realTarget && !realTarget.classList.contains('browse-filter-hidden') && !realTarget.classList.contains('hidden');
            if (show) mtSubSortChip._syncLabel();
            mtSubSortChip.hidden = !show;
        }

        const mtFollowSortChip = createSettingsSelectChip(
            () => { const ids = getIds(); return ids?.timelineSort ? document.getElementById(ids.timelineSort) : null; },
            'Sort By',
            () => syncModeToggleSheet(),
        );
        mtFollowSortChip.hidden = true;
        mtSortSection.appendChild(mtFollowSortChip);

        // the bar's stand-in (syncSortStandIn) beside the view's sort, while it shows
        function standInOf(ids) {
            const sort = ids?.sort ? document.getElementById(ids.sort) : null;
            const select = sort?.closest('.browse-sort-container')?.querySelector('select.browse-sort-standin');
            const box = select?._customSelect?.container;
            return box && !box.classList.contains('hidden') ? select : null;
        }
        const mtStandInChip = createSettingsSelectChip(() => standInOf(getIds()), 'Sort By');
        mtStandInChip.hidden = true;
        mtSortSection.appendChild(mtStandInChip);
        modeToggleSection.appendChild(mtSortSection);

        // Filters row (Tags, Features, NSFW)
        const mtFilterSection = createSection('Filters');
        const mtFilterRow = document.createElement('div');
        mtFilterRow.className = 'mobile-settings-row';
        mtFilterRow.style.flexWrap = 'wrap';

        const mtTagsChip = createChip('<i class="fa-solid fa-tags"></i> Tags');
        mtTagsChip.addEventListener('click', () => {
            const ids = getIds();
            const realBtn = ids?.tags ? document.getElementById(ids.tags) : null;
            if (realBtn) { close(); setTimeout(() => realBtn.click(), 300); }
        });

        // mirrors the real button: hidden (a provider's browse-filter-hidden) hides the chip, greyed greys it and a tap says why
        function syncMtTags() {
            const ids = getIds();
            const realBtn = ids?.tags ? document.getElementById(ids.tags) : null;
            const box = realBtn?.closest('.browse-tags-dropdown-container') || realBtn;
            mtTagsChip.hidden = !!box && box.classList.contains('browse-filter-hidden');
            mirrorAvailability(mtTagsChip, realBtn);
        }

        const mtFeaturesChip = createChip('<i class="fa-solid fa-sliders"></i> Features');
        mtFeaturesChip.addEventListener('click', () => {
            const ids = getIds();
            const realBtn = ids?.filters ? document.getElementById(ids.filters) : null;
            if (realBtn) { close(); setTimeout(() => realBtn.click(), 300); }
        });

        const mtNsfwChip = createChip('<i class="fa-solid fa-shield-halved"></i> SFW Only');
        function syncMtNsfwState() {
            const ids = getIds();
            const realBtn = ids?.nsfw ? document.getElementById(ids.nsfw) : null;
            if (realBtn) {
                const span = realBtn.querySelector('span');
                const label = span ? span.textContent.trim() : 'SFW Only';
                mtNsfwChip.innerHTML = '<i class="fa-solid fa-shield-halved"></i> ' + label;
                mtNsfwChip.classList.toggle('active', realBtn.classList.contains('active'));
            }
            mirrorAvailability(mtNsfwChip, realBtn);
        }
        mtNsfwChip.addEventListener('click', () => {
            const ids = getIds();
            const realBtn = ids?.nsfw ? document.getElementById(ids.nsfw) : null;
            if (realBtn) { realBtn.click(); setTimeout(syncMtNsfwState, 100); }
        });

        // a chip mirroring a control that cannot be used now greys like it and, tapped, says why: a phone shows no tooltip
        function mirrorAvailability(chip, real) {
            const why = window.unavailableReason?.(real, real?.closest('.online-kind-filter > *')) ?? null;
            chip.classList.toggle('is-unavailable', why !== null);
            chip.setAttribute('aria-disabled', why !== null ? 'true' : 'false');
            chip.dataset.unavailableWhy = why || '';
        }
        modeToggleSection.addEventListener('click', (e) => {
            const chip = e.target.closest('.is-unavailable');
            if (!chip || !modeToggleSection.contains(chip)) return;
            // capture runs before the chip's own handler, which would proxy to a control that does nothing
            e.stopPropagation();
            e.preventDefault();
            const why = chip.dataset.unavailableWhy;
            if (why) window.showToast?.(why, 'info', 3000, { group: `unavailable:${why}` });
        }, true);

        // the sheet mirrors the bar at open, and again after a pick made inside it (a sort can grey Tags, as DataCat's do)
        function syncModeToggleSheet() {
            mtBrowseSortChip._syncLabel();
            mtFollowSortChip._syncLabel();
            syncMode();
            syncMtNsfwState();
            syncSort();
            syncSubSort();
            syncMtTags();
        }

        mtFilterRow.appendChild(mtTagsChip);
        mtFilterRow.appendChild(mtFeaturesChip);
        mtFilterRow.appendChild(mtNsfwChip);
        mtFilterSection.appendChild(mtFilterRow);
        modeToggleSection.appendChild(mtFilterSection);

        // Refresh
        const mtActionsSection = createSection('');
        const mtActionsRow = document.createElement('div');
        mtActionsRow.className = 'mobile-settings-row';

        const mtRefreshChip = createChip('<i class="fa-solid fa-sync"></i> Refresh');
        mtRefreshChip.style.width = '100%';
        mtRefreshChip.addEventListener('click', () => {
            const ids = getIds();
            const realBtn = ids?.refresh ? document.getElementById(ids.refresh) : null;
            if (realBtn) { realBtn.click(); close(); }
        });

        mtActionsRow.appendChild(mtRefreshChip);
        mtActionsSection.appendChild(mtActionsRow);
        modeToggleSection.appendChild(mtActionsSection);

        // Generic provider section (no mode toggle - Janny, CT, future providers)
        const genericSection = document.createElement('div');
        genericSection.className = 'mobile-settings-view-section';
        genericSection.dataset.view = 'online';
        genericSection.hidden = true;

        const genericProviderLabel = document.createElement('div');
        genericProviderLabel.className = 'mobile-settings-label';
        genericProviderLabel.id = 'mobileProviderName';
        genericProviderLabel.textContent = '';

        // Sort
        const genericSortSection = createSection('Sort By');
        const genericSortChip = createSettingsSelectChip(
            () => { const ids = window.ProviderRegistry?.getActiveMobileFilterIds?.(); return ids?.sort ? document.getElementById(ids.sort) : null; },
            'Sort By',
        );
        genericSortSection.appendChild(genericSortChip);
        genericSection.appendChild(genericProviderLabel);
        genericSection.appendChild(genericSortSection);

        // Filters row (Tags, Features, NSFW)
        const genericFilterSection = createSection('Filters');
        const genericFilterRow = document.createElement('div');
        genericFilterRow.className = 'mobile-settings-row';
        genericFilterRow.style.flexWrap = 'wrap';

        const genericTagsChip = createChip('<i class="fa-solid fa-tags"></i> Tags');
        genericTagsChip.addEventListener('click', () => {
            const ids = window.ProviderRegistry?.getActiveMobileFilterIds?.();
            const realBtn = ids?.tags ? document.getElementById(ids.tags) : null;
            if (realBtn) { close(); setTimeout(() => realBtn.click(), 300); }
        });

        const genericFeaturesChip = createChip('<i class="fa-solid fa-sliders"></i> Features');
        genericFeaturesChip.addEventListener('click', () => {
            const ids = window.ProviderRegistry?.getActiveMobileFilterIds?.();
            const realBtn = ids?.filters ? document.getElementById(ids.filters) : null;
            if (realBtn) { close(); setTimeout(() => realBtn.click(), 300); }
        });

        const genericNsfwChip = createChip('<i class="fa-solid fa-shield-halved"></i> SFW Only');
        function syncGenericNsfwState() {
            const ids = window.ProviderRegistry?.getActiveMobileFilterIds?.();
            const realBtn = ids?.nsfw ? document.getElementById(ids.nsfw) : null;
            if (realBtn) {
                const span = realBtn.querySelector('span');
                const label = span ? span.textContent.trim() : 'SFW Only';
                genericNsfwChip.innerHTML = '<i class="fa-solid fa-shield-halved"></i> ' + label;
                genericNsfwChip.classList.toggle('active', realBtn.classList.contains('active'));
            }
        }
        genericNsfwChip.addEventListener('click', () => {
            const ids = window.ProviderRegistry?.getActiveMobileFilterIds?.();
            const realBtn = ids?.nsfw ? document.getElementById(ids.nsfw) : null;
            if (realBtn) { realBtn.click(); setTimeout(syncGenericNsfwState, 100); }
        });

        genericFilterRow.appendChild(genericTagsChip);
        genericFilterRow.appendChild(genericFeaturesChip);
        genericFilterRow.appendChild(genericNsfwChip);
        genericFilterSection.appendChild(genericFilterRow);
        genericSection.appendChild(genericFilterSection);

        // Refresh
        const genericActionsSection = createSection('');
        const genericRefreshChip = createChip('<i class="fa-solid fa-sync"></i> Refresh');
        genericRefreshChip.style.width = '100%';
        genericRefreshChip.addEventListener('click', () => {
            const ids = window.ProviderRegistry?.getActiveMobileFilterIds?.();
            const realBtn = ids?.refresh ? document.getElementById(ids.refresh) : null;
            if (realBtn) { realBtn.click(); close(); }
        });
        genericActionsSection.appendChild(genericRefreshChip);
        genericSection.appendChild(genericActionsSection);
        body.appendChild(genericSection);

        // Chats section
        const chatsSection = document.createElement('div');
        chatsSection.className = 'mobile-settings-view-section';
        chatsSection.dataset.view = 'chats';
        body.appendChild(chatsSection);

        // Sort
        const chatsSortSection = createSection('Sort By');
        const chatsSortChip = createSettingsSelectChip(() => document.getElementById('chatsSortSelect'), 'Sort By');
        chatsSortSection.appendChild(chatsSortChip);
        chatsSection.appendChild(chatsSortSection);

        // View lens (recent by time, or by character)
        const groupSection = createSection('View');
        const groupRow = document.createElement('div');
        groupRow.className = 'mobile-settings-row';

        const flatChip = createChip('<i class="fa-solid fa-clock"></i> Recent');
        const groupedChip = createChip('<i class="fa-solid fa-layer-group"></i> By character');
        flatChip.classList.add('active');

        // Layout (list or cards); mirrors the real toggle, hidden in the character lens like it
        const layoutSection = createSection('Layout');
        const layoutRow = document.createElement('div');
        layoutRow.className = 'mobile-settings-row';
        const listChip = createChip('<i class="fa-solid fa-list"></i> List');
        const cardsChip = createChip('<i class="fa-solid fa-address-card"></i> Cards');
        listChip.classList.add('active');

        function syncChatsLayout() {
            const real = document.getElementById('chatLayoutToggle');
            const show = !!real && !real.classList.contains('hidden');
            layoutSection.hidden = !show;
            document.querySelectorAll('.chat-layout-btn').forEach(b => {
                const on = b.classList.contains('active');
                if (b.dataset.layout === 'list') listChip.classList.toggle('active', on);
                else if (b.dataset.layout === 'cards') cardsChip.classList.toggle('active', on);
            });
        }
        listChip.addEventListener('click', () => {
            document.querySelector('.chat-layout-btn[data-layout="list"]')?.click();
            setTimeout(syncChatsLayout, 100);
        });
        cardsChip.addEventListener('click', () => {
            document.querySelector('.chat-layout-btn[data-layout="cards"]')?.click();
            setTimeout(syncChatsLayout, 100);
        });
        layoutRow.appendChild(listChip);
        layoutRow.appendChild(cardsChip);
        layoutSection.appendChild(layoutRow);

        function syncGrouping() {
            const realBtns = document.querySelectorAll('.grouping-btn');
            realBtns.forEach(b => {
                if (b.dataset.group === 'flat') {
                    flatChip.classList.toggle('active', b.classList.contains('active'));
                } else if (b.dataset.group === 'grouped') {
                    groupedChip.classList.toggle('active', b.classList.contains('active'));
                }
            });
            syncChatsLayout();
        }

        flatChip.addEventListener('click', () => {
            const realBtn = document.querySelector('.grouping-btn[data-group="flat"]');
            if (realBtn) { realBtn.click(); setTimeout(syncGrouping, 100); }
        });
        groupedChip.addEventListener('click', () => {
            const realBtn = document.querySelector('.grouping-btn[data-group="grouped"]');
            if (realBtn) { realBtn.click(); setTimeout(syncGrouping, 100); }
        });

        groupRow.appendChild(flatChip);
        groupRow.appendChild(groupedChip);
        groupSection.appendChild(groupRow);
        chatsSection.appendChild(groupSection);
        chatsSection.appendChild(layoutSection);

        // Refresh
        const chatsRefresh = createSection('');
        const chatsRefreshBtn = createChip('<i class="fa-solid fa-sync"></i> Refresh Chats');
        chatsRefreshBtn.style.width = '100%';
        chatsRefreshBtn.addEventListener('click', () => {
            const r = document.getElementById('refreshChatsViewBtn');
            if (r) r.click();
            close();
        });
        chatsRefresh.appendChild(chatsRefreshBtn);
        chatsSection.appendChild(chatsRefresh);

        // View-aware open logic
        btn.addEventListener('click', () => {
            const activeView = getActiveView();

            body.querySelectorAll('.mobile-settings-view-section').forEach(s => {
                s.hidden = s.dataset.view !== activeView;
            });

            if (activeView === 'online') {
                const reg = window.ProviderRegistry;
                const hasModeToggle = reg?.activeProviderHasModeToggle?.() || false;
                const ids = reg?.getActiveMobileFilterIds?.();

                syncKind();
                modeToggleSection.hidden = !hasModeToggle;
                genericSection.hidden = hasModeToggle;

                if (!hasModeToggle) {
                    const prov = reg?.getActiveProvider?.();
                    genericProviderLabel.textContent = prov ? prov.name : 'Online';
                    genericSortChip._syncLabel();
                    syncGenericNsfwState();
                    // a view without the control (the lorebook kind) gets no dead chip
                    genericTagsChip.hidden = !ids?.tags;
                    genericFeaturesChip.hidden = !ids?.filters;
                    genericNsfwChip.hidden = !ids?.nsfw;
                    genericFilterSection.hidden = !(ids?.tags || ids?.filters || ids?.nsfw);
                }

                if (hasModeToggle) {
                    // Chips read options live from the real selects at open time; only labels + per-mode visibility refresh here.
                    syncModeToggleSheet();
                }
            } else if (activeView === 'chats') {
                syncGrouping();
                chatsSortChip._syncLabel();
            } else {
                sortChip._syncLabel();
                syncCharFilterChips();
            }

            openSheet(overlay, sheet);
        });

        document.body.appendChild(overlay);
    }

    function getActiveView() {
        // the shell's own answer, which names an extension's view too; the containers' state is
        // the fallback before the shell is up
        const view = window.getCurrentView?.();
        if (view) return view;
        const onlineView = document.getElementById('onlineView');
        const chatsView = document.getElementById('chatsView');
        if (onlineView && !onlineView.classList.contains('hidden')) return 'online';
        if (chatsView && !chatsView.classList.contains('hidden')) return 'chats';
        return 'characters';
    }

    function createChip(html) {
        const chip = document.createElement('button');
        chip.className = 'mobile-filter-chip';
        chip.innerHTML = html;
        return chip;
    }

    function createSettingsSelectChip(getRealSelect, title, afterSelect) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'mobile-settings-select';
        chip.innerHTML = '<span class="mobile-settings-select-text"></span><i class="fa-solid fa-chevron-down mobile-settings-select-arrow"></i>';
        chip._syncLabel = () => {
            const real = getRealSelect();
            const opt = real ? real.options[real.selectedIndex] : null;
            const text = chip.querySelector('.mobile-settings-select-text');
            text.textContent = opt?.textContent || '';
            // the chosen option's icon before its label, as the desktop trigger wears it
            chip.querySelectorAll('.mobile-settings-select-icon').forEach(el => el.remove());
            let icon = null;
            if (opt?.dataset.iconUrl) {
                icon = document.createElement('img');
                icon.src = opt.dataset.iconUrl;
                icon.alt = '';
                icon.className = 'trigger-icon-img mobile-settings-select-icon';
            } else if (opt?.dataset.icon) {
                icon = document.createElement('i');
                icon.className = `${opt.dataset.icon} mobile-settings-select-icon`;
                icon.setAttribute('aria-hidden', 'true');
            }
            if (icon) chip.insertBefore(icon, text);
        };
        chip.addEventListener('click', () => {
            const real = getRealSelect();
            if (!real) return;
            window.openSelectorSheetFromSelect?.(real, {
                title,
                onSelect: () => { chip._syncLabel(); afterSelect?.(); },
            });
        });
        return chip;
    }

    // <label for=id> text (settings rows) as a drawer-title fallback; strips trailing colon.
    function selectLabelText(select) {
        if (!select.id) return '';
        const lbl = document.querySelector(`label[for="${select.id}"]`);
        return lbl ? lbl.textContent.replace(/\s*:\s*$/, '').trim() : '';
    }

    let _selectorSheet = null;
    function openSelectorSheetFromSelect(select, opts = {}) {
        if (!select) return;
        if (!_selectorSheet) {
            _selectorSheet = createBottomSheet();
            document.body.appendChild(_selectorSheet.overlay);
        }
        const { overlay, sheet, close } = _selectorSheet;
        sheet.innerHTML = '';

        addSheetHandle(sheet);

        const title = opts.title || select.title || select.getAttribute('aria-label') || selectLabelText(select);
        if (title) {
            const t = document.createElement('div');
            t.className = 'mobile-sheet-title';
            t.textContent = title;
            sheet.appendChild(t);
        }

        const current = select.value;

        const addOption = (opt) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'mobile-sheet-item';
            const selected = opt.value === current;
            if (selected) item.classList.add('active');
            if (opt.disabled) item.disabled = true;
            if (opt.dataset.iconUrl) {
                const img = document.createElement('img');
                img.src = opt.dataset.iconUrl;
                img.className = 'item-icon-img';
                img.alt = '';
                item.appendChild(img);
            } else if (opt.dataset.icon) {
                const i = document.createElement('i');
                i.className = opt.dataset.icon;
                item.appendChild(i);
            }
            const label = document.createElement('span');
            label.className = 'mobile-sheet-item-label';
            label.textContent = opt.textContent;
            item.appendChild(label);
            if (selected) {
                const chk = document.createElement('i');
                chk.className = 'fa-solid fa-check mobile-sheet-check';
                item.appendChild(chk);
            }
            item.addEventListener('click', () => {
                if (opt.disabled) return;
                select.value = opt.value;
                // input then change, both bubbling: the full native select contract, so
                // input-delegating consumers hear the pick on mobile too.
                select.dispatchEvent(new Event('input', { bubbles: true }));
                select.dispatchEvent(new Event('change', { bubbles: true }));
                close();
                opts.onSelect?.(select);
            });
            sheet.appendChild(item);
        };

        for (const child of select.children) {
            if (child.tagName === 'OPTGROUP') {
                const gt = document.createElement('div');
                gt.className = 'mobile-sheet-group-title';
                gt.textContent = child.label;
                sheet.appendChild(gt);
                for (const o of child.children) if (o.tagName === 'OPTION') addOption(o);
            } else if (child.tagName === 'OPTION') {
                addOption(child);
            }
        }

        openSheet(overlay, sheet);
    }
    window.openSelectorSheetFromSelect = openSelectorSheetFromSelect;

    /* ========================================
       MENU BOTTOM SHEET
       ======================================== */
    function createMenuButton(topbar) {
        const btn = document.createElement('button');
        btn.id = 'mobileMenuBtn';
        btn.classList.add('mobile-menu-btn');
        btn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';
        btn.title = 'More';
        btn.style.cssText = 'display:flex!important;align-items:center;justify-content:center';
        topbar.appendChild(btn);

        const { overlay, sheet, close } = createBottomSheet({ label: 'More options' });

        addSheetHandle(sheet);

        const moreOptionsMenu = document.getElementById('moreOptionsMenu');
        // Rebuilt from the live desktop menu on every open, so rows landing later (extensions load
        // last) reach the phone.
        const rebuildItems = () => {
            if (!moreOptionsMenu) return;
            sheet.querySelectorAll('[data-cloned-item]').forEach(el => el.remove());
            // the cloned rows sit before the sheet's own rows (notifications, the provider switch)
            const anchor = sheet.querySelector('.mobile-sheet-item');
            const frag = document.createDocumentFragment();
            for (const item of moreOptionsMenu.children) {
                if (item.classList.contains('dropdown-section-title')) {
                    const title = document.createElement('div');
                    title.className = 'mobile-sheet-group-title';
                    title.dataset.clonedItem = '1';
                    title.textContent = item.textContent.trim();
                    frag.appendChild(title);
                    continue;
                }
                if (!item.classList.contains('dropdown-item')) continue;

                const mobileItem = document.createElement('button');
                mobileItem.className = 'mobile-sheet-item';
                mobileItem.dataset.clonedItem = '1';

                const icon = item.querySelector('i');
                if (icon) mobileItem.appendChild(icon.cloneNode(true));
                mobileItem.appendChild(document.createTextNode(item.textContent.trim()));

                // The desktop menu gates these per view with the hidden attribute, written by
                // switchView; carrying the scope lets the open handler re-apply it per view.
                if (item.dataset.viewScope) mobileItem.dataset.viewScope = item.dataset.viewScope;

                mobileItem.addEventListener('click', () => {
                    // close first, then act: a toast the action fires lands where the sheet was, not above a
                    // sheet on its way out
                    close();
                    item.click();
                });
                frag.appendChild(mobileItem);
            }
            sheet.insertBefore(frag, anchor);
        };
        rebuildItems();

        // The extensions' views (the phone's door to them): a group at the sheet's foot, nearest the
        // thumb, rebuilt per open, the current view marked
        const rebuildViewItems = () => {
            sheet.querySelectorAll('[data-view-item]').forEach(el => el.remove());
            const views = window.ExtensionHost?.getViews?.() || [];
            if (!views.length) return;
            const current = getActiveView();
            const frag = document.createDocumentFragment();
            const title = document.createElement('div');
            title.className = 'mobile-sheet-group-title';
            title.dataset.viewItem = '1';
            title.textContent = 'Views';
            frag.appendChild(title);
            for (const v of views) {
                const item = document.createElement('button');
                item.className = 'mobile-sheet-item';
                item.dataset.viewItem = '1';
                const icon = document.createElement('i');
                icon.className = `fa-solid ${v.icon}`;
                item.append(icon, document.createTextNode(v.label));
                if (v.name === current) {
                    item.classList.add('active');
                    const check = document.createElement('i');
                    check.className = 'fa-solid fa-check mobile-sheet-item-check';
                    item.appendChild(check);
                }
                item.addEventListener('click', () => {
                    close();
                    window.goToView(v.name);
                });
                frag.appendChild(item);
            }
            sheet.appendChild(frag);
        };

        // Notifications: the phone's door to the notifications sheet (setupNotificationsSheet)
        if (document.getElementById('notificationsDropdown')) {
            const notifItem = document.createElement('button');
            notifItem.className = 'mobile-sheet-item';
            notifItem.innerHTML = '<i class="fa-solid fa-bell"></i> Notifications';
            notifItem.dataset.notifChrome = '';
            notifItem.addEventListener('click', () => {
                close();
                // Small delay so the sheet closes first
                setTimeout(() => openNotificationsSheet?.(), 350);
            });
            sheet.appendChild(notifItem);
            notifRow = notifItem;
        }

        // Provider switcher button (shown only when online view is active)
        const providerSwitchItem = document.createElement('button');
        providerSwitchItem.className = 'mobile-sheet-item';
        providerSwitchItem.hidden = true;
        providerSwitchItem.innerHTML = '<i class="fa-solid fa-shuffle"></i> Switch Provider <i class="fa-solid fa-chevron-right mobile-sheet-item-chevron"></i>';
        sheet.appendChild(providerSwitchItem);

        // Sub-drawer for provider selection
        const { overlay: provSubOverlay, sheet: provSubSheet, close: closeProvSub } = createBottomSheet({ label: 'Switch Provider' });

        providerSwitchItem.addEventListener('click', () => {
            if (!window.ProviderRegistry) return;
            const providers = window.ProviderRegistry.getViewProviders();
            const activeId = window.ProviderRegistry.getActiveProviderId();
            provSubSheet.innerHTML = '';

            const subTitle = document.createElement('div');
            subTitle.style.cssText = 'font-size: 0.8rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; padding: 16px 20px 8px;';
            subTitle.textContent = 'Switch Provider';
            provSubSheet.appendChild(subTitle);

            providers.forEach(p => {
                const item = document.createElement('button');
                item.className = 'mobile-sheet-item';
                if (p.id === activeId) item.style.color = 'var(--accent)';
                const check = p.id === activeId ? ' <i class="fa-solid fa-check mobile-sheet-item-check"></i>' : '';
                item.innerHTML = '<i class="' + p.icon + '"></i> ' + p.name + check;
                item.addEventListener('click', () => {
                    if (p.id !== activeId) {
                        const select = document.getElementById('providerSelect');
                        if (select) {
                            select.value = p.id;
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                    closeProvSub();
                });
                provSubSheet.appendChild(item);
            });

            close();
            // Small delay so the main sheet animates out first
            setTimeout(() => openSheet(provSubOverlay, provSubSheet), 180);
        });

        document.body.appendChild(provSubOverlay);

        btn.addEventListener('click', () => {
            // the extension section is decided per open (when() reads the view), then cloned
            renderExtensionAppActions();
            rebuildItems();
            rebuildViewItems();
            const view = getActiveView();
            providerSwitchItem.hidden = view !== 'online';
            for (const el of sheet.querySelectorAll('[data-view-scope]')) {
                el.hidden = !el.dataset.viewScope.split(' ').includes(view);
            }

            openSheet(overlay, sheet);
        });
        document.body.appendChild(overlay);
    }

    /* ========================================
       PROVIDER QUICK SWITCH BUTTON
       ======================================== */
    function createProviderQuickSwitch(topbar) {
        const btn = document.createElement('button');
        btn.id = 'mobileProviderQuickSwitch';
        btn.className = 'mobile-provider-quick-switch hidden';
        btn.title = 'Switch Provider';
        btn.innerHTML = '<i class="fa-solid fa-globe"></i>';
        btn.style.cssText = 'touch-action:manipulation';

        const viewToggle = topbar.querySelector('.view-toggle');
        if (viewToggle && viewToggle.nextSibling) {
            topbar.insertBefore(btn, viewToggle.nextSibling);
        } else {
            topbar.appendChild(btn);
        }

        function updateIcon() {
            if (!window.ProviderRegistry) return;
            const activeId = window.ProviderRegistry.getActiveProviderId();
            const providers = window.ProviderRegistry.getViewProviders();
            const active = providers.find(p => p.id === activeId);
            if (!active) return;

            if (active.iconUrl) {
                btn.innerHTML = '';
                const img = document.createElement('img');
                img.src = active.iconUrl;
                img.alt = active.name;
                img.className = 'mobile-provider-quick-switch-icon';
                btn.appendChild(img);
            } else {
                btn.innerHTML = '<i class="' + active.icon + '"></i>';
            }
            btn.title = active.name;
        }

        function updateVisibility() {
            const isOnline = getActiveView() === 'online';
            const enabled = window.getSetting?.('mobileProviderQuickSwitch') !== false;
            btn.classList.toggle('hidden', !isOnline || !enabled);
            if (isOnline) updateIcon();
        }

        // Track view changes by wrapping switchView
        const origSwitch = window.switchView;
        if (origSwitch) {
            window.switchView = function(view) {
                const loaded = origSwitch.call(this, view);
                updateVisibility();
                return loaded;
            };
        }

        // Also listen to view toggle clicks for redundancy
        document.querySelectorAll('.view-toggle-btn').forEach(b => {
            b.addEventListener('click', () => setTimeout(updateVisibility, 50));
        });

        // Bottom sheet for provider selection
        const { overlay, sheet, close } = createBottomSheet();

        function populateSheet() {
            if (!window.ProviderRegistry) return;
            const providers = window.ProviderRegistry.getViewProviders();
            const activeId = window.ProviderRegistry.getActiveProviderId();
            sheet.innerHTML = '';

            addSheetHandle(sheet);

            const title = document.createElement('div');
            title.className = 'mobile-provider-sheet-title';
            title.textContent = 'Switch Provider';
            sheet.appendChild(title);

            providers.forEach(p => {
                const item = document.createElement('button');
                item.className = 'mobile-sheet-item';
                if (p.id === activeId) item.style.color = 'var(--accent)';

                if (p.iconUrl) {
                    const img = document.createElement('img');
                    img.src = p.iconUrl;
                    img.alt = p.name;
                    img.className = 'mobile-provider-sheet-icon';
                    item.appendChild(img);
                } else {
                    const icon = document.createElement('i');
                    icon.className = p.icon;
                    item.appendChild(icon);
                }

                const name = document.createTextNode(' ' + p.name);
                item.appendChild(name);

                if (p.id === activeId) {
                    const check = document.createElement('i');
                    check.className = 'fa-solid fa-check';
                    check.style.cssText = 'margin-left:auto;font-size:0.8rem;';
                    item.appendChild(check);
                }

                item.addEventListener('click', () => {
                    if (p.id !== activeId) {
                        const select = document.getElementById('providerSelect');
                        if (select) {
                            select.value = p.id;
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                    close();
                    setTimeout(updateIcon, 100);
                });
                sheet.appendChild(item);
            });
        }

        btn.addEventListener('click', () => {
            populateSheet();
            openSheet(overlay, sheet);
        });

        document.body.appendChild(overlay);

        setTimeout(updateVisibility, 300);
    }

    /* ========================================
       BOTTOM SHEET HELPERS
       ======================================== */
    // Separate from createBottomSheet because builders re-clear the sheet after creating it.
    function addSheetHandle(sheet) {
        const h = document.createElement('div');
        h.className = 'mobile-sheet-handle';
        sheet.appendChild(h);
        return h;
    }

    const SHEET_TITLE_SEL = '.mobile-sheet-title, .mobile-provider-sheet-title, .mobile-sheet-group-title, .mobile-confirm-title';

    function createBottomSheet({ ephemeral = false, label = '' } = {}) {
        const overlay = document.createElement('div');
        overlay.className = 'mobile-sheet-overlay hidden';

        const backdrop = document.createElement('div');
        backdrop.className = 'mobile-sheet-backdrop';

        const sheet = document.createElement('div');
        sheet.className = 'mobile-sheet';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        if (label) {
            sheet.dataset.sheetLabel = label;
            sheet.setAttribute('aria-label', label);
        }

        overlay.appendChild(backdrop);
        overlay.appendChild(sheet);

        function close() {
            sheet.classList.remove('open');
            // Ephemeral sheets leave the DOM: per-tap builders make a fresh one each open, and hidden
            // leftovers pile up listeners.
            setTimeout(() => {
                overlay.classList.add('hidden');
                if (ephemeral) overlay.remove();
            }, 300);
        }

        backdrop.addEventListener('click', close);
        overlay._closeFn = close;   // drag-to-dismiss routes through the canonical close

        return { overlay, sheet, close };
    }

    // Composed builder for modules: overlay mounted, handle added, so a caller gets drag-dismiss
    // and back enrollment for free.
    function makeSheet({ label = '' } = {}) {
        const parts = createBottomSheet({ ephemeral: true, label });
        addSheetHandle(parts.sheet);
        document.body.appendChild(parts.overlay);
        return { ...parts, open: () => openSheet(parts.overlay, parts.sheet) };
    }

    function openSheet(overlay, sheet) {
        // a reused sheet (the selector's) shows a new title per open, so an unlabelled one is named here
        if (!sheet.dataset.sheetLabel) {
            const title = sheet.querySelector(SHEET_TITLE_SEL)?.textContent.trim();
            if (title) sheet.setAttribute('aria-label', title);
            else sheet.removeAttribute('aria-label');
        }
        overlay.classList.remove('hidden');
        // lift the sheet above whatever is on top (eg. a picker over the 10001 studio overlay) so it isnt buried at the sheet layer
        let topZ = 0;
        document.querySelectorAll(`${OPEN_OVERLAY_SEL}, .ccs-panel:not(.hidden), .creator-modal-glass:not(.hidden), .mobile-sheet-overlay:not(.hidden)`).forEach(el => {
            if (el === overlay) return;
            const z = parseInt(getComputedStyle(el).zIndex, 10);
            if (Number.isFinite(z) && z > topZ) topZ = z;
        });
        overlay.style.zIndex = topZ >= 1200 ? String(topZ + 1) : '';
        // Force reflow then animate
        sheet.offsetHeight; // eslint-disable-line no-unused-expressions
        requestAnimationFrame(() => sheet.classList.add('open'));
        // Every mobile bottom-sheet flows through here; push a back-guard so
        // Android back closes the sheet instead of falling through to nav.
        window.pushOverlayGuard?.();
    }

    function createSection(label) {
        const section = document.createElement('div');
        section.className = 'mobile-settings-section';
        if (label) {
            const lbl = document.createElement('div');
            lbl.className = 'mobile-settings-label';
            lbl.textContent = label;
            section.appendChild(lbl);
        }
        return section;
    }

    /* ========================================
       MODAL HEADER COLLAPSE ON SCROLL
       ======================================== */
    function setupModalHeaderCollapse() {
        const wired = new WeakSet();

        function wireOverlay(overlay, glass, getScrollBody, resetSelector) {
            if (wired.has(overlay)) return;
            wired.add(overlay);

            let lastScrollY = 0;
            let attached = false;
            let scrollBody = null;
            let collapsedAt = 0;
            // Suppresses scroll-driven header toggles while layout settles.
            let toggleCooldownUntil = 0;

            function handleScroll() {
                if (!scrollBody) return;
                const y = scrollBody.scrollTop;
                const isBrowse = glass.classList.contains('browse-char-modal');

                if (isBrowse && window.getSetting?.('browseSnapSections') !== false) {
                    const hasSnap = scrollBody.classList.contains('snap-active');
                    if (y > 50 && !hasSnap) scrollBody.classList.add('snap-active');
                    else if (y <= 50 && hasSnap) scrollBody.classList.remove('snap-active');
                }

                if (Date.now() < toggleCooldownUntil) {
                    lastScrollY = y;
                    return;
                }

                // No scroll runway: keep the header revealed.
                const maxScroll = scrollBody.scrollHeight - scrollBody.clientHeight;
                if (maxScroll < 80) {
                    if (glass.classList.contains('header-collapsed')) {
                        glass.classList.remove('header-collapsed');
                        toggleCooldownUntil = Date.now() + 250;
                    }
                    lastScrollY = y;
                    return;
                }

                const isCollapsed = glass.classList.contains('header-collapsed');
                const topZone = isCollapsed
                    ? (isBrowse ? 12 : 2)
                    : (isBrowse ? 20 : 10);
                const upDelta = isBrowse ? -3 : -4;

                let changed = false;
                if (y <= topZone) {
                    if (isCollapsed) { glass.classList.remove('header-collapsed'); changed = true; }
                } else if (y > lastScrollY + 2) {
                    if (!isCollapsed) { collapsedAt = Date.now(); glass.classList.add('header-collapsed'); changed = true; }
                } else if (y < lastScrollY + upDelta && Date.now() - collapsedAt > 300) {
                    if (isCollapsed) { glass.classList.remove('header-collapsed'); changed = true; }
                }
                lastScrollY = y;
                if (changed) toggleCooldownUntil = Date.now() + 250;
            }

            function attach() {
                if (attached) return;
                scrollBody = getScrollBody();
                if (!scrollBody) return;
                lastScrollY = scrollBody.scrollTop;
                scrollBody.addEventListener('scroll', handleScroll, { passive: true });
                attached = true;
            }

            function detach() {
                if (!attached) return;
                if (scrollBody) {
                    scrollBody.removeEventListener('scroll', handleScroll);
                    scrollBody.classList.remove('snap-active');
                }
                glass.classList.remove('header-collapsed');
                lastScrollY = 0;
                attached = false;
                scrollBody = null;
            }

            if (resetSelector) {
                overlay.addEventListener('click', (e) => {
                    if (e.target.closest(resetSelector)) {
                        setTimeout(() => {
                            glass.classList.remove('header-collapsed');
                            if (scrollBody) scrollBody.scrollTop = 0;
                            lastScrollY = 0;
                        }, 20);
                    }
                });
            }

            overlay.addEventListener('click', (e) => {
                if (e.target.closest('.browse-section-inline-toggle, .browse-section-title, .expandable-section-title')) {
                    toggleCooldownUntil = Date.now() + 400;
                    setTimeout(() => {
                        if (!scrollBody) return;
                        const maxScroll = scrollBody.scrollHeight - scrollBody.clientHeight;
                        if (maxScroll < 80) {
                            glass.classList.remove('header-collapsed');
                            lastScrollY = scrollBody.scrollTop;
                        }
                    }, 420);
                }
            }, true);

            new MutationObserver(() => {
                const isOpen = !overlay.classList.contains('hidden');
                if (isOpen) attach();
                else detach();
            }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
            // Already-open modal on a desktop->mobile cross: attach now, no mutation will fire
            if (!overlay.classList.contains('hidden')) attach();
        }

        // charModal (local character details)
        const charModal = document.getElementById('charModal');
        if (charModal) {
            const glass = charModal.querySelector('.modal-glass');
            if (glass) wireOverlay(charModal, glass, () => charModal.querySelector('.modal-body'), '.tab-btn');
        }

        // Browse preview modals (injected lazily by providers)
        function scanBrowseModals() {
            document.querySelectorAll('.modal-overlay').forEach(overlay => {
                const glass = overlay.querySelector('.browse-char-modal');
                if (glass) wireOverlay(overlay, glass, () => glass.querySelector('.browse-char-body'));
            });
        }
        scanBrowseModals();
        new MutationObserver(scanBrowseModals).observe(document.body, { childList: true });
    }

    /* ========================================
       MODAL AVATAR IN HEADER
       ======================================== */
    function setupModalAvatar() {
        const modal = document.getElementById('charModal');
        if (!modal) return;

        // the picture is the details' own state (window.syncModalHeaderAvatar); this only places it
        const injectAvatar = () => {
            if (modal.classList.contains('hidden')) return;

            const header = modal.querySelector('.modal-header');
            if (!header) return;

            if (header.querySelector('.mobile-header-avatar')) {
                window.syncModalHeaderAvatar?.();
                return;
            }

            const avatar = document.createElement('img');
            avatar.className = 'mobile-header-avatar';
            avatar.alt = 'Avatar';
            avatar.addEventListener('click', (e) => {
                e.stopPropagation();
                // When edit lock is unlocked, tapping the avatar opens the
                // file picker (matches the desktop hover-overlay behavior).
                if (modal.classList.contains('editing-unlocked')) {
                    const fileInput = document.getElementById('editAvatarFileInput');
                    if (fileInput) {
                        fileInput.click();
                        return;
                    }
                }
                // View mode: open the gallery viewer with the avatar + gallery images, same helper the desktop hover overlay uses.
                const char = window.getActiveChar?.();
                if (char) window.openAvatarInGalleryViewer?.(char);
            });
            header.insertBefore(avatar, header.firstChild);
            window.syncModalHeaderAvatar?.();
        };

        new MutationObserver(injectAvatar).observe(modal, { attributes: true, attributeFilter: ['class'] });
        // The modal can already be open when crossing into mobile; no class mutation will fire then
        injectAvatar();

        // Browse-view avatar tap → full-size image viewer (delegated because
        // modal elements are injected lazily when the Online tab first activates)
        document.addEventListener('click', (e) => {
            const target = e.target.closest('.browse-char-avatar');
            if (!target || !target.src) return;

            const tap = Object.values(PROVIDER_MANIFEST)
                .map(p => p.avatarTap).find(t => t && t.imgId === target.id);
            if (!tap) return;
            if (tap.placeholderGuard !== false && target.src.endsWith('/img/no-portrait.png')) return;
            e.stopPropagation();
            if (tap.swap) openAvatarViewer(target.src.replace(tap.swap[0], tap.swap[1]), target.src);
            // data-full carries the stashed full-size url (eg. botbooru's card PNG)
            else if (tap.dataFull) openAvatarViewer(target.dataset.full || target.src, target.src);
            else openAvatarViewer(target.src);
        });
    }

    /* ========================================
       AVATAR QUICK-VIEW OVERLAY
       ======================================== */
    function openAvatarViewer(src, fallbackSrc) {
        if (!src) return;
        const existing = document.querySelector('.mobile-avatar-viewer');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'mobile-avatar-viewer';

        // Same spinner contract as the desktop viewer; reveal delay keeps fast opens flash-free
        const spinner = document.createElement('div');
        spinner.className = 'mobile-av-spinner';
        spinner.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

        const img = document.createElement('img');
        img.alt = 'Avatar';
        img.onload = () => spinner.remove();
        img.onerror = () => { img.onerror = null; spinner.remove(); if (fallbackSrc) img.src = fallbackSrc; };
        img.src = src;

        overlay.appendChild(spinner);
        overlay.appendChild(img);
        overlay.addEventListener('click', () => closeAvatarViewer());
        document.body.appendChild(overlay);
        // Guard is pushed automatically by childObserver detecting the added element
    }

    function closeAvatarViewer() {
        const viewer = document.querySelector('.mobile-avatar-viewer');
        if (viewer) viewer.remove();
    }

    /* ========================================
       TITLE SCROLL-REVEAL
       ======================================== */
    function setupTitleScrollReveal() {
        function wireTitle(titleEl, overlayEl, glassEl) {
            let _anim = null;

            function unwrap() {
                const inner = titleEl.querySelector('.title-scroll-inner');
                if (inner) titleEl.textContent = inner.textContent;
            }

            function cancel() {
                if (!_anim) return;
                if (_anim.animation) _anim.animation.cancel();
                clearTimeout(_anim.timeout);
                _anim = null;
                unwrap();
                titleEl.classList.remove('title-scrolling', 'title-scroll-start', 'title-scroll-end');
            }

            // The compositor drives the pan: a transform stepped from the phone's busy main thread
            // stutters on every late frame.
            function animate(inner, from, to, duration, easing) {
                const a = inner.animate(
                    [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
                    { duration, easing, fill: 'forwards' }
                );
                _anim.animation = a;
                return a.finished.catch(() => { /* a cancelled pan rejects; callers only wait for its end */ });
            }

            titleEl.addEventListener('click', async () => {
                if (_anim) { cancel(); return; }

                const distance = titleEl.scrollWidth - titleEl.clientWidth;
                if (distance <= 0) return;

                const inner = document.createElement('span');
                inner.className = 'title-scroll-inner';
                inner.textContent = titleEl.textContent;
                titleEl.textContent = '';
                titleEl.appendChild(inner);

                const speed = 75;
                const fwdMs = Math.max(600, (distance / speed) * 1000);
                const retMs = Math.max(400, fwdMs * 0.6);

                _anim = { animation: null, timeout: 0 };
                titleEl.classList.add('title-scrolling', 'title-scroll-start');

                await animate(inner, 0, -distance, fwdMs, 'cubic-bezier(0.25, 0.1, 0.25, 1)');
                if (!_anim) return;

                titleEl.classList.remove('title-scroll-start');
                titleEl.classList.add('title-scroll-end');

                await new Promise(r => { _anim.timeout = setTimeout(r, 1400); });
                if (!_anim) return;

                titleEl.classList.remove('title-scroll-end');

                await animate(inner, -distance, 0, retMs, 'cubic-bezier(0.4, 0, 0.2, 1)');
                if (_anim) {
                    _anim = null;
                    unwrap();
                    titleEl.classList.remove('title-scrolling');
                }
            });

            if (overlayEl) {
                new MutationObserver(() => {
                    if (overlayEl.classList.contains('hidden')) cancel();
                }).observe(overlayEl, { attributes: true, attributeFilter: ['class'] });
            }

            if (glassEl) {
                new MutationObserver(() => {
                    if (glassEl.classList.contains('header-collapsed')) cancel();
                }).observe(glassEl, { attributes: true, attributeFilter: ['class'] });
            }
        }

        // charModal
        const charModal = document.getElementById('charModal');
        const modalTitle = document.getElementById('modalTitle');
        if (charModal && modalTitle) {
            wireTitle(modalTitle, charModal, charModal.querySelector('.modal-glass'));
        }

        // Browse preview modals (lazy discovery)
        const wiredTitles = new WeakSet();
        function scanBrowseTitles() {
            document.querySelectorAll('.modal-overlay').forEach(overlay => {
                const glass = overlay.querySelector('.browse-char-modal');
                if (!glass) return;
                const h2 = glass.querySelector('.browse-char-header-info h2');
                if (!h2 || wiredTitles.has(h2)) return;
                wiredTitles.add(h2);
                wireTitle(h2, overlay, glass);
            });
        }
        scanBrowseTitles();
        new MutationObserver(scanBrowseTitles).observe(document.body, { childList: true });
    }

    /* ========================================
       CHARACTER DETAILS TAB SWIPE
       ======================================== */
    function setupTabSwipe() {
        const modal = document.getElementById('charModal');
        if (!modal) return;

        const tabContainer = modal.querySelector('.modal-content-tabs');
        if (!tabContainer) return;

        let startX = 0, startY = 0, tracking = false, swiping = false;
        const SWIPE_THRESHOLD = 50, LOCK_THRESHOLD = 10;

        function getVisibleTabs() {
            return [...modal.querySelectorAll('.tab-btn')].filter(b => !b.classList.contains('hidden'));
        }

        function isInteractiveTarget(el) {
            const tag = el.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
                // Allow swipe over locked/readonly fields
                if (el.readOnly || el.disabled || el.classList.contains('locked')) return false;
                return true;
            }
            return false;
        }

        tabContainer.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            if (isInteractiveTarget(e.target)) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            tracking = true;
            swiping = false;
        }, { passive: true });

        tabContainer.addEventListener('touchmove', (e) => {
            if (!tracking || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            if (!swiping && Math.abs(dx) > LOCK_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
                swiping = true;
            }
            if (swiping) e.preventDefault();
        }, { passive: false });

        tabContainer.addEventListener('touchend', (e) => {
            if (!tracking) return;
            tracking = false;
            if (!swiping) return;
            const dx = (e.changedTouches[0]?.clientX || 0) - startX;
            if (Math.abs(dx) < SWIPE_THRESHOLD) return;

            const tabs = getVisibleTabs();
            const activeIdx = tabs.findIndex(b => b.classList.contains('active'));
            if (activeIdx === -1) return;

            const nextIdx = dx < 0 ? activeIdx + 1 : activeIdx - 1;
            if (nextIdx >= 0 && nextIdx < tabs.length) {
                tabs[nextIdx].click();

                const paneId = 'pane-' + tabs[nextIdx].dataset.tab;
                const pane = document.getElementById(paneId);
                if (pane) {
                    const cls = dx < 0 ? 'slide-from-right' : 'slide-from-left';
                    pane.classList.remove('slide-from-right', 'slide-from-left');
                    void pane.offsetWidth;
                    pane.classList.add(cls);
                    pane.addEventListener('animationend', () => pane.classList.remove(cls), { once: true });
                }
            }
        }, { passive: true });

        // iOS multitasking gesture / incoming call cancels touches without firing touchend.
        tabContainer.addEventListener('touchcancel', () => {
            tracking = false;
            swiping = false;
        }, { passive: true });
    }

    /* ========================================
       CHAR DETAIL MODAL: PREV/NEXT SWIPE
       Bound to .modal-header only so it doesnt collide with .modal-content-tabs's tab swipe.
       ======================================== */
    function setupCharModalNavSwipe() {
        const modal = document.getElementById('charModal');
        if (!modal) return;
        const header = modal.querySelector('.modal-header');
        if (!header) return;

        let startX = 0, startY = 0, tracking = false, swiping = false;
        const SWIPE_THRESHOLD = 50, LOCK_THRESHOLD = 10;

        function isInteractive(el) {
            return !!(el && el.closest && el.closest('button, input, textarea, select, a, .cl-btn, .close-btn'));
        }

        header.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            if (isInteractive(e.target)) return;
            if (window.getSetting?.('enableCharDetailNav') === false) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            tracking = true;
            swiping = false;
        }, { passive: true });

        header.addEventListener('touchmove', (e) => {
            if (!tracking || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            if (!swiping && Math.abs(dx) > LOCK_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
                swiping = true;
            }
            if (swiping) e.preventDefault();
        }, { passive: false });

        header.addEventListener('touchend', (e) => {
            if (!tracking) return;
            tracking = false;
            if (!swiping) return;
            const dx = (e.changedTouches[0]?.clientX || 0) - startX;
            if (Math.abs(dx) < SWIPE_THRESHOLD) return;
            // Swipe-left goes to NEXT, swipe-right goes to PREVIOUS (standard pager convention).
            window.navigateModal?.(dx < 0 ? 1 : -1);
        }, { passive: true });

        // iOS multitasking gesture / incoming call cancels touches without firing touchend.
        header.addEventListener('touchcancel', () => {
            tracking = false;
            swiping = false;
        }, { passive: true });
    }

    /* ========================================
       ALT GREETINGS SWIPE NAVIGATION
       ======================================== */
    function setupGreetingsSwipe() {
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.id === 'altGreetingsFullscreenModal') {
                        attachGreetingsSwipe(node);
                        return;
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true });
    }

    function attachGreetingsSwipe(modal) {
        const body = modal.querySelector('.content-fullscreen-body');
        if (!body) return;

        let startX = 0, startY = 0, tracking = false, swiping = false;
        const SWIPE_THRESHOLD = 50, LOCK_THRESHOLD = 10;

        body.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            tracking = true;
            swiping = false;
        }, { passive: true });

        body.addEventListener('touchmove', (e) => {
            if (!tracking || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            if (!swiping && Math.abs(dx) > LOCK_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
                swiping = true;
            }
            if (swiping) e.preventDefault();
        }, { passive: false });

        body.addEventListener('touchend', (e) => {
            if (!tracking) return;
            tracking = false;
            if (!swiping) return;
            const dx = (e.changedTouches[0]?.clientX || 0) - startX;
            if (Math.abs(dx) < SWIPE_THRESHOLD) return;

            const nav = modal.querySelector('#greetingNav');
            if (!nav) return;
            const btns = [...nav.querySelectorAll('.greeting-nav-btn')];
            const activeIdx = btns.findIndex(b => b.classList.contains('active'));
            const nextIdx = dx < 0 ? activeIdx + 1 : activeIdx - 1;
            if (nextIdx >= 0 && nextIdx < btns.length) {
                btns[nextIdx].click();
            }
        }, { passive: true });

        // iOS may cancel touches mid-swipe (system gestures, calls); reset state.
        body.addEventListener('touchcancel', () => {
            tracking = false;
            swiping = false;
        }, { passive: true });
    }

    /* ========================================
       GALLERY SWIPE NAVIGATION
       ======================================== */
    function setupGallerySwipe() {
        // Scan-then-observe: #galleryViewerContent is injected once and never re-added, so a re-cross
        // must wire an already-present viewer immediately, then watch for future injections.
        const scan = () => {
            const content = document.getElementById('galleryViewerContent');
            if (content && !content.dataset.swipeInit) {
                content.dataset.swipeInit = 'true';
                attachSwipeHandlers(content);
            }
        };
        scan();
        new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    }

    function attachSwipeHandlers(container) {
        let startX = 0, startY = 0, currentX = 0;
        let tracking = false, swiping = false;
        const SWIPE_THRESHOLD = 40, LOCK_THRESHOLD = 8;

        // Double-tap state
        let lastTapTime = 0;
        let lastTapX = 0, lastTapY = 0;
        const DOUBLE_TAP_DELAY = 300;
        const DOUBLE_TAP_DIST = 40;

        // Pan state (when zoomed)
        let panX = 0, panY = 0, panStartX = 0, panStartY = 0;
        let imgPanStartX = 0, imgPanStartY = 0;
        let isPanning = false;

        // Track whether a meaningful gesture occurred (to distinguish tap from drag)
        let gestureOccurred = false;

        // Block the desktop viewer's half-tap prev/next click on the image so pinch and double-tap work.
        const viewerImg = document.getElementById('galleryViewerImage');
        if (viewerImg) {
            viewerImg.addEventListener('click', (e) => {
                e.stopImmediatePropagation();
                e.preventDefault();
            }, true);
        }
        // Also suppress clicks on the content area that would close the viewer
        // when the user is just finishing a touch gesture
        let recentTouch = false;
        container.addEventListener('click', (e) => {
            if (recentTouch) {
                e.stopImmediatePropagation();
                e.preventDefault();
            }
        }, true);

        const getImageEl = () => container.querySelector('.gv-image, .gv-video');

        function getZoom() {
            const img = getImageEl();
            if (!img) return 1;
            const m = img.style.transform.match(/scale\(([\d.]+)\)/);
            return m ? parseFloat(m[1]) : 1;
        }

        function setTransform(img, scale, tx, ty) {
            const s = Math.round(scale * 100) / 100;
            img.style.transform = `scale(${s}) translate(${tx}px, ${ty}px)`;
            panX = tx;
            panY = ty;
        }

        function resetTransform(img) {
            img.style.transition = 'transform 0.25s ease-out';
            setTransform(img, 1, 0, 0);
            setTimeout(() => { img.style.transition = ''; }, 260);
        }

        function showZoom(scale) {
            const ind = document.getElementById('galleryViewerZoomIndicator');
            if (ind) {
                ind.textContent = Math.round(scale * 100) + '%';
                ind.classList.add('visible');
                clearTimeout(ind._hideTimer);
                ind._hideTimer = setTimeout(() => ind.classList.remove('visible'), 1000);
            }
        }

        container.addEventListener('touchstart', (e) => {
            recentTouch = true;
            const img = getImageEl();
            if (!img) return;
            img.style.transition = 'none';

            const imageContainer = container.querySelector('.gv-image-container');
            if (imageContainer) {
                imageContainer.style.transition = 'none';
                imageContainer.style.transform = '';
                imageContainer.style.opacity = '';
            }

            if (e.touches.length !== 1) return;

            gestureOccurred = false; // reset - will be set true if finger moves

            const tapX = e.touches[0].clientX;
            const tapY = e.touches[0].clientY;

            const curZoom = getZoom();
            if (curZoom > 1.05) {
                isPanning = true;
                panStartX = tapX;
                panStartY = tapY;
                imgPanStartX = panX;
                imgPanStartY = panY;
            } else {
                // Double-tap detection (only at 1x zoom)
                const now = Date.now();
                const dt = now - lastTapTime;
                const dd = Math.sqrt((tapX - lastTapX) ** 2 + (tapY - lastTapY) ** 2);

                if (dt < DOUBLE_TAP_DELAY && dd < DOUBLE_TAP_DIST) {
                    e.preventDefault();
                    lastTapTime = 0;
                    gestureOccurred = true;
                    img.style.transition = 'transform 0.25s ease-out';
                    setTransform(img, 2.5, 0, 0);
                    showZoom(2.5);
                    setTimeout(() => { img.style.transition = ''; }, 260);
                    return;
                }
                lastTapTime = now;
                lastTapX = tapX;
                lastTapY = tapY;

                startX = tapX;
                startY = tapY;
                currentX = 0;
                tracking = true;
                swiping = false;
            }
        }, { passive: false });

        container.addEventListener('touchmove', (e) => {
            const img = getImageEl();
            if (!img) return;

            if (isPanning) {
                const moveThreshold = 5;
                const dx = e.touches[0].clientX - panStartX;
                const dy = e.touches[0].clientY - panStartY;
                if (Math.abs(dx) > moveThreshold || Math.abs(dy) > moveThreshold) {
                    gestureOccurred = true;
                }
                e.preventDefault();
                const curZoom = getZoom();
                setTransform(img, curZoom, imgPanStartX + dx / Math.sqrt(curZoom), imgPanStartY + dy / Math.sqrt(curZoom));
                return;
            }

            if (!tracking) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            const absDx = Math.abs(dx), absDy = Math.abs(dy);

            if (!swiping && absDx < LOCK_THRESHOLD && absDy < LOCK_THRESHOLD) return;
            if (!swiping) {
                swiping = absDx > absDy;
                if (!swiping) { tracking = false; return; }
            }
            e.preventDefault();
            currentX = dx;

            const imageContainer = container.querySelector('.gv-image-container');
            if (imageContainer) {
                imageContainer.style.transition = 'none';
                imageContainer.style.transform = `translateX(${dx}px)`;
                imageContainer.style.opacity = Math.max(0.6, 1 - Math.abs(dx) / 400);
            }
        }, { passive: false });

        container.addEventListener('touchend', (e) => {
            const img = getImageEl();

            // Pan end - single tap while zoomed resets to 1x
            if (isPanning) {
                isPanning = false;
                if (!gestureOccurred && img && getZoom() > 1.05) {
                    resetTransform(img);
                    showZoom(1);
                }
                return;
            }

            if (!tracking) return;
            tracking = false;

            const prevBtn = document.getElementById('galleryViewerPrev');
            const nextBtn = document.getElementById('galleryViewerNext');
            const imageContainer = container.querySelector('.gv-image-container');

            if (swiping && Math.abs(currentX) >= SWIPE_THRESHOLD) {
                const dir = currentX < 0 ? -1 : 1;

                if (imageContainer) {
                    imageContainer.style.transition = 'transform 0.15s ease-in, opacity 0.15s ease-in';
                    imageContainer.style.transform = `translateX(${dir * 120}px)`;
                    imageContainer.style.opacity = '0';
                }

                setTimeout(() => {
                    recentTouch = false;
                    if (currentX < 0 && nextBtn) nextBtn.click();
                    else if (currentX > 0 && prevBtn) prevBtn.click();

                    if (imageContainer) {
                        imageContainer.style.transition = 'none';
                        imageContainer.style.transform = `translateX(${-dir * 80}px)`;
                        imageContainer.style.opacity = '1';
                        requestAnimationFrame(() => {
                            imageContainer.style.transition = 'transform 0.15s ease-out';
                            imageContainer.style.transform = 'translateX(0)';
                        });
                    }
                }, 150);
            } else {
                if (imageContainer) {
                    imageContainer.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
                    imageContainer.style.transform = 'translateX(0)';
                    imageContainer.style.opacity = '1';
                }
            }
            swiping = false;
            // Clear recentTouch after the browser fires its synthetic click
            setTimeout(() => { recentTouch = false; }, 400);
        }, { passive: true });

        // Snap back + reset on iOS system-canceled touches so the image isnt
        // left mid-drag with stale tracking flags.
        container.addEventListener('touchcancel', () => {
            const imageContainer = container.querySelector('.gv-image-container');
            if (imageContainer) {
                imageContainer.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
                imageContainer.style.transform = 'translateX(0)';
                imageContainer.style.opacity = '1';
            }
            tracking = false;
            swiping = false;
            isPanning = false;
            recentTouch = false;
        }, { passive: true });
    }

    /* ========================================
       VIEW SWIPE NAVIGATION
       Swipe left/right on main content to switch
       between Characters ↔ Chats ↔ Online views
       ======================================== */
    function setupViewSwipe() {
        const surface = document.querySelector('.gallery-content');
        if (!surface) return;

        const VIEW_ORDER = FIRST_PARTY_VIEWS;
        const SWIPE_THRESHOLD = 45;
        const VELOCITY_THRESHOLD = 0.4;
        const VELOCITY_MIN_DX = 25;
        const MAX_VERTICAL = 60;
        const DRAG_FACTOR = 0.12;
        const DRAG_OPACITY_MIN = 0.85;
        let startX = 0, startY = 0, startScroll = 0, startTime = 0;
        let active = false, dragging = false, locked = false, transitioning = false;

        function hasBlockingUI() {
            return !!(
                // Initial character fetch not done; same gate as view-toggle.
                document.documentElement.classList.contains('cl-initial-loading') ||
                // An open conversation owns its horizontal gestures; a side swipe there
                // must never yank the whole app to another view.
                document.documentElement.classList.contains('cl-chat-open') ||
                document.querySelector(OPEN_OVERLAY_SEL) ||
                document.querySelector('.mobile-avatar-viewer') ||
                document.querySelector('.browse-avatar-viewer') ||
                document.querySelector('.mobile-search-overlay:not(.hidden)') ||
                document.querySelector('.mobile-sheet-overlay:not(.hidden)') ||
                document.querySelector('.tag-editor-sheet:not(.hidden)') ||
                openTopbarDropdown() ||
                document.querySelector('.custom-select-menu:not(.hidden)') ||
                document.querySelector('#galleryViewerModal.visible') ||
                document.querySelector('body > .dropdown-menu[data-mobile-relocated]:not(.hidden)') ||
                window.MultiSelect?.enabled
            );
        }

        function canSwipeDirection(dx) {
            const current = window.getCurrentView?.() || 'characters';
            const idx = VIEW_ORDER.indexOf(current);
            if (idx === -1) return false;
            return dx < 0 ? idx < VIEW_ORDER.length - 1 : idx > 0;
        }

        function clearDrag() {
            surface.style.transform = '';
            surface.style.opacity = '';
            surface.style.willChange = '';
            dragging = false;
        }

        surface.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) { active = false; return; }
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            startScroll = surface.scrollTop;
            startTime = Date.now();
            // Blocked at the start, not only at commit, or the drag pans the frame over a chat or modal
            // and snaps back.
            active = !transitioning && !hasBlockingUI();
            dragging = false;
            locked = false;
        }, { passive: true });

        surface.addEventListener('touchmove', (e) => {
            if (!active || locked || e.touches.length !== 1) return;
            if (activeCardSwipe) {
                // Per-card swipe owns horizontal intent on this touch.
                locked = true;
                if (dragging) clearDrag();
                return;
            }
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);

            if (!dragging && absDx < 10 && absDy < 10) return;

            // Lock to vertical if scroll-dominant
            if (!dragging && absDy > absDx) { locked = true; return; }

            if (!canSwipeDirection(dx)) { clearDrag(); return; }

            dragging = true;
            if (!surface.style.willChange) surface.style.willChange = 'transform, opacity';
            const shift = dx * DRAG_FACTOR;
            const opacity = Math.max(DRAG_OPACITY_MIN, 1 - (absDx * 0.0008));
            surface.style.transform = `translateX(${shift}px)`;
            surface.style.opacity = opacity;
        }, { passive: true });

        surface.addEventListener('touchend', (e) => {
            if (!active) return;
            active = false;

            const dx = (e.changedTouches[0]?.clientX ?? 0) - startX;
            const dy = (e.changedTouches[0]?.clientY ?? 0) - startY;
            const scrollDelta = Math.abs(surface.scrollTop - startScroll);
            const elapsed = Math.max(Date.now() - startTime, 1);
            const velocity = Math.abs(dx) / elapsed;

            const absDx = Math.abs(dx);
            const isSwipe = absDx >= SWIPE_THRESHOLD || (velocity >= VELOCITY_THRESHOLD && absDx >= VELOCITY_MIN_DX);
            if (!isSwipe || Math.abs(dy) > MAX_VERTICAL || scrollDelta > 10 || hasBlockingUI()) {
                if (dragging) {
                    surface.style.transition = 'transform 0.15s ease-out, opacity 0.15s ease-out';
                    clearDrag();
                    surface.addEventListener('transitionend', () => { surface.style.transition = ''; }, { once: true });
                }
                return;
            }

            const current = window.getCurrentView?.() || 'characters';
            const idx = VIEW_ORDER.indexOf(current);
            if (idx === -1) { clearDrag(); return; }

            const nextIdx = dx < 0 ? idx + 1 : idx - 1;
            if (nextIdx < 0 || nextIdx >= VIEW_ORDER.length) { clearDrag(); return; }

            // Defer switchView a frame so the slide-back transition starts before its sync cost lands.
            transitioning = true;
            const startShift = dx < 0 ? '5%' : '-5%';
            surface.style.willChange = 'transform, opacity';
            surface.style.transition = 'none';
            surface.style.transform = `translateX(${startShift})`;
            surface.style.opacity = '0.86';
            void surface.offsetWidth;
            surface.style.transition = 'transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s cubic-bezier(0.22, 1, 0.36, 1)';
            surface.style.transform = 'translateX(0)';
            surface.style.opacity = '1';

            requestAnimationFrame(() => {
                window.goToView(VIEW_ORDER[nextIdx]);
            });

            surface.addEventListener('transitionend', () => {
                surface.style.transition = '';
                clearDrag();
                transitioning = false;
            }, { once: true });
        }, { passive: true });

        // Cancelled touches (iOS multitasking gesture, incoming call) skip
        // touchend; snap back so the surface isnt stuck mid-drag.
        surface.addEventListener('touchcancel', () => {
            if (!active) return;
            active = false;
            locked = false;
            if (dragging) {
                surface.style.transition = 'transform 0.15s ease-out, opacity 0.15s ease-out';
                clearDrag();
                surface.addEventListener('transitionend', () => { surface.style.transition = ''; }, { once: true });
            }
        }, { passive: true });
    }

    /* ========================================
       RELOCATE FILTER POPUP -> bottom sheet
       ======================================== */
    function relocatePopupAsSheet(id, opts = {}) {
        const popup = document.getElementById(id);
        if (!popup || popup.dataset.relocated) return;
        popup.dataset.relocated = 'true';
        document.body.appendChild(popup);
        popup.classList.add('mobile-fixed-popup');

        const scrim = document.createElement('div');
        scrim.className = 'mobile-popup-scrim' + (opts.topScrim ? ' is-top' : '');
        scrim.hidden = true;
        document.body.appendChild(scrim);

        const handle = document.createElement('div');
        handle.className = 'mobile-sheet-handle';
        popup.insertBefore(handle, popup.firstChild);

        function close() {
            popup.classList.add('hidden');
            scrim.hidden = true;
        }
        scrim.addEventListener('click', close);
        popup._closeFn = close;   // drag-to-dismiss + scrim tap both route here

        const obs = new MutationObserver(() => {
            scrim.hidden = popup.classList.contains('hidden');
        });
        obs.observe(popup, { attributes: true, attributeFilter: ['class'] });
    }

    function relocateTagPopup() { relocatePopupAsSheet('tagFilterPopup'); }
    function relocatePlaylistPopup() { relocatePopupAsSheet('playlistFilterPopup'); }
    function relocateAdvFilterPanel() { relocatePopupAsSheet('advFilterPanel', { topScrim: true }); }

    /* ========================================
       MULTI-SELECT CONFIRM SHEETS
       ======================================== */
    function setupMultiSelectConfirm() {
        const btnConfigs = {
            multiSelectFavToggleBtn: {
                // the selection bar's own star: a Select All's from the server's count, a picked one off its rows
                getTitle: () => (window.MultiSelect?.allFavorited?.() ? 'Remove from Favorites' : 'Add to Favorites'),
                getDesc: () => {
                    const count = window.MultiSelect?.getCount?.() || 0;
                    return `${count.toLocaleString()} character${count !== 1 ? 's' : ''} will be updated`;
                },
                icon: 'fa-solid fa-star',
                confirmLabel: 'Confirm'
            },
            multiSelectExportBtn: {
                getTitle: () => 'Export Characters',
                getDesc: () => {
                    const count = window.MultiSelect?.getCount?.() || 0;
                    return `Export ${count.toLocaleString()} character${count !== 1 ? 's' : ''}: a bundle, card files or provider links`;
                },
                icon: 'fa-solid fa-download',
                confirmLabel: 'Export'
            },
            multiSelectCheckUpdatesBtn: {
                getTitle: () => 'Check for Updates',
                getDesc: () => {
                    const count = window.MultiSelect?.getCount?.() || 0;
                    return `Check ${count.toLocaleString()} character${count !== 1 ? 's' : ''} for provider updates`;
                },
                icon: 'fa-solid fa-arrows-rotate',
                confirmLabel: 'Check'
            },
            multiSelectAllBtn: {
                getTitle: () => 'Select All',
                getDesc: () => {
                    const total = (window.getCurrentCharacters?.() || []).length;
                    return `Select all ${total.toLocaleString()} filtered character${total !== 1 ? 's' : ''}`;
                },
                icon: 'fa-solid fa-check-double',
                confirmLabel: 'Select All'
            },
            multiSelectBatchTagBtn: {
                getTitle: () => 'Batch Tagging',
                getDesc: () => {
                    const count = window.MultiSelect?.getCount?.() || 0;
                    return `Edit tags on ${count.toLocaleString()} selected character${count !== 1 ? 's' : ''}`;
                },
                icon: 'fa-solid fa-tags',
                confirmLabel: 'Open'
            }
        };

        let confirmed = false;

        document.addEventListener('click', (e) => {
            const btn = e.target.closest('#multiSelectFavToggleBtn, #multiSelectExportBtn, #multiSelectCheckUpdatesBtn, #multiSelectAllBtn, #multiSelectBatchTagBtn');
            if (!btn) return;
            const cfg = btnConfigs[btn.id];
            if (!cfg) return;
            if (confirmed) { confirmed = false; return; }
            e.stopImmediatePropagation();
            e.preventDefault();
            showConfirmSheet(cfg, btn);
        }, true);

        function showConfirmSheet(cfg, originalBtn) {
            const { overlay, sheet, close } = createBottomSheet();

            addSheetHandle(sheet);

            const body = document.createElement('div');
            body.className = 'mobile-confirm-body';
            body.innerHTML = `
                <div class="mobile-confirm-icon"><i class="${cfg.icon}"></i></div>
                <div class="mobile-confirm-title">${cfg.getTitle()}</div>
                <div class="mobile-confirm-desc">${cfg.getDesc()}</div>
            `;
            sheet.appendChild(body);

            const actions = document.createElement('div');
            actions.className = 'mobile-confirm-actions';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'mobile-confirm-cancel';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', () => {
                close();
                setTimeout(() => overlay.remove(), 350);
            });

            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'mobile-confirm-ok';
            confirmBtn.textContent = cfg.confirmLabel;
            confirmBtn.addEventListener('click', () => {
                close();
                setTimeout(() => {
                    overlay.remove();
                    confirmed = true;
                    originalBtn.click();
                }, 350);
            });

            actions.appendChild(cancelBtn);
            actions.appendChild(confirmBtn);
            sheet.appendChild(actions);

            document.body.appendChild(overlay);
            openSheet(overlay, sheet);
        }
    }

    /* ========================================
       BROWSE PREVIEW MODAL: KEBAB / QUICK-IMPORT
       ======================================== */
    function setupBrowseModalActionsMenu() {
        // the preview's own controls on the context menu's list (the phone's sheet); a row presses its control
        function openActionsFor(e, controls) {
            const menu = window.ModuleLoader?.get('context-menu');
            if (!menu?.showItems) return;
            const items = [...controls.querySelectorAll('.cl-btn:not(.mobile-more-actions-btn):not(.close-btn)')].map(orig => ({
                icon: [...(orig.querySelector('i')?.classList || [])].filter(k => k.startsWith('fa')).join(' ') || 'fa-solid fa-circle',
                label: (orig.textContent.trim() || orig.title || orig.getAttribute('aria-label') || '').replace(/\s+/g, ' '),
                disabled: orig.disabled || orig.classList.contains('disabled'),
                action: () => orig.click(),
            }));
            // The favorite heart lives in the header meta line, which is hidden on
            // mobile; providers that support favoriting mark it with .browse-fav-toggle
            const favBtn = controls.closest('.browse-char-modal')?.querySelector('.browse-fav-toggle');
            if (favBtn) {
                const faved = favBtn.classList.contains('favorited');
                items.push({ icon: `fa-${faved ? 'solid' : 'regular'} fa-heart`, label: faved ? 'Unfavorite' : 'Favorite', action: () => favBtn.click() });
            }
            if (!items.length) return;
            const r = e.currentTarget.getBoundingClientRect();
            menu.showItems(e, items, { x: r.left, y: r.bottom });
        }

        function findPrimarySourceBtn(controls) {
            const candidates = controls.querySelectorAll('.cl-btn');
            for (const c of candidates) {
                if (/(?:Download|Import|Extract)Btn$/i.test(c.id || '')) return c;
            }
            for (const c of candidates) {
                if (!c.classList.contains('cl-btn-secondary')) return c;
            }
            return null;
        }

        function syncQuickImportState(quickBtn, sourceBtn) {
            if (!sourceBtn) {
                quickBtn.setAttribute('data-state', 'primary');
                quickBtn.innerHTML = '<i class="fa-solid fa-download"></i>';
                quickBtn.disabled = false;
                return;
            }
            let state = 'primary';
            // the classes stampImportButton writes
            if (sourceBtn.classList.contains('cl-btn-warning')) state = 'warning';
            else if (sourceBtn.classList.contains('cl-btn-secondary')) state = 'secondary';
            quickBtn.setAttribute('data-state', state);
            const icon = sourceBtn.querySelector('i');
            if (icon) {
                quickBtn.innerHTML = '';
                const clone = icon.cloneNode(true);
                clone.removeAttribute('style');
                quickBtn.appendChild(clone);
            } else {
                quickBtn.innerHTML = '<i class="fa-solid fa-download"></i>';
            }
            quickBtn.disabled = !!sourceBtn.disabled;
            const title = sourceBtn.title || sourceBtn.textContent.trim();
            if (title) quickBtn.title = title.replace(/\s+/g, ' ');
        }

        function injectKebabIntoModal(modal) {
            const controls = modal.querySelector('.modal-controls');
            if (!controls) return;

            if (!controls.querySelector('.mobile-more-actions-btn')) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'mobile-more-actions-btn';
                btn.setAttribute('aria-label', 'More actions');
                btn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';

                const closeBtn = controls.querySelector('.close-btn');
                if (closeBtn) controls.insertBefore(btn, closeBtn);
                else controls.appendChild(btn);

                btn.addEventListener('click', (e) => openActionsFor(e, controls));
            }

            if (!controls.querySelector('.mobile-quick-import-btn')) {
                const sourceBtn = findPrimarySourceBtn(controls);
                const quickBtn = document.createElement('button');
                quickBtn.type = 'button';
                quickBtn.className = 'mobile-quick-import-btn';
                quickBtn.setAttribute('aria-label', 'Import');
                syncQuickImportState(quickBtn, sourceBtn);

                const closeBtn = controls.querySelector('.close-btn');
                if (closeBtn) controls.insertBefore(quickBtn, closeBtn);
                else controls.appendChild(quickBtn);

                quickBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Re-find each click; providers swap source-btn class on state change (ie. in-library)
                    const src = findPrimarySourceBtn(controls);
                    src?.click();
                });

                if (sourceBtn) {
                    new MutationObserver(() => {
                        const src = findPrimarySourceBtn(controls);
                        syncQuickImportState(quickBtn, src);
                    }).observe(sourceBtn, {
                        attributes: true,
                        attributeFilter: ['class', 'disabled', 'title'],
                        childList: true,
                        subtree: true,
                    });
                }
            }
        }

        // Identity mirror: the meta line is hidden on mobile, so .browse-meta-identity elements mirror
        // into the stats block; taps proxy to the original.
        const mirrorArmed = new WeakSet(); // per-session: re-setup after teardown re-arms

        function syncIdentityMirror(modal) {
            const meta = modal.querySelector('.browse-char-meta');
            const stats = modal.querySelector('.browse-char-stats');
            if (!meta || !stats) return;
            stats.querySelectorAll('.browse-stat-identity').forEach(n => n.remove());
            meta.querySelectorAll('.browse-meta-identity').forEach(src => {
                const name = (src.textContent || '').trim();
                if (!name) return;
                // Providers toggle identity rows through the hidden attribute on a wrapper span
                for (let el = src; el && el !== meta; el = el.parentElement) {
                    if (el.hidden) return;
                }
                const stat = document.createElement('div');
                stat.className = 'browse-stat browse-stat-identity';
                stat.title = src.title || 'Creator';
                const icon = document.createElement('i');
                icon.className = src.dataset.identityIcon || 'fa-solid fa-user-pen';
                const label = document.createElement('span');
                label.textContent = name;
                stat.append(icon, label);
                stat.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    src.click();
                });
                stats.appendChild(stat);
            });
        }

        function armIdentityMirror(modal) {
            if (!modal.querySelector('.browse-meta-identity')) return;
            if (mirrorArmed.has(modal)) return;
            mirrorArmed.add(modal);
            const meta = modal.querySelector('.browse-char-meta');
            if (!meta) return;
            let queued = false;
            const queue = () => {
                if (queued) return;
                queued = true;
                requestAnimationFrame(() => { queued = false; syncIdentityMirror(modal); });
            };
            new MutationObserver(queue).observe(meta, {
                childList: true,
                characterData: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['hidden', 'title'],
            });
            syncIdentityMirror(modal);
        }

        function scan() {
            document.querySelectorAll('.browse-char-modal').forEach(m => {
                injectKebabIntoModal(m);
                armIdentityMirror(m);
            });
        }

        scan();
        new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches?.('.browse-char-modal')) { injectKebabIntoModal(node); armIdentityMirror(node); }
                    node.querySelectorAll?.('.browse-char-modal').forEach(n => { injectKebabIntoModal(n); armIdentityMirror(n); });
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
    }

    /* ========================================
       CONTEXT MENU → BOTTOM SHEET
       ======================================== */
    function setupContextMenu() {
        // Long-press fires 'contextmenu' → module renders its popup; we hijack it into a bottom sheet.

        let ctxSheet = null; // { overlay, sheet, close } from createBottomSheet, reused

        function showCtxSheet(menuEl) {
            if (!ctxSheet) {
                ctxSheet = createBottomSheet({ label: 'Actions' });
                document.body.appendChild(ctxSheet.overlay);
            }
            const { overlay, sheet, close } = ctxSheet;
            sheet.innerHTML = '';

            addSheetHandle(sheet);

            const children = Array.from(menuEl.children);
            const clones = children.map(child => {
                const clone = child.cloneNode(true);
                if (child.classList.contains('cl-context-menu-item') && !child.classList.contains('disabled')) {
                    clone.addEventListener('click', () => { close(); child.click(); });
                }
                clone._origChild = child;
                return clone;
            });

            // Move "Select for Batch" / "Deselect" to right after the header
            const selectIdx = clones.findIndex(c => c._origChild?.querySelector?.('.fa-square-check, .fa-square-minus'));
            if (selectIdx > 1) {
                const [selectClone] = clones.splice(selectIdx, 1);
                if (selectIdx > 0 && clones[selectIdx - 1]?._origChild?.classList?.contains('cl-context-menu-separator')) {
                    clones.splice(selectIdx - 1, 1);
                }
                const sep = document.createElement('div');
                sep.className = 'cl-context-menu-separator';
                clones.splice(1, 0, selectClone, sep);
            }

            clones.forEach(c => { delete c._origChild; sheet.appendChild(c); });

            openSheet(overlay, sheet);
        }

        const waitForMenu = () => {
            const menuEl = document.getElementById('clContextMenu');
            if (!menuEl) {
                const bodyObs = new MutationObserver(() => {
                    const m = document.getElementById('clContextMenu');
                    if (m) { bodyObs.disconnect(); attachObserver(m); }
                });
                bodyObs.observe(document.body, { childList: true });
            } else {
                attachObserver(menuEl);
            }
        };

        function attachObserver(menuEl) {
            const obs = new MutationObserver(() => {
                // Check mode at event time: this observer can outlive a flip to desktop and must no-op there.
                if (!isMobile()) return;
                if (menuEl.classList.contains('visible')) {
                    menuEl.classList.remove('visible');
                    showCtxSheet(menuEl);
                }
            });
            obs.observe(menuEl, { attributes: true, attributeFilter: ['class'] });
        }

        // iOS never fires contextmenu on a press: a still half-second hold synthesizes one and
        // swallows the release's click
        const ROW_SELECTOR = '.chat-card, .chat-hero, .chat-group-item, #spritesGrid .sprite-item, #spritesGrid .audio-item';
        let pressTimer = 0, pressRow = null, pressX = 0, pressY = 0, swallowClickUntil = 0;
        const cancelPress = () => { clearTimeout(pressTimer); pressTimer = 0; pressRow = null; };
        document.addEventListener('touchstart', (e) => {
            const row = e.target.closest(ROW_SELECTOR);
            if (!row || e.touches.length !== 1 || e.target.closest('button, a')) return;
            pressRow = row; pressX = e.touches[0].clientX; pressY = e.touches[0].clientY;
            clearTimeout(pressTimer);
            pressTimer = setTimeout(() => {
                if (!pressRow) return;
                swallowClickUntil = Date.now() + 700;
                window.hapticFeedback?.(12);
                pressRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: pressX, clientY: pressY }));
                pressRow = null;
            }, 500);
        }, { passive: true });
        document.addEventListener('touchmove', (e) => {
            if (!pressRow) return;
            const t = e.touches[0];
            if (Math.abs(t.clientX - pressX) > 10 || Math.abs(t.clientY - pressY) > 10) cancelPress();
        }, { passive: true });
        document.addEventListener('touchend', cancelPress, { passive: true });
        document.addEventListener('touchcancel', cancelPress, { passive: true });
        // the release's click lands wherever the finger was, and once the sheet is up that is its backdrop, not the row
        document.addEventListener('click', (e) => {
            if (Date.now() < swallowClickUntil) { swallowClickUntil = 0; e.stopPropagation(); e.preventDefault(); }
        }, true);

        waitForMenu();
    }

    /* ========================================
       VIEWPORT FIX
       ======================================== */
    function setupViewportFix() {
        const root = document.documentElement;
        let viewport = document.querySelector('meta[name="viewport"]');
        if (!viewport) {
            viewport = document.createElement('meta');
            viewport.name = 'viewport';
            document.head.appendChild(viewport);
        }
        // Capture prior inline styles so teardown lets desktop scroll again. (The viewport meta baseline
        // is captured in runMobile, before fixViewport touches it.)
        if (mobileLive) {
            const prev = {
                rOX: root.style.overflowX, bOX: document.body.style.overflowX,
                rMW: root.style.maxWidth, bMW: document.body.style.maxWidth,
            };
            mobileLive.restore.push(() => {
                root.style.overflowX = prev.rOX; document.body.style.overflowX = prev.bOX;
                root.style.maxWidth = prev.rMW; document.body.style.maxWidth = prev.bMW;
            });
        }
        // Prevent horizontal scrolling + lock scale on mobile
        root.style.overflowX = 'hidden';
        document.body.style.overflowX = 'hidden';
        root.style.maxWidth = '100vw';
        document.body.style.maxWidth = '100vw';
        viewport.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
    }

    /* ========================================
       FIX: CHAT DATES VIA THE CARD'S OWN STAMP
       SmartDate may not stick on all mobile engines, so this reads the raw epoch
       stamp the renderer puts on every chat card (data-last-mes), parses it
       manually and patches the card text.
       ======================================== */
    function fixInvalidDateText() {
        const parseDate = window.__mobileDateParse;
        const fmtDate  = window.__mobileDateFormat;

        function fixCardDate(card) {
            if (card.dataset.dateFixed) return;

            // The relative time lives in .chat-card-time; it is arithmetic for anything under
            // a week and only reaches toLocaleDateString (the engine bug) for older chats.
            const timeEl = card.querySelector('.chat-card-time');
            if (!timeEl) return;
            const text = timeEl.textContent.trim();
            if (text && text.indexOf('Invalid Date') === -1) {
                card.dataset.dateFixed = '1'; // rendered fine
                return;
            }

            const raw = card.dataset.lastMes;
            if (!raw) return;

            const parsed = parseDate(Number(raw));
            if (!parsed) return;

            // Format using our manual formatter (no toLocaleDateString dependency)
            const formatted = fmtDate(parsed);
            if (!formatted) return;

            timeEl.textContent = formatted;
            card.dataset.dateFixed = '1';
        }

        const CARD_SELECTOR = '.chat-card[data-last-mes], .chat-hero[data-last-mes], .chat-group-item[data-last-mes], .chat-item[data-last-mes]';
        function sweep() {
            const cards = document.querySelectorAll(
                '.chat-card[data-last-mes]:not([data-date-fixed]), .chat-hero[data-last-mes]:not([data-date-fixed]), .chat-group-item[data-last-mes]:not([data-date-fixed]), .chat-item[data-last-mes]:not([data-date-fixed])'
            );
            for (let i = 0; i < cards.length; i++) fixCardDate(cards[i]);
        }

        // Also replace raw "Invalid Date" text anywhere (safety net)
        function sweepInvalidText(root) {
            if (!root) return;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                if (node.nodeValue && node.nodeValue.indexOf('Invalid Date') !== -1) {
                    node.nodeValue = node.nodeValue.replace(/Invalid Date/g, 'Unknown');
                }
            }
        }

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) {
                        if (node.matches && node.matches(CARD_SELECTOR)) {
                            fixCardDate(node);
                        } else if (node.querySelectorAll) {
                            const cards = node.querySelectorAll(CARD_SELECTOR);
                            if (cards.length) cards.forEach(fixCardDate);
                        }
                        sweepInvalidText(node);
                    } else if (node.nodeType === 3 && node.nodeValue && node.nodeValue.indexOf('Invalid Date') !== -1) {
                        node.nodeValue = node.nodeValue.replace(/Invalid Date/g, 'Unknown');
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Aggressive sweep: fast for first 10s, then slow
        let sweepCount = 0;
        const live = mobileLive; // register both timers into the session so teardown clears them
        const fastSweep = setInterval(() => {
            sweep();
            if (++sweepCount >= 20) { // 20 × 500ms = 10s
                clearInterval(fastSweep);
                const slow = setInterval(sweep, 3000); // then every 3s
                if (live) live.timers.push(slow);
            }
        }, 500);
        if (live) live.timers.push(fastSweep);
    }

    /* ========================================
       ONLINE FILTER AREA SETUP
       Move dropdowns out of scrollable filter strip
       and manage topbar wrapping class
       ======================================== */
    function setupChubFilterArea() {
        const topbar = document.querySelector('.topbar');
        const onlineFilters = document.getElementById('onlineFilterArea');
        const filterContent = document.getElementById('onlineFilterContent');
        if (!topbar || !onlineFilters || !filterContent) return;

        // Move fixed dropdowns to body so the filter strip's overflow-x doesnt clip them; reruns when
        // a provider switch rebuilds the bar.
        function relocateDropdowns() {
            // a relocated dropdown goes when its origin slot was rebuilt and stays while the slot merely hides
            document.querySelectorAll('body > .browse-tags-dropdown[data-mobile-relocated], body > .browse-features-dropdown[data-mobile-relocated]')
                .forEach(el => { if (!el._mobileOrigin?.isConnected) el.remove(); });

            const dropdowns = filterContent.querySelectorAll('.browse-tags-dropdown, .browse-features-dropdown');
            dropdowns.forEach(dd => {
                dd._mobileOrigin = dd.parentElement;
                dd.setAttribute('data-mobile-relocated', '');
                document.body.appendChild(dd);
            });
        }

        relocateDropdowns();

        // a row greyed in place says why on a tap, as its hover title does on a desktop
        document.addEventListener('click', (e) => {
            const row = e.target.closest?.('[data-mobile-relocated] .browse-option-disabled[title]');
            if (!row?.title) return;
            e.preventDefault();
            e.stopPropagation();
            window.showToast?.(row.title, 'info', 3000, { group: `unavailable:${row.title}` });
        }, true);

        // the rebuild lands inside the kind's slot, a level down, so the watch covers the subtree
        new MutationObserver(() => relocateDropdowns())
            .observe(filterContent, { childList: true, subtree: true });
    }

    /* ========================================
       NOTIFICATIONS SHEET
       The topbar's notifications container is hidden on a phone, so the
       shell's dropdown is hosted inside a bottom sheet of its own: the shell
       still renders the sections (and its empty state), the sheet owns the
       showing, the More button and its row wear a dot while anything runs.
       ======================================== */
    let openNotificationsSheet = null;   // set by setupNotificationsSheet, used by the More sheet's row
    let notifRow = null;                 // the More sheet's Notifications row, for its dot

    function setupNotificationsSheet() {
        const dropdown = document.getElementById('notificationsDropdown');
        if (!dropdown) return;

        const { overlay, sheet } = createBottomSheet();
        addSheetHandle(sheet);
        const title = document.createElement('div');
        title.className = 'mobile-sheet-group-title';
        title.textContent = 'Notifications';
        sheet.appendChild(title);
        // Hosted: the shell never hides a dropdown that sits in a host (refreshNotificationsUI),
        // so an empty list renders its empty state here instead of vanishing.
        sheet.dataset.notifHost = 'sheet';
        sheet.dataset.notifChrome = '';
        sheet.appendChild(dropdown);
        document.body.appendChild(overlay);

        openNotificationsSheet = () => {
            // the shell renders every visible section and the empty state
            window.openNotificationsDropdown();
            openSheet(overlay, sheet);
        };

        // The dot: the shell announces its level on every refresh (and repaints the hosted
        // dropdown itself, so the sheet has no re-render of its own).
        document.addEventListener('cl-notifications-changed', (e) => {
            const level = e.detail?.level || 'none';
            for (const el of [document.getElementById('mobileNavMoreBtn'), notifRow]) {
                if (!el) continue;
                el.classList.toggle('has-notif', level !== 'none');
                el.classList.toggle('has-notif-warning', level === 'warning');
            }
        });
        window.refreshNotificationsUI?.();
    }

    /* ========================================
       REFRESH LOADING SAFETY NET
       Ensures the #loading overlay is hidden once
       the character grid is populated, in case the
       normal hide logic is skipped due to errors.
       ======================================== */
    function fixRefreshLoadingStuck() {
        const loading = document.getElementById('loading');
        const grid = document.getElementById('characterGrid');
        if (!loading || !grid) return;

        new MutationObserver(() => {
            if (grid.children.length > 0 && !loading.hidden) {
                loading.hidden = true;
            }
        }).observe(grid, { childList: true });
    }

    /* ========================================
       LOREBOOK MODAL TOOLBAR REWORK
       Moves collapse-all / expand-all / add-entry buttons
       from the body sub-header into the modal header bar,
       replacing the hidden zoom controls on mobile.
       ======================================== */
    function setupLorebookModalToolbar() {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    const modal = (node.id === 'lorebookExpandModal')
                        ? node
                        : node.querySelector?.('#lorebookExpandModal');
                    if (!modal) continue;

                    const headerControls = modal.querySelector('.modal-header-controls');
                    const actionsDiv = modal.querySelector('.expanded-lorebook-header-actions');
                    if (!headerControls || !actionsDiv) continue;

                    headerControls.appendChild(actionsDiv);
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    /* ========================================
       DEFAULT ZOOM FOR EXPANDED MODALS
       Pure CSS approach: zoom is set in library-mobile.css.
       We only need to update the zoom display label to match.
       No button clicking, no visibility toggling, no flash.
       ======================================== */
    function setDefaultExpandZoom() {
        const zoomDefaults = {
            'greetingsZoomControls': 80,
            'lorebookZoomControls': 80,
            'browseExpandZoomControls': 80,
            'zoomControlBtns': 90
        };

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    for (const [id, defaultZoom] of Object.entries(zoomDefaults)) {
                        const controls = (node.id === id) ? node : node.querySelector?.('#' + id);
                        if (controls) {
                            const label = controls.querySelector('.zoom-level');
                            if (label) label.textContent = `${defaultZoom}%`;
                        }
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true });
    }

    /* ========================================
       PREVENT AUTO-FOCUS ON MODAL / SHEET OPEN
       On mobile, auto-focusing inputs inside modals causes
       the virtual keyboard to pop open immediately which is
       jarring and hides content. We blur any input that gets
       focused inside a modal/sheet within the first 400ms
       after the container becomes visible.
       ======================================== */
    function preventAutoFocusOnOpen() {
        const containerSelectors = [
            '#tagEditorSheet',           // Tag Editor Sheet
            '#greetingsExpandModal',     // Greetings Expand Modal
            '.browse-tags-dropdown'      // Browse tags dropdown
        ];

        // Use focusin (bubbles) on document to catch programmatic .focus() calls
        let suppressUntil = 0;

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type !== 'attributes') continue;
                const target = mutation.target;
                for (const sel of containerSelectors) {
                    if (target.matches?.(sel)) {
                        const wasHidden = mutation.oldValue?.includes('hidden');
                        const isNowVisible = !target.classList.contains('hidden');
                        if (wasHidden && isNowVisible) {
                            suppressUntil = Date.now() + 400;
                        }
                    }
                }
            }
        });

        function observeContainers() {
            for (const sel of containerSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    observer.observe(el, {
                        attributes: true,
                        attributeFilter: ['class'],
                        attributeOldValue: true
                    });
                }
            }
        }

        observeContainers();
        const bodyObserver = new MutationObserver(() => observeContainers());
        bodyObserver.observe(document.body, { childList: true, subtree: true });

        document.addEventListener('focusin', (e) => {
            if (Date.now() > suppressUntil) return;
            const target = e.target;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
                for (const sel of containerSelectors) {
                    if (target.closest(sel)) {
                        target.blur();
                        return;
                    }
                }
            }
        }, true);
    }

    /* ========================================
       MOBILE TAG EDITOR
       Complete slide-up tag editor sheet with inline
       suggestion pills. Injects DOM, wires events,
       and hooks into addTag/removeTag/setEditLock from
       the main library.js.
       ======================================== */
    function setupMobileTagEditor() {

        // Inject editTagsRow into Edit tab
        const versionField = document.getElementById('editVersion');
        const formRowParent = versionField?.closest('.form-row');
        const editSection = formRowParent?.closest('.edit-section');
        if (editSection) {
            const row = document.createElement('div');
            row.className = 'form-group edit-tags-row';
            row.id = 'editTagsRow';
            row.innerHTML = `
                <label><i class="fa-solid fa-tags u-icon-lead"></i>Tags</label>
                <div class="edit-tags-preview" id="editTagsPreview"></div>
                <button type="button" id="editTagsBtn" class="cl-btn cl-btn-secondary cl-btn-sm edit-tags-btn" disabled>
                    <i class="fa-solid fa-pen"></i> Edit Tags
                </button>
            `;
            formRowParent.insertAdjacentElement('afterend', row);
        }

        // Inject Tag Editor Sheet
        const sheet = document.createElement('div');
        sheet.id = 'tagEditorSheet';
        sheet.className = 'tag-editor-sheet hidden';
        sheet.innerHTML = `
            <div class="tag-editor-sheet-backdrop"></div>
            <div class="tag-editor-sheet-panel">
                <div class="tag-editor-sheet-header">
                    <h3><i class="fa-solid fa-tags"></i> Edit Tags</h3>
                    <button type="button" class="close-btn" id="tagEditorSheetClose">&times;</button>
                </div>
                <div class="tag-editor-sheet-body">
                    <div class="tag-editor-sheet-tags" id="tagEditorSheetTags"></div>
                    <div class="tag-editor-sheet-input-row">
                        <input type="search" autocomplete="one-time-code" id="tagEditorSheetInput" class="glass-input tag-input" placeholder="Type a tag and press Enter...">
                        <div id="tagEditorSheetAutocomplete" class="tag-autocomplete hidden tag-editor-sheet-autocomplete"></div>
                    </div>
                </div>
                <div class="tag-editor-sheet-footer">
                    <button type="button" id="tagEditorSheetDone" class="cl-btn cl-btn-primary cl-btn-sm"><i class="fa-solid fa-check"></i> Done</button>
                </div>
            </div>
        `;
        document.body.appendChild(sheet);

        // Local rendering helpers
        function renderEditTagsPreview(tags) {
            const container = document.getElementById('editTagsPreview');
            if (!container) return;
            container.innerHTML = (!tags || tags.length === 0) ? '' :
                tags.map(t => `<span class="modal-tag">${escapeHtml(t)}</span>`).join('');
            // the rows that fit and a "+N" pill, like the desktop sidebar; the sheet edits the full list
            if (tags?.length) clampTagRows(container);
        }

        function renderSheetTags(tags) {
            const container = document.getElementById('tagEditorSheetTags');
            if (!container) return;
            renderEditableTagChips(container, tags || [], (tag) => removeTag(tag));
        }

        // the shared suggestion list as pills; a pick offers the rest at once
        const sheetSuggest = (text) => showTagAutocomplete(text || '', {
            dropdown: document.getElementById('tagEditorSheetAutocomplete'), exclude: getCurrentTagsArray(),
            onPick: (tag) => { addTag(tag); requestAnimationFrame(() => sheetSuggest('')); },
        });

        function hideSheetAutocomplete() {
            const ac = document.getElementById('tagEditorSheetAutocomplete');
            if (ac) ac.classList.remove('visible');
        }

        function openTagEditorSheet() {
            sheet.classList.remove('hidden');
            const tags = getCurrentTagsArray();
            renderSheetTags(tags);
            sheetSuggest('');
        }

        function closeTagEditorSheet() {
            sheet.classList.add('hidden');
            hideSheetAutocomplete();
        }

        // Wire event listeners
        const editTagsBtn = document.getElementById('editTagsBtn');
        if (editTagsBtn) {
            editTagsBtn.addEventListener('click', (e) => {
                e.preventDefault();
                openTagEditorSheet();
            });
        }

        document.getElementById('tagEditorSheetClose')
            ?.addEventListener('click', closeTagEditorSheet);
        document.getElementById('tagEditorSheetDone')
            ?.addEventListener('click', closeTagEditorSheet);
        sheet.querySelector('.tag-editor-sheet-backdrop')
            ?.addEventListener('click', closeTagEditorSheet);

        const sheetInput = document.getElementById('tagEditorSheetInput');
        if (sheetInput) {
            // each keystroke asks the server, so a typing burst asks once
            const askSheet = debounce((text) => sheetSuggest(text), 150);
            sheetInput.addEventListener('input', (e) => askSheet(e.target.value));
            sheetInput.addEventListener('focus', () => sheetSuggest(sheetInput.value));
            sheetInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const v = sheetInput.value.trim();
                    if (v) addTag(v);
                    sheetInput.value = '';
                    requestAnimationFrame(() => sheetSuggest(''));
                } else if (e.key === 'Escape') {
                    hideSheetAutocomplete();
                    sheetInput.blur();
                }
            });

            document.addEventListener('click', (e) => {
                const inputRow = sheet.querySelector('.tag-editor-sheet-input-row');
                if (inputRow && !inputRow.contains(e.target)) {
                    hideSheetAutocomplete();
                }
            });
        }

        // Hook into addTag / removeTag
        // Monkey-patch to also update mobile UI
        const origAddTag = window.addTag;
        if (typeof origAddTag === 'function') {
            window.addTag = function(tag) {
                origAddTag(tag);
                const tags = getCurrentTagsArray();
                renderEditTagsPreview(tags);
                renderSheetTags(tags);
                const si = document.getElementById('tagEditorSheetInput');
                if (si) si.value = '';
            };
        }

        const origRemoveTag = window.removeTag;
        if (typeof origRemoveTag === 'function') {
            window.removeTag = function(tag) {
                origRemoveTag(tag);
                const tags = getCurrentTagsArray();
                renderEditTagsPreview(tags);
                renderSheetTags(tags);
            };
        }

        // Hook into setEditLock
        // Observe the lock status DOM changes to sync the edit-tags button
        const lockObserver = new MutationObserver(() => {
            const btn = document.getElementById('editTagsBtn');
            if (!btn) return;
            const lockStatus = document.getElementById('editLockStatus');
            const isLocked = lockStatus?.textContent?.includes('locked') ||
                             !document.querySelector('.edit-lock-header.unlocked');
            btn.disabled = isLocked;
            const tags = getCurrentTagsArray();
            renderEditTagsPreview(tags);
        });
        const lockHeader = document.querySelector('.edit-lock-header');
        if (lockHeader) {
            lockObserver.observe(lockHeader, { attributes: true, attributeFilter: ['class'] });
        }

        // Sync preview when modal opens
        const modalObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.target.id === 'charModal' && !m.target.classList.contains('hidden')) {
                    const tags = getCurrentTagsArray();
                    renderEditTagsPreview(tags);
                    const btn = document.getElementById('editTagsBtn');
                    if (btn) {
                        const isLocked = !document.querySelector('.edit-lock-header.unlocked');
                        btn.disabled = isLocked;
                    }
                }
            }
        });
        const charModal = document.getElementById('charModal');
        if (charModal) {
            modalObserver.observe(charModal, { attributes: true, attributeFilter: ['class'] });
            // Sync once for a modal already open at cross time (no mutation fires for it)
            if (!charModal.classList.contains('hidden')) {
                const tags = getCurrentTagsArray();
                renderEditTagsPreview(tags);
                const btn = document.getElementById('editTagsBtn');
                if (btn) btn.disabled = !document.querySelector('.edit-lock-header.unlocked');
            }
        }
    }

})();
