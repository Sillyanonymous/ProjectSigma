// SPDX-License-Identifier: MIT

// Σ's field: soft pools of the palette's light drifting slowly behind the app, still under reduced motion.

const TAU = Math.PI * 2;
const rgbaOf = (c, a) => `rgba(${c.r | 0}, ${c.g | 0}, ${c.b | 0}, ${a})`;

// a soft round light, drawn once and stamped wherever a pool drifts
function poolSprite(c, size) {
    const s = document.createElement('canvas');
    s.width = s.height = size;
    const g = s.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, rgbaOf(c, 1));
    grad.addColorStop(0.5, rgbaOf(c, 0.32));
    grad.addColorStop(1, rgbaOf(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return s;
}

// three pools on slow Lissajous paths, near the window's corners where they light the page and not the text
function pools(W, H, c, glow) {
    const size = Math.round(Math.max(W, H) * 1.05);
    const sprites = [poolSprite(c.g1, size), poolSprite(c.g2, size), poolSprite(c.g3, Math.round(size * 0.7))];
    const paths = [
        { x: 0.05, y: -0.1, ax: 0.07, ay: 0.05, fx: 0.011, fy: 0.008, a: 0.5 },
        { x: 1.0, y: 1.08, ax: 0.06, ay: 0.06, fx: 0.009, fy: 0.012, a: 0.5 },
        { x: 0.72, y: 0.12, ax: 0.1, ay: 0.08, fx: 0.007, fy: 0.01, a: 0.25 },
    ];
    const k = 0.3 + 0.7 * glow;
    return {
        draw(g, t) {
            g.globalCompositeOperation = 'lighter';
            paths.forEach((p, i) => {
                const s = sprites[i];
                const x = (p.x + p.ax * Math.sin(t * p.fx * TAU)) * W - s.width / 2;
                const y = (p.y + p.ay * Math.cos(t * p.fy * TAU)) * H - s.height / 2;
                g.globalAlpha = p.a * k;
                g.drawImage(s, x, y);
            });
            g.globalCompositeOperation = 'source-over';
            g.globalAlpha = 1;
        },
    };
}

/**
 * The field, mounted as the body's first child. Answers null where no 2D canvas exists.
 * @param {{ colors: { g1: object, g2: object, g3: object }, glow: number, phone: boolean, still: boolean, speed?: number }} start
 */
export function createField(start) {
    const canvas = document.createElement('canvas');
    const g = canvas.getContext?.('2d');
    if (!g) return null;
    canvas.className = 'sx-field';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(canvas, document.body.firstChild);
    let s = { ...start };
    let layers = [], W = 0, H = 0, raf = 0, last = 0, frames = 0, clock = 0;
    let resizeTimer = 0;
    const fps = () => (s.phone ? 15 : 24);

    const build = () => {
        const dpr = Math.min(s.phone ? 1 : 1.5, globalThis.devicePixelRatio || 1);
        W = Math.max(1, globalThis.innerWidth || 1);
        H = Math.max(1, globalThis.innerHeight || 1);
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        layers = [pools(W, H, s.colors, s.glow)];
    };
    // the field's own clock, so a gentler speed slows it without a jump
    const paint = (dt) => {
        clock += dt;
        g.clearRect(0, 0, W, H);
        for (const l of layers) l.draw(g, clock, dt);
        frames++;
    };
    const tick = (now) => {
        raf = requestAnimationFrame(tick);
        if (now - last < 1000 / fps() - 2) return;
        const dt = last ? Math.min(0.2, (now - last) / 1000) : 0;
        last = now;
        paint(dt * (s.speed ?? 1));
    };
    const hidden = () => document.visibilityState === 'hidden';
    const run = () => {
        if (raf || s.still || hidden()) return;
        last = 0;
        raf = requestAnimationFrame(tick);
    };
    const halt = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
    // still, the field is one frame, painted again only when something it shows changes
    const still = () => { halt(); clock = 20; paint(0); };
    const refresh = () => { build(); if (s.still) still(); else { paint(0); run(); } };
    const onVisibility = () => (hidden() ? halt() : run());
    const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(refresh, 160); };
    document.addEventListener('visibilitychange', onVisibility);
    globalThis.addEventListener('resize', onResize);
    refresh();

    return {
        /** Change what the field shows or how it runs; only the parts named. */
        update(next) {
            s = { ...s, ...next };
            refresh();
        },
        status: () => ({ running: !!raf, still: !!s.still, speed: s.speed ?? 1, frames, fps: fps() }),
        destroy() {
            halt();
            clearTimeout(resizeTimer);
            document.removeEventListener('visibilitychange', onVisibility);
            globalThis.removeEventListener('resize', onResize);
            canvas.remove();
        },
    };
}
