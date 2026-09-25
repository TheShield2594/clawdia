'use strict';

/**
 * The companion card: the picture `/pet status` and the Showcase button put
 * above a pet's details.
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ ╭────────────╮  THESHIELD'S COMPANION                     ╭─────╮    │
 *   │ │ PET OF THE │  Apex Ghost                               (  LV  )   │
 *   │ │    WEEK    │  Wolf · Loyal · Trusted                    ( 24  )    │
 *   │ │ (portrait) │                                           ╰─────╯     │
 *   │ │            │  HUNGER ▰▰▰▰▰▰▰▱▱▱▱ 72%       |BONUS                │
 *   │ │            │  BOND   ▰▰▰▰▱▱▱▱ 42                                 │
 *   │ │  ◆ ◆ ◇     │  [PASSIVE +22.5% HUNT YIELD]                         │
 *   │ │  STAGE 2   │  [HP 214][ATK 71][DEF 38][SPD 29][RECORD 18W 4L]      │
 *   │ ╰────────────╯                                                       │
 *   │  ◤ a low, contented rumble                                           │
 *   │    "Life's pretty chill right now, honestly."                        │
 *   │ PET 1 OF 3                             LAST FED 3H AGO · RESTING     │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * It is deliberately not the grind result card (utils/grindResultCard.js).
 * That card is a moment — what one hunt paid, measured against a record. This
 * one is a character sheet: who the pet is, how it is doing, how it fights. So
 * the art sits in a tall portrait window rather than a medallion, progress is a
 * ring rather than a payout gauge, and the colour comes from the species and
 * its mood rather than from a loot tier.
 *
 * The same contract as the rest of the card family: an illustration, not the
 * record. Every number here is also in the embed text beside it, callers give
 * the file alt text, and nothing is drawn as an emoji (node-canvas draws colour
 * emoji as boxes), so the mood gesture and quote are stripped of them.
 *
 * @module utils/petStatusCard
 */

const { createCanvas, loadImage } = require('canvas');
const { encodeCanvas } = require('./canvasEncode');
const { primitives } = require('./grindProfileCard');
const { getDefaultItemImage } = require('./defaultItemImages');

const { FONT, roundRect, fitText, shade } = primitives;

const CARD_W = 1000;
const CARD_H = 600;
const PAD = 40;

const WIN_X = PAD, WIN_Y = PAD, WIN_W = 300, WIN_H = 392;
const PANEL_X = WIN_X + WIN_W + 36;
const RING_R = 58;
const RING_CX = CARD_W - PAD - RING_R - 6;
const RING_CY = PAD + RING_R + 8;
const PANEL_W = CARD_W - PAD - PANEL_X;

const GOLD = '#ffd166';
const WHITE = '#ffffff';
const MUTED = 'rgba(255,255,255,0.62)';
const FAINT = 'rgba(255,255,255,0.08)';

/** Each species' own colour: the portrait glow, the ring and the headings. */
const SPECIES_ACCENT = {
    dog:         '#e0a95f',
    cat:         '#b9a3e3',
    bird:        '#4fc3f7',
    fish:        '#ff8a65',
    fox:         '#ff9f43',
    wolf:        '#9fa8da',
    eagle:       '#d4a373',
    shark:       '#4dd0e1',
    crystal_fox: '#b388ff',
    lantern_owl: '#ffc857',
};
const DEFAULT_ACCENT = '#8fb4ff';

function accentFor(petId) {
    return SPECIES_ACCENT[petId] ?? DEFAULT_ACCENT;
}

function hexToRgba(hex, alpha) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    if (!Number.isFinite(n)) return `rgba(255,255,255,${alpha})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Strips emoji, the joiners around them and Discord formatting, which a canvas cannot draw. */
function plain(text) {
    return String(text ?? '')
        .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}/gu, '')
        .replace(/[*_~`|]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

