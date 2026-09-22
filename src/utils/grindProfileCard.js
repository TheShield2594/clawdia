'use strict';

/**
 * The picture half of `/hunt profile`, `/fish profile` and `/explore profile`.
 *
 * Two cards, shared by all three so the profiles read as one family:
 *
 *   createGrindProfileCard     the overview — avatar, rank, XP bar, where the
 *                              player is, stamina, four headline numbers and a
 *                              shelf of their best finds.
 *   createGrindCollectionCard  the collection — every species / relic the game
 *                              has, grouped, owned ones in full colour and the
 *                              rest as grey ghosts, so the gaps say what to go
 *                              after next.
 *
 * The art is the bundled catalogue (utils/defaultItemImages.js). An id with no
 * baked icon — a species or relic added before the bake action has run for it —
 * is drawn as a coloured medallion with its initials, so a missing PNG costs
 * polish, never the card.
 *
 * The cards are illustrations: every number on them is also in the embed text
 * the command sends alongside (#672), and callers give the attachment alt text.
 * Nothing here may put a currency symbol on the canvas — a guild currency can
 * be a custom Discord emoji, which a canvas cannot draw.
 *
 * @module utils/grindProfileCard
 */

const { createCanvas, loadImage } = require('canvas');
const { ensureFontsRegistered } = require('./registerFonts');
const { encodeCanvas } = require('./canvasEncode');
const { getDefaultItemImage } = require('./defaultItemImages');

ensureFontsRegistered();

const FONT = '"DejaVu Sans"';

/** Per-activity palette. `accent` is the bar, the rules and the headings. */
const THEMES = {
    hunt:    { top: '#15301d', bottom: '#070f09', accent: '#4cc27a', muted: '#9cc7a8', panel: 'rgba(255,255,255,0.06)' },
    fish:    { top: '#0f2944', bottom: '#050d18', accent: '#45a6ec', muted: '#9fc2dd', panel: 'rgba(255,255,255,0.06)' },
    explore: { top: '#33230f', bottom: '#110b04', accent: '#e0a83e', muted: '#d6bf95', panel: 'rgba(255,255,255,0.06)' },
};

/** The avatar ring for each prestige rank; rank 0 uses the activity accent. */
const PRESTIGE_RING = [null, '#cd7f32', '#c0c0c0', '#ffd700', '#e5e4e2', '#7df9ff'];

function themeFor(activity) {
    return THEMES[activity] ?? THEMES.hunt;
}

function prestigeRing(prestige, theme) {
    return PRESTIGE_RING[Math.min(Math.max(0, prestige | 0), PRESTIGE_RING.length - 1)] ?? theme.accent;
}

// ─── Art ─────────────────────────────────────────────────────────────────────

// Decoded icons and their greyed variants, by item id. The catalogue is a few
// hundred small PNGs, so holding the decoded set is cheap, and a collection
// card draws sixty of them — decoding each on every render is the slow part.
const iconCache = new Map();  // id -> Image | null
const ghostCache = new Map(); // `${id}@${size}` -> Canvas

async function loadIcon(id) {
    if (!id) return null;
    if (iconCache.has(id)) return iconCache.get(id);
    const bundled = getDefaultItemImage(id);
    let img = null;
    if (bundled) {
        try { img = await loadImage(bundled.data); } catch { img = null; }
    }
    iconCache.set(id, img);
    return img;
}

/**
 * A greyscale, darkened copy of an icon at a given size: the "not yet" slot.
 * node-canvas has no `ctx.filter`, so this is a pass over the pixels — at icon
 * size that is a few thousand of them, once, and then cached.
 */
function ghostOf(id, img, size) {
    const key = `${id}@${size}`;
    if (ghostCache.has(key)) return ghostCache.get(key);
    const c = createCanvas(size, size);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, size, size);
    const data = g.getImageData(0, 0, size, size);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
        const lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) * 0.45;
        px[i] = px[i + 1] = px[i + 2] = lum;
    }
    g.putImageData(data, 0, 0);
    ghostCache.set(key, c);
    return c;
}

