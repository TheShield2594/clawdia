'use strict';

/**
 * The grind result card: the picture a `/hunt start` kill, a `/fish cast`
 * catch, a `/mine dig` strike and an `/explore go` find carry above their
 * result text — one layout, so the four grinds' results read as one family.
 * Each grind has a thin adapter that maps its result onto these options and
 * writes the alt text (commands/economy/<grind>/resultCard.js): the catch card
 * is drawn with `activity: 'fish'`, a weight gauge and a BOSS FIGHT banner; the
 * mine's with a CAVE-IN banner; the explorer's with an encounter or survey one.
 * The kill card, for reference:
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │    ╭──────╮      THESHIELD BAGGED                   (zone art, faint)│
 *   │   ( art in )     Golden Fox                                          │
 *   │   ( a tier )     Pristine Trophy · ×1.20                             │
 *   │   (  glow  )       YOUR BEST 2,980                                   │
 *   │    ╰──────╯      ━━━━━━━━━━━━━◆━━━━━━━━━━━━  (this hunt's payout)    │
 *   │                             RECORD 3,900                             │
 *   │                  [COINS +1,240] [XP +85]  [CRITICAL ×2.13]           │
 *   │ [LEGENDARY ★★★★★] [SERVER RECORD] [PERSONAL BEST] [Perfect shot] …   │
 *   │ ▌APEX DUEL  Dire Alpha defeated                       +1,800 coins   │
 *   │                                                     Legendary Peaks  │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * What it adds to the catch card's layout is the place: the zone the animal
 * was taken in, drawn huge and faint behind the right-hand side, as the
 * profile card draws the player's zone. Where a fish is measured by weight, a
 * kill is measured by what it paid, so the gauge sets this hunt's payout
 * against the hunter's previous best and the server record.
 *
 * The same contract as every card in the family: an illustration, not the
 * record — every number here is also in the embed text, callers give the file
 * alt text, and nothing drawn is a currency symbol or an emoji (a guild
 * currency can be a custom Discord emoji, and node-canvas draws colour emoji as
 * boxes), so amounts are plain numbers and labels are words.
 *
 * @module utils/grindResultCard
 */

const { createCanvas, loadImage } = require('canvas');
const { encodeCanvas } = require('./canvasEncode');
const { primitives } = require('./grindProfileCard');
const { getDefaultItemImage } = require('./defaultItemImages');

const { FONT, themeFor, paintBackground, drawEntry, roundRect, fitText, shade } = primitives;

// The catch card's grid, so the two line up.
const CARD_W = 1000;
const BASE_H = 440;
const ART_SIZE = 250;
const ART_X = 85;
const ART_Y = 70;
const PANEL_X = 400;
const PANEL_W = CARD_W - PANEL_X - 50;
const BADGE_Y = 362;
const BADGE_H = 32;
const APEX_H = 62;

/** Tier colours by tier number — the ramp the rarity ribbon uses. */
const TIER_COLOR = { 1: '#9e9e9e', 2: '#4caf50', 3: '#2196f3', 4: '#9c27b0', 5: '#ff9800', 6: '#e74c3c' };
const TIER_WORD  = { 1: 'COMMON', 2: 'UNCOMMON', 3: 'RARE', 4: 'EPIC', 5: 'LEGENDARY', 6: 'MYTHICAL' };
const GOLD = '#ffd166';
const APEX_COLOR = { perfect: GOLD, win: '#2ecc71', survived: '#3498db', escaped: '#8a6a4a' };
const TONE = { good: '#4cc27a', bad: '#e5534b', gold: GOLD, info: '#9cc7a8', crit: '#ffd700', level: '#b9a6ff' };

// Zone art, decoded once per id.
const placeCache = new Map();
async function loadPlace(iconId) {
    if (!iconId) return null;
    if (placeCache.has(iconId)) return placeCache.get(iconId);
    const bundled = getDefaultItemImage(iconId);
    let img = null;
    if (bundled) {
        try { img = await loadImage(bundled.data); } catch { img = null; }
    }
    placeCache.set(iconId, img);
    return img;
}

