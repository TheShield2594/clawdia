'use strict';

/**
 * The picture half of the `/hunt`, `/fish` and `/explore` profiles, of the
 * `/fish`, `/hunt` and `/mine` inventories, and of `/inventory`'s Items tab.
 *
 * Three cards, shared across the grinds so the screens read as one family:
 *
 *   createGrindProfileCard     the overview — avatar, rank, XP bar, where the
 *                              player is, stamina, four headline numbers and a
 *                              shelf of their best finds.
 *   createGrindCollectionCard  the collection — every species / relic the game
 *                              has, grouped, owned ones in full colour and the
 *                              rest as grey ghosts, so the gaps say what to go
 *                              after next.
 *   createGrindInventoryCard   the inventory — gear on a rack with wear bars
 *                              and the equipped piece outlined, stock as
 *                              tiles with counts (`/fish inv`, `/hunt inv`,
 *                              `/mine inv`, and `/inventory`'s Items tab,
 *                              which has stock but no gear).
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
    mine:    { top: '#2e2622', bottom: '#0d0a08', accent: '#e07b39', muted: '#cdb4a0', panel: 'rgba(255,255,255,0.06)' },
    // /inventory's Items tab — not one grind but all of them, so Discord blurple.
    items:   { top: '#1f2244', bottom: '#0a0b18', accent: '#7c86f7', muted: '#b6bbe9', panel: 'rgba(255,255,255,0.06)' },
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

// ─── The inventory card ──────────────────────────────────────────────────────

// The tackle box / gun rack / tool belt: what a player is carrying right now,
// where the collection card is what they have ever found. Gear gets a rack of
// cards (art, wear bar, equipped outline); stock gets a grid of tiles, each
// with its count in a pill on the corner.

const INV_W = 1000;
const INV_PAD = 32;
const INV_HEADER_H = 104;
const INV_SECTION_HEAD = 34;
const INV_GEAR_COLS = 5;
const INV_GEAR_GAP = 14;
const INV_GEAR_H = 214;
const INV_TILE_COLS = 8;
const INV_TILE = 72;
const INV_TILE_W = (INV_W - INV_PAD * 2) / INV_TILE_COLS;
const INV_TILE_H = INV_TILE + 30;
const INV_PILL_H = 30;

// Stand-in medallion colours for stock with no baked art and no colour of its
// own, picked by name so an item keeps its colour from one render to the next
// and a row of them does not read as one blur of the accent.
const MEDALLION_PALETTE = ['#5dade2', '#58d68d', '#f5b041', '#ec7063', '#af7ac5', '#48c9b0', '#f4d03f', '#dc7633', '#85929e', '#e59866'];

function medallionColor(name) {
    let h = 0;
    for (const ch of String(name ?? '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return MEDALLION_PALETTE[h % MEDALLION_PALETTE.length];
}

/** Wear colour: the activity accent while healthy, amber, then red; grey when broken. */
function wearColor(frac, status, theme) {
    if (status === 'broken') return '#6b6b6b';
    if (frac > 0.5) return theme.accent;
    if (frac > 0.25) return '#f5c542';
    return '#e5534b';
}

/** A count in a rounded pill, anchored on its bottom-right corner at (x, y). */
function drawCountPill(ctx, text, x, y, color) {
    ctx.save();
    ctx.font = `bold 14px ${FONT}`;
    const w = Math.max(24, ctx.measureText(text).width + 14);
    const h = 22;
    // Dark fill, coloured rim: a pale item colour (Pearl) would wash out white text.
    roundRect(ctx, x - w, y - h, w, h, h / 2);
    ctx.fillStyle = '#0d141c';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x - w / 2, y - h / 2 + 1);
    ctx.restore();
}

function drawMoreNote(ctx, more, y, theme) {
    if (!(more > 0)) return;
    ctx.font = `14px ${FONT}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'right';
    ctx.fillText(`+${more} more`, INV_W - INV_PAD, y + 20);
    ctx.textAlign = 'left';
}

function drawSectionHead(ctx, label, count, y, theme) {
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillStyle = theme.accent;
    const text = label.toUpperCase();
    ctx.fillText(text, INV_PAD, y + 20);
    if (count != null) {
        const labelW = ctx.measureText(text).width;
        ctx.font = `15px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.fillText(String(count), INV_PAD + labelW + 10, y + 20);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(INV_PAD, y + 28, INV_W - INV_PAD * 2, 1);
}