const num = v => Math.round(Number(v ?? 0)).toLocaleString('en-US');

// Portraits, decoded once per id.
const portraitCache = new Map();
async function loadPortrait(iconId) {
    if (!iconId) return null;
    if (portraitCache.has(iconId)) return portraitCache.get(iconId);
    const bundled = getDefaultItemImage(iconId);
    let img = null;
    if (bundled) {
        try { img = await loadImage(bundled.data); } catch { img = null; }
    }
    portraitCache.set(iconId, img);
    return img;
}

function text(ctx, str, x, y, { font, color = WHITE, align = 'left', baseline = 'top', max = null } = {}) {
    ctx.save();
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillText(max ? fitText(ctx, str, max) : str, x, y);
    ctx.restore();
}

/** Shrinks a font size until `str` fits `max`, down to `min`. */
function fitSize(ctx, str, max, size, min, weight = 'bold') {
    ctx.save();
    ctx.font = `${weight} ${size}px ${FONT}`;
    while (size > min && ctx.measureText(str).width > max) {
        size -= 2;
        ctx.font = `${weight} ${size}px ${FONT}`;
    }
    ctx.restore();
    return size;
}

function pill(ctx, label, x, y, color, { h = 34, fill = null, font = `bold 16px ${FONT}` } = {}) {
    ctx.save();
    ctx.font = font;
    const w = ctx.measureText(label).width + 28;
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = fill ?? hexToRgba(color, 0.18);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = WHITE;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 14, y + h / 2 + 1);
    ctx.restore();
    return w;
}

// ─── Background ──────────────────────────────────────────────────────────────