function hexToRgba(hex, alpha) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    if (!Number.isFinite(n)) return `rgba(255,255,255,${alpha})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Strips emoji and the joiners around them, which a canvas cannot draw. */
function plain(text) {
    return String(text ?? '')
        .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}/gu, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

const n = v => Number(v ?? 0).toLocaleString('en-US');

function pill(ctx, text, x, y, color, { font = `bold 16px ${FONT}`, padX = 14, h = BADGE_H, fill = null } = {}) {
    ctx.save();
    ctx.font = font;
    const w = ctx.measureText(text).width + padX * 2;
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = fill ?? hexToRgba(color, 0.18);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + padX, y + h / 2 + 1);
    ctx.restore();
    return w;
}

/** Lays badges out in rows across the card; returns the rows as [{x, badge, w}]. */
function layoutBadges(ctx, badges, x0, maxW) {
    ctx.save();
    ctx.font = `bold 16px ${FONT}`;
    const rows = [[]];
    let x = 0;
    for (const b of badges) {
        const w = ctx.measureText(b.text).width + 28;
        if (x > 0 && x + w > maxW) { rows.push([]); x = 0; }
        rows.at(-1).push({ x: x0 + x, badge: b, w });
        x += w + 10;
    }
    ctx.restore();
    return badges.length ? rows : [];
}

// The payout gauge: this hunt's coins on a bar scaled to the biggest of the
// three numbers, with the hunter's previous best above and the record below.
// A gauge can measure something other than coins — a fish is measured by its
// weight — by passing its own `value`, a `unit` for the labels, and a `max`
// for the bar's full length (the species' heaviest possible, say).
function drawPayoutGauge(ctx, g, x, y, w, tierColor, theme) {
    const h = 14;
    const top = g.max ?? (Math.max(g.value, g.best ?? 0, g.record ?? 0) * 1.08 || 1);
    const unit = g.unit ? ` ${g.unit}` : '';
    const at = v => x + Math.max(0, Math.min(1, v / top)) * w;

    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fill();

    const fillW = Math.max(h, at(g.value) - x);
    const grad = ctx.createLinearGradient(x, 0, x + fillW, 0);
    grad.addColorStop(0, shade(tierColor, -0.35));
    grad.addColorStop(1, tierColor);
    roundRect(ctx, x, y, fillW, h, h / 2);
    ctx.fillStyle = grad;
    ctx.fill();

    const tick = (value, label, color, above) => {
        const tx = at(value);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(tx, y - 6);
        ctx.lineTo(tx, y + h + 6);
        ctx.stroke();
        ctx.font = `bold 14px ${FONT}`;
        ctx.fillStyle = color;
        ctx.textAlign = tx > x + w - 70 ? 'right' : tx < x + 70 ? 'left' : 'center';
        ctx.textBaseline = above ? 'bottom' : 'top';
        ctx.fillText(label, tx, above ? y - 9 : y + h + 9);
        ctx.restore();
    };
    if (g.best > 0)   tick(g.best, `YOUR BEST ${n(g.best)}${unit}`, theme.muted, true);
    if (g.record > 0) tick(g.record, `RECORD ${n(g.record)}${unit}`, GOLD, false);

    // This hunt: a diamond on the bar.
    const cx = at(g.value), cy = y + h / 2, r = 11;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = tierColor;
    ctx.stroke();
    ctx.restore();
}

function statTile(ctx, { label, value, accent, struck = false }, x, y, w, theme) {
    const h = 78;
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = theme.panel;
    ctx.fill();
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillStyle = theme.muted;
    ctx.fillText(fitText(ctx, label, w - 32), x + 16, y + 12);
    // Step the size down before truncating: the number is the point of the tile.
    let size = 30;
    ctx.font = `bold ${size}px ${FONT}`;
    while (size > 16 && ctx.measureText(value).width > w - 32) {
        size -= 2;
        ctx.font = `bold ${size}px ${FONT}`;
    }
    const vy = y + 34 + (30 - size) / 2;
    const text = fitText(ctx, value, w - 32);
    ctx.fillStyle = accent ?? '#ffffff';
    ctx.fillText(text, x + 16, vy);
    if (struck) {
        const tw = ctx.measureText(text).width;
        ctx.fillRect(x + 12, vy + size / 2, tw + 8, 3);
    }
    ctx.restore();
}

/**
 * @param {object} opts
 * @param {'hunt'|'fish'|'mine'|'explore'} opts.activity  picks the palette
 * @param {string}  opts.kicker                        e.g. "THESHIELD BAGGED"
 * @param {{name: string, iconId: ?string}} opts.subject
 * @param {number}  opts.tierNum                       1 common … 6 mythical
 * @param {?string} [opts.subtitle]                    drawn in the tier colour
 * @param {?{name: string, iconId: ?string}} [opts.place]  art faint behind, name bottom-right
 * @param {number}  opts.payout                        coins credited (0 when capped)
 * @param {?number} [opts.forfeited]                   what the daily cap withheld
 * @param {number}  opts.xp
 * @param {?{label: string, value: string}} [opts.extraStat]  the third tile
 * @param {?{best: number, record: number, value?: number, unit?: string, max?: number}} [opts.gauge]
 *        this payout against them — or, with `value`, whatever that measures
 *        (a fish's weight in `unit` lbs, on a bar `max` long)
 * @param {{text: string, tone?: string, color?: string}[]} [opts.badges]
 * @param {?{outcome: string, title: string, payout?: number, label?: string, detail?: string}} [opts.apex]
 *        the banner under the badges; `label` names it (default "APEX DUEL"),
 *        and `detail`, when given, is said on the right in place of the bonus
 * @returns {Promise<Buffer>} PNG
 */
async function createGrindResultCard(opts) {
    const theme = themeFor(opts.activity);
    const tierNum = Math.min(6, Math.max(1, opts.tierNum | 0 || 1));
    const tierColor = TIER_COLOR[tierNum];

    const tierPill = { text: `${TIER_WORD[tierNum]}  ${'★'.repeat(tierNum)}`, color: tierColor, tier: true };
    const badges = (opts.badges ?? [])
        .map(b => ({ text: plain(b.text), color: b.color ?? TONE[b.tone] ?? theme.muted }))
        .filter(b => b.text);

    // The tier leads the badge row, under the art as on the catch card; the
    // rest follow it and wrap onto further rows rather than being dropped.
    const measure = createCanvas(1, 1).getContext('2d');
    const rows = layoutBadges(measure, [tierPill, ...badges], 50, CARD_W - 100);
    const extraRows = Math.max(0, rows.length - 1);
    const apexY = BADGE_Y + rows.length * (BADGE_H + 10) + 6;
    const height = BASE_H + extraRows * (BADGE_H + 10) + (opts.apex ? APEX_H + 16 : 0);

    const canvas = createCanvas(CARD_W, height);
    const ctx = canvas.getContext('2d');
    paintBackground(ctx, CARD_W, height, theme);

    // The place, huge and faint behind the right-hand side — faint enough
    // that the text over it needs no scrim.
    const placeImg = await loadPlace(opts.place?.iconId);
    if (placeImg) {
        ctx.save();
        ctx.globalAlpha = 0.11;
        ctx.drawImage(placeImg, CARD_W - 470, -30, 500, 500);
        ctx.restore();
    }

    // The glow the animal stands in, in its tier's colour — hotter the rarer.
    const gx = ART_X + ART_SIZE / 2, gy = ART_Y + ART_SIZE / 2;
    const glow = ctx.createRadialGradient(gx, gy, 10, gx, gy, 300);
    glow.addColorStop(0, hexToRgba(tierColor, 0.35 + tierNum * 0.04));
    glow.addColorStop(0.55, hexToRgba(tierColor, 0.12));
    glow.addColorStop(1, hexToRgba(tierColor, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, CARD_W, height);

    ctx.save();
    ctx.beginPath();
    ctx.arc(gx, gy, ART_SIZE * 0.62, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = hexToRgba(tierColor, 0.8);
    ctx.stroke();
    ctx.restore();

    await drawEntry(ctx, { iconId: opts.subject.iconId, name: opts.subject.name, color: tierColor }, ART_X, ART_Y, ART_SIZE, theme);

    // Who, what, and the grade of it.
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `bold 18px ${FONT}`;
    ctx.fillStyle = theme.muted;
    ctx.fillText(fitText(ctx, plain(opts.kicker).toUpperCase(), PANEL_W), PANEL_X, 48);

    let nameSize = 50;
    ctx.font = `bold ${nameSize}px ${FONT}`;
    const name = plain(opts.subject.name);
    while (nameSize > 34 && ctx.measureText(name).width > PANEL_W) {
        nameSize -= 2;
        ctx.font = `bold ${nameSize}px ${FONT}`;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fitText(ctx, name, PANEL_W), PANEL_X, 74 + (50 - nameSize) / 2);

    if (opts.subtitle) {
        ctx.font = `bold 24px ${FONT}`;
        ctx.fillStyle = tierColor;
        ctx.fillText(fitText(ctx, plain(opts.subtitle), PANEL_W), PANEL_X, 136);
    }
    ctx.restore();

    const capped = opts.forfeited != null && !(opts.payout > 0);
    // A payout gauge (the default) has nothing to show when the cap took the
    // payout; a gauge with a value of its own measures that instead.
    const ownValue = opts.gauge?.value != null;
    const gaugeValue = ownValue ? opts.gauge.value : opts.payout;
    if (opts.gauge && (ownValue || !capped) && gaugeValue > 0
        && (opts.gauge.best > 0 || opts.gauge.record > 0 || opts.gauge.max > 0)) {
        drawPayoutGauge(ctx, { ...opts.gauge, value: gaugeValue }, PANEL_X, 206, PANEL_W, tierColor, theme);
    }

    // Stat tiles.
    const tiles = [
        capped
            ? { label: 'DAILY CAP', value: n(opts.forfeited), accent: '#8a8a8a', struck: true }
            : { label: 'COINS', value: `+${n(opts.payout)}`, accent: GOLD },
        { label: 'XP', value: `+${n(opts.xp)}` },
    ];
    if (opts.extraStat) tiles.push({ label: plain(opts.extraStat.label), value: plain(opts.extraStat.value), accent: tierColor });
    const gap = 14;
    const tileW = (PANEL_W - gap * (tiles.length - 1)) / tiles.length;
    tiles.forEach((t, i) => statTile(ctx, t, PANEL_X + i * (tileW + gap), 262, tileW, theme));

    // Badges, the tier first. The first row sits under the art as the catch
    // card's tier ribbon does.
    rows.forEach((row, r) => {
        for (const { x, badge } of row) {
            const y = BADGE_Y + r * (BADGE_H + 10);
            if (badge.tier) {
                pill(ctx, badge.text, x, y, badge.color, { fill: hexToRgba(badge.color, 0.35) });
            } else {
                pill(ctx, badge.text, x, y, badge.color);
            }
        }
    });

    // The duel, once it is over.
    if (opts.apex) {
        const color = APEX_COLOR[opts.apex.outcome] ?? theme.accent;
        const y = apexY;
        roundRect(ctx, 50, y, CARD_W - 100, APEX_H, 14);
        ctx.fillStyle = hexToRgba(color, 0.14);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.fillRect(50, y, 6, APEX_H);
        ctx.save();
        ctx.textBaseline = 'alphabetic';
        ctx.font = `bold 14px ${FONT}`;
        ctx.fillText(plain(opts.apex.label ?? 'APEX DUEL').toUpperCase(), 72, y + 24);
        ctx.font = `bold 20px ${FONT}`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(fitText(ctx, plain(opts.apex.title), CARD_W - 100 - 260), 72, y + 48);
        ctx.textAlign = 'right';
        const detail = opts.apex.detail != null ? plain(opts.apex.detail) : null;
        ctx.fillStyle = detail == null && opts.apex.payout > 0 ? GOLD : theme.muted;
        ctx.fillText(detail ?? (opts.apex.payout > 0 ? `+${n(opts.apex.payout)} coins` : 'no bonus'), CARD_W - 70, y + 40);
        ctx.restore();
    }

    // Where.
    if (opts.place?.name) {
        ctx.save();
        ctx.font = `16px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(fitText(ctx, plain(opts.place.name), 400), CARD_W - 24, height - 14);
        ctx.restore();
    }

    return encodeCanvas(canvas);
}

module.exports = { createGrindResultCard, TIER_COLOR, __test__: { plain, layoutBadges } };
