// Midnight's sky: one canvas behind the app, at most 30 frames a second, still under reduced motion,
// stopped while the tab is hidden.

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const rgbaOf = (c, a) => `rgba(${c.r | 0}, ${c.g | 0}, ${c.b | 0}, ${a})`;

// a soft round light, drawn once and stamped wherever a star or an ember glows
function glowSprite(c, size, core = 0.18) {
    const s = document.createElement('canvas');
    s.width = s.height = size;
    const g = s.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, rgbaOf(c, 1));
    grad.addColorStop(core, rgbaOf(c, 0.55));
    grad.addColorStop(1, rgbaOf(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return s;
}

// ---- the scenes: build() once per size and palette, draw() each frame -------------------------------

function starField(W, H, n, c) {
    const tone = (k) => ({ r: 255 + (c.accent.r - 255) * k, g: 255 + (c.accent.g - 255) * k, b: 255 + (c.accent.b - 255) * k });
    const stars = Array.from({ length: n }, () => {
        const layer = Math.random() < 0.62 ? 0 : Math.random() < 0.78 ? 1 : 2;
        return { x: Math.random() * W, y: Math.random() * H, layer, size: [rand(0.6, 1.1), rand(1, 1.7), rand(1.6, 2.6)][layer],
            a: [rand(0.25, 0.6), rand(0.45, 0.8), rand(0.7, 1)][layer], tw: rand(0.4, 1.6), ph: rand(0, TAU) };
    });
    const sprite = glowSprite(tone(0.25), 24, 0.08);
    const speeds = [1.2, 2.8, 5.5];
    return {
        draw(g, t, dt) {
            g.fillStyle = rgbaOf(tone(0.15), 1);
            for (const s of stars) {
                s.x -= speeds[s.layer] * dt;
                if (s.x < -4) s.x += W + 8;
                const a = s.a * (0.62 + 0.38 * Math.sin(t * s.tw + s.ph));
                if (s.layer < 2) {
                    g.globalAlpha = a;
                    g.fillRect(s.x, s.y, s.size, s.size);
                } else {
                    g.globalAlpha = a;
                    const r = s.size * 2.4;
                    g.drawImage(sprite, s.x - r, s.y - r, r * 2, r * 2);
                }
            }
            g.globalAlpha = 1;
        },
    };
}

// a faint band of distant stars and dust across the sky, rendered once and slid slowly
function milkyWay(W, H, c, density) {
    const tex = document.createElement('canvas');
    tex.width = W;
    tex.height = H;
    const g = tex.getContext('2d');
    g.save();
    g.translate(W * 0.5, H * 0.45);
    g.rotate(-0.42);
    const band = g.createLinearGradient(0, -H * 0.35, 0, H * 0.35);
    band.addColorStop(0, rgbaOf(c.accent2, 0));
    band.addColorStop(0.5, rgbaOf(c.accent2, 0.07));
    band.addColorStop(1, rgbaOf(c.accent2, 0));
    g.fillStyle = band;
    g.fillRect(-W, -H * 0.35, W * 2, H * 0.7);
    g.fillStyle = 'rgba(255, 255, 255, 1)';
    const dots = Math.round((W * H) / 2600 * density);
    for (let i = 0; i < dots; i++) {
        const along = rand(-W, W), across = (Math.random() + Math.random() + Math.random() - 1.5) * H * 0.22;
        g.globalAlpha = rand(0.05, 0.28);
        g.fillRect(along, across, 1, 1);
    }
    g.restore();
    return { draw(gg, t) { gg.globalAlpha = 0.9 + 0.1 * Math.sin(t * 0.07); gg.drawImage(tex, 0, 0); gg.globalAlpha = 1; } };
}

function shootingStar(W, H) {
    let next = rand(9, 22), run = null;
    return {
        draw(g, t, dt) {
            if (!run) {
                next -= dt;
                if (next > 0) return;
                const ang = rand(0.35, 0.65);
                run = { x: rand(W * 0.25, W * 0.95), y: rand(-20, H * 0.3), vx: -Math.cos(ang) * 620, vy: Math.sin(ang) * 620, life: 0 };
            }
            run.life += dt;
            run.x += run.vx * dt;
            run.y += run.vy * dt;
            const fade = Math.sin(Math.min(1, run.life / 0.9) * Math.PI);
            const grad = g.createLinearGradient(run.x, run.y, run.x - run.vx * 0.16, run.y - run.vy * 0.16);
            grad.addColorStop(0, `rgba(255, 255, 255, ${0.85 * fade})`);
            grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
            g.strokeStyle = grad;
            g.lineWidth = 1.4;
            g.beginPath();
            g.moveTo(run.x, run.y);
            g.lineTo(run.x - run.vx * 0.16, run.y - run.vy * 0.16);
            g.stroke();
            if (run.life > 0.9) { run = null; next = rand(14, 38); }
        },
    };
}

// aurora curtains: a tileable texture of light columns, slid sideways at two depths and breathing
function auroraCurtains(W, H, c) {
    const TW = Math.max(900, Math.ceil(W / 300) * 300), TH = Math.round(H * 0.62);
    const make = (seed, a, b, lift) => {
        const tex = document.createElement('canvas');
        tex.width = TW;
        tex.height = TH;
        const g = tex.getContext('2d');
        const column = document.createElement('canvas');
        column.width = 1;
        column.height = 128;
        const cg = column.getContext('2d');
        const grad = cg.createLinearGradient(0, 0, 0, 128);
        grad.addColorStop(0, rgbaOf(b, 0));
        grad.addColorStop(0.55, rgbaOf(b, 0.32));
        grad.addColorStop(0.86, rgbaOf(a, 0.6));
        grad.addColorStop(1, rgbaOf(a, 0));
        cg.fillStyle = grad;
        cg.fillRect(0, 0, 1, 128);
        const k = (n) => (TAU * n) / TW;
        for (let x = 0; x < TW; x += 2) {
            const base = TH * (0.55 + lift) + Math.sin(x * k(2) + seed) * TH * 0.08 + Math.sin(x * k(5) + seed * 2) * TH * 0.035;
            const tall = TH * (0.3 + 0.16 * (Math.sin(x * k(3) + seed * 3) + 1) / 2 + 0.08 * Math.sin(x * k(11) + seed));
            g.globalAlpha = 0.55 + 0.45 * Math.max(0, Math.sin(x * k(4) + seed * 1.7));
            g.drawImage(column, x, base - tall, 2, tall);
        }
        return tex;
    };
    const near = make(1.3, c.accent, c.accent2, 0);
    const far = make(4.1, c.accent2, c.accent, -0.12);
    let offA = 0, offB = 0;
    const blit = (g, tex, off, y, alpha) => {
        g.globalAlpha = alpha;
        const x = -(off % TW);
        for (let at = x; at < W; at += TW) g.drawImage(tex, at, y);
    };
    return {
        draw(g, t, dt) {
            offA += dt * 9;
            offB += dt * 4;
            g.globalCompositeOperation = 'lighter';
            blit(g, far, offB, H * 0.02, 0.32 + 0.1 * Math.sin(t * 0.21));
            blit(g, near, offA, H * 0.06, 0.42 + 0.14 * Math.sin(t * 0.17 + 1));
            g.globalCompositeOperation = 'source-over';
            g.globalAlpha = 1;
        },
    };
}

function emberField(W, H, n, c) {
    const sprites = [glowSprite(c.accent, 32, 0.07), glowSprite(c.accent2, 32, 0.07)];
    const spawn = (p, anywhere) => Object.assign(p, {
        x: Math.random() * W, y: anywhere ? Math.random() * H : H + rand(4, 60), vy: -rand(9, 26),
        sway: rand(5, 18), freq: rand(0.25, 0.8), ph: rand(0, TAU), size: rand(0.8, 2.6), kind: Math.random() < 0.55 ? 0 : 1,
    });
    const embers = Array.from({ length: n }, () => spawn({}, true));
    const haze = document.createElement('canvas');
    haze.width = W;
    haze.height = Math.round(H * 0.45);
    const hg = haze.getContext('2d');
    const glow = hg.createRadialGradient(W * 0.5, haze.height * 1.25, 0, W * 0.5, haze.height * 1.25, Math.max(W, H) * 0.75);
    glow.addColorStop(0, rgbaOf(c.accent, 0.16));
    glow.addColorStop(0.5, rgbaOf(c.accent2, 0.05));
    glow.addColorStop(1, rgbaOf(c.accent2, 0));
    hg.fillStyle = glow;
    hg.fillRect(0, 0, W, haze.height);
    return {
        draw(g, t, dt) {
            g.globalAlpha = 0.85 + 0.15 * Math.sin(t * 0.3);
            g.drawImage(haze, 0, H - haze.height);
            g.globalCompositeOperation = 'lighter';
            for (const p of embers) {
                p.y += p.vy * dt;
                if (p.y < -12) spawn(p, false);
                const x = p.x + Math.sin(t * p.freq + p.ph) * p.sway;
                const rise = 1 - p.y / H;
                g.globalAlpha = Math.max(0, Math.min(1, (1 - rise) * 1.4)) * (0.55 + 0.45 * Math.sin(t * 2.2 + p.ph));
                const r = p.size * 3.2;
                g.drawImage(sprites[p.kind], x - r, p.y - r, r * 2, r * 2);
            }
            g.globalCompositeOperation = 'source-over';
            g.globalAlpha = 1;
        },
    };
}

function moonHaze(W, H, c) {
    const R = Math.max(16, Math.min(W, H) * 0.03);
    const moon = document.createElement('canvas');
    moon.width = moon.height = Math.ceil(R * 7);
    const mg = moon.getContext('2d');
    const m = moon.width / 2;
    const halo = mg.createRadialGradient(m, m, R, m, m, m);
    halo.addColorStop(0, rgbaOf(c.text, 0.1));
    halo.addColorStop(0.35, rgbaOf(c.accent2, 0.035));
    halo.addColorStop(1, rgbaOf(c.accent2, 0));
    mg.fillStyle = halo;
    mg.fillRect(0, 0, moon.width, moon.height);
    mg.fillStyle = rgbaOf(c.text, 0.07);
    mg.beginPath();
    mg.arc(m, m, R, 0, TAU);
    mg.fill();
    // the lit crescent on its own layer, so cutting the shadow out spares the earthshine and the halo
    const lit = document.createElement('canvas');
    lit.width = lit.height = moon.width;
    const lg = lit.getContext('2d');
    const face = lg.createRadialGradient(m + R * 0.4, m - R * 0.3, R * 0.1, m, m, R);
    face.addColorStop(0, 'rgba(255, 255, 255, 0.97)');
    face.addColorStop(1, rgbaOf(c.text, 0.86));
    lg.fillStyle = face;
    lg.beginPath();
    lg.arc(m, m, R, 0, TAU);
    lg.fill();
    lg.globalCompositeOperation = 'destination-out';
    lg.beginPath();
    lg.arc(m - R * 0.5, m - R * 0.14, R * 0.96, 0, TAU);
    lg.fill();
    mg.drawImage(lit, 0, 0);
    const fog = Array.from({ length: 3 }, (_, i) => {
        const w = W * rand(0.7, 1.1), h = H * rand(0.18, 0.3);
        const tex = document.createElement('canvas');
        tex.width = Math.ceil(w);
        tex.height = Math.ceil(h);
        const fg = tex.getContext('2d');
        fg.setTransform(1, 0, 0, h / w, 0, 0);
        const blob = fg.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
        blob.addColorStop(0, rgbaOf(c.text, 0.09));
        blob.addColorStop(1, rgbaOf(c.text, 0));
        fg.fillStyle = blob;
        fg.fillRect(0, 0, w, w);
        return { tex, x: rand(-w * 0.3, W), y: H * (0.35 + i * 0.2), v: rand(3, 8) * (i % 2 ? -1 : 1) };
    });
    return {
        draw(g, t, dt) {
            g.drawImage(moon, W * 0.91 - m, H * 0.14 - m);
            for (const f of fog) {
                f.x += f.v * dt;
                const w = f.tex.width;
                if (f.x > W + w * 0.2) f.x = -w;
                if (f.x < -w * 1.2) f.x = W;
                g.globalAlpha = 0.8 + 0.2 * Math.sin(t * 0.13 + f.y);
                g.drawImage(f.tex, f.x, f.y - f.tex.height / 2);
            }
            g.globalAlpha = 1;
        },
    };
}

const SCENES = {
    stars: (W, H, d, c, still) => [milkyWay(W, H, c, d), starField(W, H, Math.round((W * H) / 5200 * d), c), ...(still ? [] : [shootingStar(W, H)])],
    aurora: (W, H, d, c) => [starField(W, H, Math.round((W * H) / 11000 * d), c), auroraCurtains(W, H, c)],
    embers: (W, H, d, c) => [starField(W, H, Math.round((W * H) / 16000 * d), c), emberField(W, H, Math.max(10, Math.round((W * H) / 15000 * d)), c)],
    haze: (W, H, d, c) => [starField(W, H, Math.round((W * H) / 14000 * d), c), moonHaze(W, H, c)],
};

/**
 * The sky, mounted as the body's first child. Answers null where no 2D canvas exists.
 * @param {{ kind: string, colors: object, density: number, phone: boolean, still: boolean, speed?: number, calm?: boolean }} start
 */
export function createSky(start) {
    if (!SCENES[start.kind]) return null;
    const canvas = document.createElement('canvas');
    const g = canvas.getContext?.('2d');
    if (!g) return null;
    canvas.className = 'mn-sky';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(canvas, document.body.firstChild);
    let s = { ...start };
    let layers = [], W = 0, H = 0, raf = 0, last = 0, frames = 0, clock = 0;
    let resizeTimer = 0;
    const fps = () => (s.phone ? 24 : 30);

    const build = () => {
        const dpr = Math.min(s.phone ? 1 : 1.5, globalThis.devicePixelRatio || 1);
        W = Math.max(1, globalThis.innerWidth || 1);
        H = Math.max(1, globalThis.innerHeight || 1);
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        layers = SCENES[s.kind](W, H, s.density, s.colors, s.still || s.calm);
    };
    // the scene's own clock, so a gentler speed slows it without a jump
    const paint = (dt) => {
        clock += dt;
        g.clearRect(0, 0, W, H);
        for (const l of layers) l.draw(g, clock, dt);
        frames++;
    };
    const tick = (now) => {
        raf = requestAnimationFrame(tick);
        if (now - last < 1000 / fps() - 2) return;
        const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
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
    // under reduced motion the sky is one frame, painted again only when something it shows changes
    const still = () => { halt(); clock = 4; paint(0); };
    const refresh = () => { build(); if (s.still) still(); else { paint(0); run(); } };
    const onVisibility = () => (hidden() ? halt() : run());
    const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(refresh, 160); };
    document.addEventListener('visibilitychange', onVisibility);
    globalThis.addEventListener('resize', onResize);
    refresh();

    return {
        /** Change what the sky shows or how it runs; only the parts named. */
        update(next) {
            s = { ...s, ...next };
            refresh();
        },
        status: () => ({ kind: s.kind, running: !!raf, still: !!s.still, speed: s.speed ?? 1, calm: !!s.calm, frames, fps: fps() }),
        destroy() {
            halt();
            clearTimeout(resizeTimer);
            document.removeEventListener('visibilitychange', onVisibility);
            globalThis.removeEventListener('resize', onResize);
            canvas.remove();
        },
    };
}