/** A paw print from ellipses — the card's watermark, drawn rather than typed. */
function pawPrint(ctx, cx, cy, s) {
    ctx.beginPath();
    ctx.ellipse(cx, cy + s * 0.35, s * 0.55, s * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    for (const [dx, dy, r] of [[-0.62, -0.28, 0.2], [-0.22, -0.62, 0.22], [0.22, -0.62, 0.22], [0.62, -0.28, 0.2]]) {
        ctx.beginPath();
        ctx.ellipse(cx + dx * s, cy + dy * s, r * s, r * s * 1.2, 0, 0, Math.PI * 2);
        ctx.fill();
    }
}

function paintBackdrop(ctx, accent, moodColor, bondFrame = null) {
    const grad = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
    grad.addColorStop(0, shade(accent, -0.72));
    grad.addColorStop(0.55, '#0d0f16');
    grad.addColorStop(1, '#07080c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // The mood washes in from the right edge: calm green to alarm red.
    const wash = ctx.createRadialGradient(CARD_W, CARD_H * 0.45, 20, CARD_W, CARD_H * 0.45, 520);
    wash.addColorStop(0, hexToRgba(moodColor, 0.16));
    wash.addColorStop(1, hexToRgba(moodColor, 0));
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // Two faint paw prints walking off the bottom-right corner, under the
    // speech bubble rather than the stat tiles.
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    pawPrint(ctx, CARD_W - 120, CARD_H - 70, 70);
    pawPrint(ctx, CARD_W - 250, CARD_H - 20, 52);
    ctx.restore();

    // A thin frame in the species colour, so the card reads as one object —
    // or, from the Trusted bond tier up, a heavier one in the tier's colour
    // (#1186).
    roundRect(ctx, 6, 6, CARD_W - 12, CARD_H - 12, 22);
    ctx.lineWidth = bondFrame ? 5 : 2;
    ctx.strokeStyle = bondFrame ? hexToRgba(bondFrame, 0.9) : hexToRgba(accent, 0.35);
    ctx.stroke();
}

// ─── Portrait window ─────────────────────────────────────────────────────────

async function drawPortraitWindow(ctx, o, accent) {
    const frame = o.rare ? GOLD : accent;

    roundRect(ctx, WIN_X, WIN_Y, WIN_W, WIN_H, 26);
    const inner = ctx.createLinearGradient(0, WIN_Y, 0, WIN_Y + WIN_H);
    inner.addColorStop(0, hexToRgba(accent, 0.22));
    inner.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = inner;
    ctx.fill();
    ctx.lineWidth = o.rare ? 4 : 3;
    ctx.strokeStyle = hexToRgba(frame, o.rare ? 0.95 : 0.7);
    ctx.stroke();

    const cx = WIN_X + WIN_W / 2, cy = WIN_Y + 170;
    const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, 170);
    glow.addColorStop(0, hexToRgba(accent, 0.45 + (o.stage - 1) * 0.12));
    glow.addColorStop(1, hexToRgba(accent, 0));
    ctx.save();
    roundRect(ctx, WIN_X, WIN_Y, WIN_W, WIN_H, 26);
    ctx.clip();
    ctx.fillStyle = glow;
    ctx.fillRect(WIN_X, WIN_Y, WIN_W, WIN_H);
    ctx.restore();

    const img = await loadPortrait(o.iconId);
    const size = 250;
    if (img) {
        ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    } else {
        // No baked art: the species initial on a disc in its colour.
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, size * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = shade(accent, -0.45);
        ctx.fill();
        ctx.lineWidth = 6;
        ctx.strokeStyle = accent;
        ctx.stroke();
        ctx.restore();
        text(ctx, plain(o.species).slice(0, 1).toUpperCase() || '?', cx, cy + 2,
            { font: `bold 96px ${FONT}`, align: 'center', baseline: 'middle' });
    }

    // Evolution: three diamonds, lit up to the pet's stage.
    const dy = WIN_Y + WIN_H - 62;
    for (let i = 0; i < 3; i++) {
        const dx = cx + (i - 1) * 34;
        const lit = i < o.stage;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(dx, dy - 11);
        ctx.lineTo(dx + 11, dy);
        ctx.lineTo(dx, dy + 11);
        ctx.lineTo(dx - 11, dy);
        ctx.closePath();
        ctx.fillStyle = lit ? GOLD : 'rgba(255,255,255,0.12)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = lit ? shade(GOLD, -0.3) : 'rgba(255,255,255,0.25)';
        ctx.stroke();
        ctx.restore();
    }
    text(ctx, o.stageName.toUpperCase(), cx, dy + 22, { font: `bold 15px ${FONT}`, color: MUTED, align: 'center' });

    // One ribbon across the top of the window: Pet of the Week outranks the
    // rare tag, and a rare pet keeps its gold frame either way.
    const ribbon = o.potw ? { label: 'PET OF THE WEEK', solid: true }
        : o.rare ? { label: 'RARE COMPANION', solid: false }
        : null;
    if (ribbon) {
        const bw = 190, bh = 32, bx = cx - bw / 2, by = WIN_Y - 14;
        roundRect(ctx, bx, by, bw, bh, bh / 2);
        ctx.fillStyle = ribbon.solid ? GOLD : '#2b2100';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = GOLD;
        ctx.stroke();
        text(ctx, ribbon.label, cx, by + bh / 2 + 1,
            { font: `bold 15px ${FONT}`, color: ribbon.solid ? '#2b2100' : GOLD, align: 'center', baseline: 'middle' });
    }
}

// ─── Header and level ring ───────────────────────────────────────────────────

function drawHeader(ctx, o, accent) {
    const maxW = RING_CX - RING_R - 24 - PANEL_X;
    text(ctx, plain(o.kicker).toUpperCase(), PANEL_X, PAD + 6, { font: `bold 17px ${FONT}`, color: hexToRgba(accent, 0.95), max: maxW });

    const name = plain(o.titledName) || plain(o.species) || 'Companion';
    const size = fitSize(ctx, name, maxW, 50, 26);
    text(ctx, name, PANEL_X, PAD + 32 + (50 - size) / 2, { font: `bold ${size}px ${FONT}`, max: maxW });

    const sub = [plain(o.species), plain(o.personality), plain(o.bondTitle)].filter(Boolean).join('  ·  ');
    text(ctx, sub, PANEL_X, PAD + 94, { font: `bold 20px ${FONT}`, color: MUTED, max: maxW });
}

function drawLevelRing(ctx, o, accent) {
    const frac = o.maxed ? 1 : Math.max(0, Math.min(1, o.xpToNext > 0 ? o.xpInLevel / o.xpToNext : 0));
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 12;
    ctx.strokeStyle = FAINT;
    ctx.beginPath();
    ctx.arc(RING_CX, RING_CY, RING_R, 0, Math.PI * 2);
    ctx.stroke();
    if (frac > 0) {
        ctx.strokeStyle = o.maxed ? GOLD : accent;
        ctx.beginPath();
        ctx.arc(RING_CX, RING_CY, RING_R, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.stroke();
    }
    ctx.restore();
    text(ctx, 'LV', RING_CX, RING_CY - 26, { font: `bold 15px ${FONT}`, color: MUTED, align: 'center' });
    text(ctx, String(o.level), RING_CX, RING_CY + 12, { font: `bold 40px ${FONT}`, align: 'center', baseline: 'middle' });
    const caption = o.maxed ? 'MAX LEVEL' : `${num(o.xpInLevel)} / ${num(o.xpToNext)} XP`;
    text(ctx, caption, RING_CX, RING_CY + RING_R + 14, { font: `bold 14px ${FONT}`, color: o.maxed ? GOLD : MUTED, align: 'center' });
}

// ─── Vitals ──────────────────────────────────────────────────────────────────

const LABEL_W = 96;

function drawHungerBar(ctx, o, y) {
    const x = PANEL_X + LABEL_W, w = PANEL_W - LABEL_W - 76, h = 20;
    text(ctx, 'HUNGER', PANEL_X, y + h / 2 + 1, { font: `bold 16px ${FONT}`, color: MUTED, baseline: 'middle' });

    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = FAINT;
    ctx.fill();
    const pct = Math.max(0, Math.min(100, o.hunger));
    if (pct > 0) {
        const fw = Math.max(h, (pct / 100) * w);
        const grad = ctx.createLinearGradient(x, 0, x + fw, 0);
        grad.addColorStop(0, shade(o.moodColor, -0.35));
        grad.addColorStop(1, o.moodColor);
        roundRect(ctx, x, y, fw, h, h / 2);
        ctx.fillStyle = grad;
        ctx.fill();
    }
    // Where the passive switches off.
    const tx = x + (o.threshold / 100) * w;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(tx, y - 6);
    ctx.lineTo(tx, y + h + 6);
    ctx.stroke();
    ctx.restore();
    text(ctx, 'BONUS', tx + 5, y - 8, { font: `bold 11px ${FONT}`, color: MUTED, baseline: 'bottom' });
    text(ctx, `${Math.round(pct)}%`, x + w + 14, y + h / 2 + 1, { font: `bold 20px ${FONT}`, color: o.moodColor, baseline: 'middle' });
}

function drawBondBar(ctx, o, y) {
    const x = PANEL_X + LABEL_W, w = PANEL_W - LABEL_W - 76, h = 20;
    text(ctx, 'BOND', PANEL_X, y + h / 2 + 1, { font: `bold 16px ${FONT}`, color: MUTED, baseline: 'middle' });
    const SEGMENTS = 8, gap = 6;
    const sw = (w - gap * (SEGMENTS - 1)) / SEGMENTS;
    const max = o.bondMax ?? 100;
    const filled = Math.max(0, Math.min(SEGMENTS, Math.floor((o.bond ?? 0) / (max / SEGMENTS))));
    for (let i = 0; i < SEGMENTS; i++) {
        roundRect(ctx, x + i * (sw + gap), y, sw, h, 6);
        ctx.fillStyle = i < filled ? '#ff6b8b' : FAINT;
        ctx.fill();
    }
    text(ctx, num(o.bond ?? 0), x + w + 14, y + h / 2 + 1, { font: `bold 20px ${FONT}`, color: '#ff8fa6', baseline: 'middle' });
}

function drawPassive(ctx, o, y) {
    const b = o.bonus;
    if (!b) return;
    // `unit` is ' pts' for the success-chance passives, which add points
    // rather than multiply (#1190).
    const amount = `+${b.pct}${(b.unit ?? '%').toUpperCase()} ${plain(b.label).toUpperCase()}`;
    const label = b.active
        ? `PASSIVE  ${amount}`
        : `PASSIVE OFF  ${amount}  -  FEED ABOVE ${o.threshold}%`;
    const color = b.active ? '#4cc27a' : '#8a8a8a';
    ctx.save();
    ctx.font = `bold 16px ${FONT}`;
    const fits = ctx.measureText(label).width + 28 <= PANEL_W;
    ctx.restore();
    pill(ctx, fits ? label : fitText(ctx, label, PANEL_W - 28), PANEL_X, y, color);
}

// ─── Battle stats ────────────────────────────────────────────────────────────

function statTile(ctx, { label, value, boosted, note }, x, y, w, accent) {
    const h = 74;
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = boosted ? hexToRgba(accent, 0.18) : 'rgba(255,255,255,0.06)';
    ctx.fill();
    if (boosted) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = hexToRgba(accent, 0.8);
        ctx.stroke();
    }
    text(ctx, label, x + 12, y + 11, { font: `bold 13px ${FONT}`, color: boosted ? accent : MUTED, max: w - 24 });
    // A second, smaller fact in the label row's right corner.
    if (note) text(ctx, note, x + w - 12, y + 12, { font: `bold 11px ${FONT}`, color: boosted ? accent : MUTED, align: 'right' });
    const size = fitSize(ctx, value, w - 24, 28, 16);
    text(ctx, value, x + 12, y + 32 + (28 - size) / 2, { font: `bold ${size}px ${FONT}`, max: w - 24 });
}

function drawBattleStats(ctx, o, y, accent) {
    const s = o.stats ?? {};
    const boosted = new Set(o.boosted ?? []);
    const tiles = [
        { key: 'hp',  label: 'HP',  value: num(s.hp) },
        { key: 'atk', label: 'ATK', value: num(s.atk) },
        { key: 'def', label: 'DEF', value: num(s.def) },
        { key: 'spd', label: 'SPD', value: num(s.spd) },
        { key: 'crit', label: 'CRIT', value: `${Math.round((s.crit ?? 0) * 100)}%` },
    ].map(t => ({ ...t, boosted: boosted.has(t.key) }));

    const recordW = 170, gap = 8;
    const tileW = (PANEL_W - recordW - gap * tiles.length) / tiles.length;
    tiles.forEach((t, i) => statTile(ctx, t, PANEL_X + i * (tileW + gap), y, tileW, accent));

    const r = o.record ?? {};
    const rx = PANEL_X + tiles.length * (tileW + gap);
    statTile(ctx, {
        label: 'RECORD',
        note: `PVP ${num(r.pvpWins)}-${num(r.pvpLosses)}`,
        value: `${num(r.wins)}W ${num(r.losses)}L`,
    }, rx, y, recordW, accent);
}

// ─── Speech bubble and footer ────────────────────────────────────────────────

function drawSpeech(ctx, o, accent) {
    const x = PAD, y = WIN_Y + WIN_H + 28, w = CARD_W - PAD * 2, h = 78, r = 18;
    // One outline, tail included, so the tail reaching up toward the portrait
    // has no seam where it meets the bubble.
    const tx = WIN_X + WIN_W / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(tx - 14, y);
    ctx.lineTo(tx, y - 20);
    ctx.lineTo(tx + 14, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = hexToRgba(accent, 0.45);
    ctx.stroke();

    const action = plain(o.action);
    const quote = plain(o.quote);
    if (action) text(ctx, action, x + 22, y + 12, { font: `bold 15px ${FONT}`, color: hexToRgba(accent, 0.95), max: w - 44 });
    const size = fitSize(ctx, quote, w - 44, 22, 16);
    text(ctx, quote, x + 22, y + (action ? 38 : 26), { font: `bold ${size}px ${FONT}`, max: w - 44 });
}

function drawFooter(ctx, o) {
    const y = CARD_H - 30;
    if (o.footerLeft)  text(ctx, plain(o.footerLeft).toUpperCase(), PAD + 4, y, { font: `bold 14px ${FONT}`, color: MUTED, baseline: 'middle' });
    if (o.footerRight) text(ctx, plain(o.footerRight).toUpperCase(), CARD_W - PAD - 4, y, { font: `bold 14px ${FONT}`, color: MUTED, align: 'right', baseline: 'middle' });
}

/**
 * @param {object} o
 * @param {string}  o.petId         picks the species colour
 * @param {?string} o.iconId        the bundled portrait (pet__<id>)
 * @param {string}  o.kicker        e.g. "TheShield's companion"
 * @param {string}  o.titledName    e.g. "Apex Ghost"
 * @param {string}  o.species       e.g. "Wolf"
 * @param {?string} o.personality   e.g. "Loyal"
 * @param {boolean} [o.rare]        an unpurchasable companion: gold frame
 * @param {boolean} [o.potw]        Pet of the Week ribbon
 * @param {number}  o.stage         1–3
 * @param {string}  o.stageName     e.g. "Stage 2 - Seasoned"
 * @param {number}  o.level
 * @param {boolean} o.maxed
 * @param {number}  o.xpInLevel
 * @param {number}  o.xpToNext
 * @param {number}  o.hunger        0–100
 * @param {number}  o.threshold     where the passive switches off
 * @param {string}  o.moodColor
 * @param {number}  o.bond          0–bondMax, earned by care
 * @param {number}  [o.bondMax]     100
 * @param {?string} [o.bondTitle]   the bond tier's title, e.g. "Devoted"
 * @param {?string} [o.bondFrame]   the tier's frame colour, or null for the species one
 * @param {?{pct: number, unit?: string, label: string, active: boolean}} o.bonus
 * @param {{hp: number, atk: number, def: number, spd: number, crit: number}} o.stats
 * @param {string[]} [o.boosted]    stat keys the personality raises
 * @param {{wins: number, losses: number, pvpWins: number, pvpLosses: number}} o.record
 * @param {?string} o.action        the species gesture
 * @param {string}  o.quote         the mood line
 * @param {?string} [o.footerLeft]
 * @param {?string} [o.footerRight]
 * @returns {Promise<Buffer>} PNG
 */
async function createPetStatusCard(o) {
    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext('2d');
    const accent = accentFor(o.petId);
    const stage = Math.min(3, Math.max(1, o.stage | 0 || 1));
    const opts = { ...o, stage };

    paintBackdrop(ctx, accent, o.moodColor, o.bondFrame);
    await drawPortraitWindow(ctx, opts, accent);
    drawHeader(ctx, opts, accent);
    drawLevelRing(ctx, opts, accent);
    drawHungerBar(ctx, opts, PAD + 176);
    drawBondBar(ctx, opts, PAD + 222);
    drawPassive(ctx, opts, PAD + 262);
    drawBattleStats(ctx, opts, PAD + 318, accent);
    drawSpeech(ctx, opts, accent);
    drawFooter(ctx, opts);

    return encodeCanvas(canvas);
}

module.exports = { createPetStatusCard, SPECIES_ACCENT, CARD_W, CARD_H, __test__: { plain, accentFor } };