/** Card heights, shared by the renderer and the size the canvas is made. */
function inventoryLayout(opts) {
    const gear = opts.gear ?? null;
    const sections = opts.sections ?? [];
    const buffs = (opts.buffs ?? []).filter(Boolean);
    let h = INV_HEADER_H;
    if (buffs.length) h += INV_PILL_H + 14;
    if (gear) h += INV_SECTION_HEAD + (gear.entries?.length ? INV_GEAR_H : 40) + 14;
    for (const s of sections) {
        const rows = s.entries?.length ? Math.ceil(s.entries.length / INV_TILE_COLS) : 0;
        h += INV_SECTION_HEAD + (rows ? rows * INV_TILE_H : 40) + 10;
    }
    return { height: h + INV_PAD - 10, gear, sections, buffs };
}

async function drawGearCard(ctx, g, x, y, w, theme) {
    const h = INV_GEAR_H;
    roundRect(ctx, x, y, w, h, 14);
    ctx.fillStyle = g.equipped ? 'rgba(255,255,255,0.11)' : theme.panel;
    ctx.fill();
    if (g.equipped) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = theme.accent;
        ctx.stroke();
    }

    // Slot number, top left: the number the equip command takes.
    if (g.number != null) {
        ctx.font = `bold 15px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.fillText(`#${g.number}`, x + 12, y + 24);
    }
    if (g.equipped) {
        ctx.font = `bold 12px ${FONT}`;
        const label = 'EQUIPPED';
        const pw = ctx.measureText(label).width + 14;
        roundRect(ctx, x + w - pw - 10, y + 10, pw, 20, 10);
        ctx.fillStyle = theme.accent;
        ctx.fill();
        ctx.fillStyle = '#0b0b0b';
        ctx.textAlign = 'center';
        ctx.fillText(label, x + w - pw / 2 - 10, y + 24);
        ctx.textAlign = 'left';
    }

    const icon = 92;
    const broken = g.status === 'broken';
    await drawEntry(ctx, { iconId: g.iconId, name: g.name, color: g.color, owned: !broken }, x + (w - icon) / 2, y + 30, icon, theme);

    ctx.textAlign = 'center';
    ctx.font = `bold 16px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fitText(ctx, g.name, w - 20), x + w / 2, y + 144);

    // Wear bar.
    const max = Math.max(1, g.max ?? 1);
    const cur = Math.max(0, Math.min(max, g.current ?? 0));
    const frac = cur / max;
    const bx = x + 14, bw = w - 28, by = y + 156, bh = 10;
    roundRect(ctx, bx, by, bw, bh, bh / 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    if (frac > 0) {
        roundRect(ctx, bx, by, Math.max(bh, bw * frac), bh, bh / 2);
        ctx.fillStyle = wearColor(frac, g.status, theme);
        ctx.fill();
    }
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = broken ? '#e5534b' : theme.muted;
    const statusWord = g.status && g.status !== 'good' ? ` · ${g.status}` : '';
    ctx.fillText(fitText(ctx, `${cur}/${max}${statusWord}`, w - 20), x + w / 2, by + bh + 18);

    if (g.tag) {
        ctx.font = `bold 12px ${FONT}`;
        ctx.fillStyle = theme.accent;
        ctx.fillText(fitText(ctx, `+ ${g.tag}`.toUpperCase(), w - 20), x + w / 2, by + bh + 36);
    }
    ctx.textAlign = 'left';
}

/**
 * @param {object} opts
 * @param {'hunt'|'fish'|'explore'|'mine'|'items'} opts.activity
 * @param {string}   opts.title       e.g. "munge's Tackle Box"
 * @param {string}   [opts.subtitle]  e.g. "3 rods · 60 bait · 4 materials"
 * @param {string[]} [opts.buffs]     active effects, drawn as pills (no emoji —
 *        a canvas draws them as boxes)
 * @param {{label: string, entries: object[], more?: number, empty?: string}} [opts.gear]
 *        entries: { iconId, name, color?, number, current, max, status, equipped, tag? };
 *        the first five are drawn, `more` says how many were left off
 * @param {{label: string, entries: object[], count?: number, more?: number, empty?: string}[]} [opts.sections]
 *        entries: { iconId, name, count, color? } — callers trim a long list
 *        themselves and pass how many they left off as `more`
 * @returns {Promise<Buffer>} PNG
 */
async function createGrindInventoryCard(opts) {
    const theme = themeFor(opts.activity);
    const { height, gear, sections, buffs } = inventoryLayout(opts);

    const canvas = createCanvas(INV_W, height);
    const ctx = canvas.getContext('2d');
    paintBackground(ctx, INV_W, height, theme);
    ctx.fillStyle = theme.accent;
    ctx.fillRect(0, 0, INV_W, 6);

    ctx.font = `bold 32px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fitText(ctx, opts.title, INV_W - INV_PAD * 2), INV_PAD, 56);
    ctx.font = `17px ${FONT}`;
    ctx.fillStyle = theme.muted;
    ctx.fillText(fitText(ctx, opts.subtitle ?? '', INV_W - INV_PAD * 2), INV_PAD, 84);

    let y = INV_HEADER_H;

    // ── Active buffs, as a row of pills
    if (buffs.length) {
        let x = INV_PAD;
        ctx.font = `bold 14px ${FONT}`;
        for (const b of buffs) {
            const text = fitText(ctx, String(b).replace(/^[^\p{L}\p{N}]+/u, ''), 360);
            const w = ctx.measureText(text).width + 26;
            if (x + w > INV_W - INV_PAD) break;
            roundRect(ctx, x, y, w, INV_PILL_H, INV_PILL_H / 2);
            ctx.fillStyle = 'rgba(245,197,66,0.16)';
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = '#f5c542';
            ctx.stroke();
            ctx.fillStyle = '#f5c542';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, x + 13, y + INV_PILL_H / 2 + 1);
            ctx.textBaseline = 'alphabetic';
            x += w + 10;
        }
        y += INV_PILL_H + 14;
    }

    // ── Gear rack
    if (gear) {
        const shown = (gear.entries ?? []).slice(0, INV_GEAR_COLS);
        const more = (gear.more ?? 0) + Math.max(0, (gear.entries?.length ?? 0) - shown.length);
        drawSectionHead(ctx, gear.label, gear.count ?? null, y, theme);
        drawMoreNote(ctx, more, y, theme);
        y += INV_SECTION_HEAD;
        if (shown.length) {
            const w = (INV_W - INV_PAD * 2 - INV_GEAR_GAP * (INV_GEAR_COLS - 1)) / INV_GEAR_COLS;
            for (let i = 0; i < shown.length; i++) {
                await drawGearCard(ctx, shown[i], INV_PAD + i * (w + INV_GEAR_GAP), y, w, theme);
            }
            y += INV_GEAR_H + 14;
        } else {
            ctx.font = `italic 17px ${FONT}`;
            ctx.fillStyle = theme.muted;
            ctx.fillText(gear.empty ?? 'Nothing here yet.', INV_PAD, y + 26);
            y += 40 + 14;
        }
    }

    // ── Stock grids
    for (const s of sections) {
        const entries = s.entries ?? [];
        drawSectionHead(ctx, s.label, s.count ?? null, y, theme);
        drawMoreNote(ctx, s.more, y, theme);
        y += INV_SECTION_HEAD;
        if (!entries.length) {
            ctx.font = `italic 17px ${FONT}`;
            ctx.fillStyle = theme.muted;
            ctx.fillText(s.empty ?? 'None', INV_PAD, y + 26);
            y += 40 + 10;
            continue;
        }
        for (let i = 0; i < entries.length; i++) {
            const e = { ...entries[i], color: entries[i].color ?? medallionColor(entries[i].name) };
            const col = i % INV_TILE_COLS;
            const row = Math.floor(i / INV_TILE_COLS);
            const cx = INV_PAD + col * INV_TILE_W;
            const cy = y + row * INV_TILE_H;
            const ix = cx + (INV_TILE_W - INV_TILE) / 2;
            await drawEntry(ctx, { iconId: e.iconId, name: e.name, color: e.color, owned: true }, ix, cy, INV_TILE, theme);
            if (e.count != null) {
                const n = Number(e.count);
                const text = Number.isFinite(n) ? `×${n > 9999 ? '9999+' : n.toLocaleString('en-US')}` : String(e.count);
                drawCountPill(ctx, text, ix + INV_TILE + 8, cy + INV_TILE, e.color ?? theme.accent);
            }
            // Step down a size before truncating: "Composite Round" fits at 11px.
            ctx.font = `13px ${FONT}`;
            if (ctx.measureText(e.name).width > INV_TILE_W - 10) ctx.font = `11px ${FONT}`;
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.fillText(fitText(ctx, e.name, INV_TILE_W - 10), cx + INV_TILE_W / 2, cy + INV_TILE + 20);
            ctx.textAlign = 'left';
        }
        y += Math.ceil(entries.length / INV_TILE_COLS) * INV_TILE_H + 10;
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
    createGrindInventoryCard,
    THEMES,
    COLL_COLS,
    INV_GEAR_COLS,
    INV_TILE_COLS,
    _resetCache,
    __test__: { initials, shade },
};