/**
 * Draw one catalogue entry — its icon if one ships, else a stand-in medallion —
 * centred in a `size` square at (x, y). `owned: false` draws the ghost.
 */
async function drawEntry(ctx, entry, x, y, size, theme) {
    const owned = entry.owned !== false;
    const img = await loadIcon(entry.iconId);

    if (img) {
        ctx.save();
        if (owned) {
            ctx.drawImage(img, x, y, size, size);
        } else {
            ctx.globalAlpha = 0.55;
            ctx.drawImage(ghostOf(entry.iconId, img, size), x, y, size, size);
        }
        ctx.restore();
    } else {
        // No baked art: a medallion in the entry's colour with its initials.
        // Not the emoji — node-canvas draws colour emoji as flat white shapes,
        // or not at all, depending on the fonts the host has.
        const cx = x + size / 2, cy = y + size / 2, r = size * 0.44;
        const color = entry.color ?? theme.accent;
        ctx.save();
        ctx.globalAlpha = owned ? 1 : 0.35;
        const fill = ctx.createRadialGradient(cx, cy - r * 0.4, r * 0.1, cx, cy, r);
        fill.addColorStop(0, owned ? shade(color, 0.35) : '#3a3a3a');
        fill.addColorStop(1, owned ? shade(color, -0.55) : '#161616');
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = Math.max(2, size * 0.06);
        ctx.strokeStyle = owned ? color : '#444444';
        ctx.stroke();
        ctx.font = `bold ${Math.round(size * 0.3)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = owned ? '#ffffff' : '#777777';
        ctx.fillText(initials(entry.name), cx, cy + 1);
        ctx.restore();
    }

    // A small badge in the corner: a grade letter for a hunt trophy, a count
    // for a fish caught many times. Only on owned entries.
    if (owned && entry.badge) {
        const br = Math.max(9, size * 0.15);
        const bx = x + size - br * 0.9;
        const by = y + size - br * 0.9;
        ctx.save();
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fillStyle = entry.badgeColor ?? theme.accent;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#0b0b0b';
        ctx.stroke();
        ctx.font = `bold ${Math.round(br * 1.05)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(String(entry.badge), bx, by + 1);
        ctx.restore();
    }
}

// ─── Primitives ──────────────────────────────────────────────────────────────

/** "Whisperwood Charm" -> "WC", "The Tenth Owl" -> "TO"; "?" for no name. */
function initials(name) {
    const words = String(name ?? '').split(/\s+/).filter(w => /^[A-Za-z0-9]/.test(w));
    const meaningful = words.filter(w => !/^(the|of|a|an)$/i.test(w));
    const pick = (meaningful.length ? meaningful : words).slice(0, 2);
    return pick.map(w => w[0].toUpperCase()).join('') || '?';
}

/** Lighten (amount > 0) or darken (amount < 0) a #rrggbb colour. */
function shade(hex, amount) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    if (!Number.isFinite(n)) return hex;
    const ch = v => Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount));
    const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function fitText(ctx, text, maxWidth) {
    text = String(text ?? '');
    if (ctx.measureText(text).width <= maxWidth) return text;
    while (text.length > 0 && ctx.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
    return `${text}…`;
}

function paintBackground(ctx, w, h, theme) {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, theme.top);
    grad.addColorStop(1, theme.bottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
}

function loadImageWithTimeout(url, ms = 5000) {
    let timer;
    return Promise.race([
        loadImage(url).finally(() => clearTimeout(timer)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Avatar load timed out')), ms); }),
    ]);
}

// ─── The overview card ───────────────────────────────────────────────────────

const CARD_W = 1000;
const CARD_H = 430;

/**
 * @param {object} opts
 * @param {'hunt'|'fish'|'explore'} opts.activity   picks the palette
 * @param {string}  opts.name          display name
 * @param {?string} opts.avatarUrl     PNG avatar URL; a failed fetch draws a disc
 * @param {string}  opts.rankTitle     e.g. "Marksman"
 * @param {number}  opts.level
 * @param {number}  [opts.prestige]    0 for none
 * @param {?string} [opts.prestigeLabel] e.g. "Gold Prestige", drawn under the rank
 * @param {{total: number, into: number, span: ?number}} opts.xp  progress through
 *        the current level (`into` of `span`); span null at max level
 * @param {{name: string, iconId: ?string, color?: string}} opts.place  active zone / location / region
 * @param {{current: number, max: number}} opts.stamina
 * @param {{label: string, value: string}[]} opts.stats  up to four headline numbers
 * @param {string}  opts.shelfTitle    e.g. "Best trophies"
 * @param {object[]} opts.shelf        up to eight entries for drawEntry
 * @param {?string} [opts.shelfEmpty]  what the shelf says when it has nothing
 * @returns {Promise<Buffer>} PNG
 */
async function createGrindProfileCard(opts) {
    const theme = themeFor(opts.activity);
    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext('2d');
    paintBackground(ctx, CARD_W, CARD_H, theme);

    // The place, huge and faint behind the right-hand side: the card is
    // "where you are" before it is anything else.
    const placeImg = await loadIcon(opts.place?.iconId);
    if (placeImg) {
        ctx.save();
        ctx.globalAlpha = 0.13;
        ctx.drawImage(placeImg, CARD_W - 470, -90, 560, 560);
        ctx.restore();
    }

    const ring = prestigeRing(opts.prestige, theme);

    // Accent rule along the top.
    ctx.fillStyle = ring;
    ctx.fillRect(0, 0, CARD_W, 6);

    // ── Avatar
    const ax = 100, ay = 110, ar = 68;
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax, ay, ar + 6, 0, Math.PI * 2);
    ctx.fillStyle = ring;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ax, ay, ar, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = '#2b2d31';
    ctx.fillRect(ax - ar, ay - ar, ar * 2, ar * 2);
    if (opts.avatarUrl) {
        try {
            const avatar = await loadImageWithTimeout(opts.avatarUrl);
            ctx.drawImage(avatar, ax - ar, ay - ar, ar * 2, ar * 2);
        } catch { /* the disc stays */ }
    }
    ctx.restore();

    // Level pill over the bottom of the avatar.
    ctx.font = `bold 17px ${FONT}`;
    const lvlText = `LV ${opts.level}`;
    const pillW = ctx.measureText(lvlText).width + 22;
    roundRect(ctx, ax - pillW / 2, ay + ar - 8, pillW, 26, 13);
    ctx.fillStyle = ring;
    ctx.fill();
    ctx.fillStyle = '#101010';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lvlText, ax, ay + ar + 5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // ── Name, rank, prestige
    const tx = 200;
    const textW = 560;
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 36px ${FONT}`;
    ctx.fillText(fitText(ctx, opts.name, textW), tx, 72);

    ctx.font = `bold 21px ${FONT}`;
    ctx.fillStyle = theme.accent;
    const rankLine = `${opts.rankTitle} · Level ${opts.level}`;
    ctx.fillText(fitText(ctx, rankLine, textW), tx, 104);
    if (opts.prestigeLabel) {
        ctx.font = `17px ${FONT}`;
        ctx.fillStyle = ring;
        // Emoji in a label ("🥉 Bronze Prestige") would draw as a blank box.
        ctx.fillText(fitText(ctx, opts.prestigeLabel.replace(/^[^\p{L}\p{N}]+/u, ''), textW), tx, 130);
    }

    // ── XP bar — progress through this level, not the running total
    const bx = tx, by = 146, bw = textW, bh = 22;
    const span = opts.xp?.span;
    const into = Math.max(0, opts.xp?.into ?? 0);
    const frac = span ? Math.max(0, Math.min(1, into / span)) : 1;
    roundRect(ctx, bx, by, bw, bh, bh / 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    if (frac > 0) {
        roundRect(ctx, bx, by, Math.max(bh, bw * frac), bh, bh / 2);
        const fill = ctx.createLinearGradient(bx, 0, bx + bw, 0);
        fill.addColorStop(0, theme.accent);
        fill.addColorStop(1, ring);
        ctx.fillStyle = fill;
        ctx.fill();
    }
    ctx.font = `15px ${FONT}`;
    ctx.fillStyle = theme.muted;
    const total = (opts.xp?.total ?? 0).toLocaleString('en-US');
    const xpText = span
        ? `${Math.max(0, span - into).toLocaleString('en-US')} XP to level ${opts.level + 1} · ${total} total`
        : `${total} XP · max level`;
    ctx.fillText(xpText, bx, by + bh + 20);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText(span ? `${Math.floor(frac * 100)}%` : 'MAX', bx + bw, by + bh + 20);
    ctx.textAlign = 'left';

    // ── Place medallion + stamina, top right
    const mx = 870, my = 92, ms = 128;
    if (opts.place) {
        await drawEntry(ctx, { iconId: opts.place.iconId, name: opts.place.name, color: opts.place.color, owned: true }, mx - ms / 2, my - ms / 2 - 10, ms, theme);
        ctx.font = `bold 16px ${FONT}`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(fitText(ctx, opts.place.name, 200), mx, my + ms / 2 + 8);
        ctx.textAlign = 'left';
    }
    const stam = opts.stamina ?? { current: 0, max: 0 };
    if (stam.max > 0) {
        const pipW = 12, pipH = 16, gap = 4;
        const n = Math.min(stam.max, 14);
        const total = n * pipW + (n - 1) * gap;
        let px = mx - total / 2;
        const py = my + ms / 2 + 20;
        for (let i = 0; i < n; i++) {
            roundRect(ctx, px, py, pipW, pipH, 3);
            ctx.fillStyle = i < Math.min(stam.current, n) ? '#f5c542' : 'rgba(255,255,255,0.14)';
            ctx.fill();
            px += pipW + gap;
        }
        ctx.font = `13px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.textAlign = 'center';
        ctx.fillText(`Stamina ${stam.current}/${stam.max}`, mx, py + pipH + 17);
        ctx.textAlign = 'left';
    }

    // ── Stat tiles
    const stats = (opts.stats ?? []).slice(0, 4);
    const tileY = 222, tileH = 72, tileGap = 14, tileX0 = 32;
    const tileW = stats.length ? (CARD_W - tileX0 * 2 - tileGap * (stats.length - 1)) / stats.length : 0;
    stats.forEach((s, i) => {
        const x = tileX0 + i * (tileW + tileGap);
        roundRect(ctx, x, tileY, tileW, tileH, 12);
        ctx.fillStyle = theme.panel;
        ctx.fill();
        ctx.font = `13px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.fillText(fitText(ctx, s.label.toUpperCase(), tileW - 28), x + 16, tileY + 25);
        ctx.font = `bold 26px ${FONT}`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(fitText(ctx, s.value, tileW - 28), x + 16, tileY + 58);
    });

    // ── Shelf
    const shelfY = 318;
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillStyle = theme.accent;
    ctx.fillText((opts.shelfTitle ?? '').toUpperCase(), tileX0, shelfY);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(tileX0, shelfY + 8, CARD_W - tileX0 * 2, 1);

    const shelf = (opts.shelf ?? []).slice(0, 10);
    if (shelf.length) {
        const size = 86, gap = 10;
        for (let i = 0; i < shelf.length; i++) {
            await drawEntry(ctx, { ...shelf[i], owned: true }, tileX0 + i * (size + gap), shelfY + 16, size, theme);
        }
    } else if (opts.shelfEmpty) {
        ctx.font = `italic 17px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.fillText(opts.shelfEmpty, tileX0, shelfY + 62);
    }

    return encodeCanvas(canvas);
}

// ─── The collection card ─────────────────────────────────────────────────────

// Fourteen across fits the largest group any activity has (fourteen uncommon
// animals, fourteen uncommon fish) on one row, so a group never strands a
// lone icon on a second line.
const COLL_COLS = 14;
const COLL_PAD = 32;
const COLL_ICON = 70;
const COLL_GAP = 8;
const COLL_W = COLL_PAD * 2 + COLL_COLS * COLL_ICON + (COLL_COLS - 1) * COLL_GAP;

/**
 * @param {object} opts
 * @param {'hunt'|'fish'|'explore'} opts.activity
 * @param {string} opts.title        e.g. "munge's Trophy Cabinet"
 * @param {string} opts.subtitle     e.g. "41 of 62 species"
 * @param {{label: string, color?: string, entries: object[]}[]} opts.sections
 *        entries: { iconId, name, owned, badge?, badgeColor?, color? } — name and
 *        color draw the stand-in medallion when no art is baked for iconId
 * @returns {Promise<Buffer>} PNG
 */
async function createGrindCollectionCard(opts) {
    const theme = themeFor(opts.activity);
    const sections = (opts.sections ?? []).filter(s => s.entries?.length);

    const HEADER_H = 104;
    const SECTION_HEAD = 34;
    const rowH = COLL_ICON + COLL_GAP;
    let height = HEADER_H;
    for (const s of sections) height += SECTION_HEAD + Math.ceil(s.entries.length / COLL_COLS) * rowH + 8;
    height += COLL_PAD - 8;

    const canvas = createCanvas(COLL_W, height);
    const ctx = canvas.getContext('2d');
    paintBackground(ctx, COLL_W, height, theme);
    ctx.fillStyle = theme.accent;
    ctx.fillRect(0, 0, COLL_W, 6);

    ctx.font = `bold 32px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fitText(ctx, opts.title, COLL_W - COLL_PAD * 2 - 260), COLL_PAD, 56);
    ctx.font = `17px ${FONT}`;
    ctx.fillStyle = theme.muted;
    ctx.fillText(fitText(ctx, opts.subtitle ?? '', COLL_W - COLL_PAD * 2), COLL_PAD, 84);

    // Completion meter, top right.
    const all = sections.flatMap(s => s.entries);
    const owned = all.filter(e => e.owned !== false).length;
    if (all.length) {
        const mw = 220, mh = 14, mx = COLL_W - COLL_PAD - mw, my = 44;
        roundRect(ctx, mx, my, mw, mh, mh / 2);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fill();
        if (owned) {
            roundRect(ctx, mx, my, Math.max(mh, mw * owned / all.length), mh, mh / 2);
            ctx.fillStyle = theme.accent;
            ctx.fill();
        }
        ctx.font = `bold 15px ${FONT}`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.fillText(`${Math.floor(owned / all.length * 100)}% complete`, COLL_W - COLL_PAD, my + mh + 22);
        ctx.textAlign = 'left';
    }

    let y = HEADER_H;
    for (const s of sections) {
        const got = s.entries.filter(e => e.owned !== false).length;
        ctx.font = `bold 15px ${FONT}`;
        ctx.fillStyle = s.color ?? theme.accent;
        ctx.fillText(s.label.toUpperCase(), COLL_PAD, y + 20);
        const labelW = ctx.measureText(s.label.toUpperCase()).width;
        ctx.font = `15px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.fillText(`${got}/${s.entries.length}`, COLL_PAD + labelW + 10, y + 20);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(COLL_PAD, y + 28, COLL_W - COLL_PAD * 2, 1);
        y += SECTION_HEAD;

        for (let i = 0; i < s.entries.length; i++) {
            const col = i % COLL_COLS;
            const row = Math.floor(i / COLL_COLS);
            await drawEntry(ctx, s.entries[i], COLL_PAD + col * (COLL_ICON + COLL_GAP), y + row * rowH, COLL_ICON, theme);
        }
        y += Math.ceil(s.entries.length / COLL_COLS) * rowH + 8;
    }

    return encodeCanvas(canvas);
}

/** Test seam: forget decoded art. */
function _resetCache() {
    iconCache.clear();
    ghostCache.clear();
}

module.exports = {
    createGrindProfileCard,
    createGrindCollectionCard,
    THEMES,
    COLL_COLS,
    _resetCache,
    __test__: { initials, shade },
};
