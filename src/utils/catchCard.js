'use strict';

/**
 * The catch card: the picture a `/fish cast` result carries as its embed image.
 *
 * The fish's art on a glow in its tier's colour, its name and size, a gauge of
 * where its weight falls in its species' range with the player's old best and
 * the server record marked on it, the payout and XP, and a row of badges for
 * whatever the catch set off — a new species, a personal best, a server record.
 *
 * Like the other cards (utils/grindProfileCard.js, whose palette and drawing
 * primitives this uses), it is an illustration: every number on it is also in
 * the embed text, the caller gives the attachment alt text, and nothing here
 * draws a currency symbol, since a guild's currency can be a custom emoji that
 * a canvas cannot draw.
 *
 * @module utils/catchCard
 */

const { createCanvas } = require('canvas');
const { encodeCanvas } = require('./canvasEncode');
const { primitives } = require('./grindProfileCard');

const { FONT, themeFor, paintBackground, drawEntry, roundRect, fitText, shade } = primitives;

const CARD_W = 1000;
const CARD_H = 440;

const ART_SIZE = 250;
const ART_X = 85;
const ART_Y = 70;

const PANEL_X = 400;
const PANEL_W = CARD_W - PANEL_X - 50;

function hexToRgba(hex, alpha) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    if (!Number.isFinite(n)) return `rgba(255,255,255,${alpha})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function pill(ctx, text, x, y, color, { font = `bold 18px ${FONT}`, padX = 14, h = 34, fill = null } = {}) {
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

// The weight gauge: the species' whole range, the catch's place on it, and the
// player's previous best and the server record as ticks above it.
function drawWeightGauge(ctx, g, x, y, w, tierColor, theme) {
    const h = 14;
    const span = Math.max(1e-6, g.max - g.min);
    const at = v => x + Math.max(0, Math.min(1, (v - g.min) / span)) * w;

    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fill();

    const fillW = Math.max(h, at(g.weight) - x);
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
        ctx.textAlign = tx > x + w - 60 ? 'right' : tx < x + 60 ? 'left' : 'center';
        ctx.textBaseline = above ? 'bottom' : 'top';
        ctx.fillText(label, tx, above ? y - 9 : y + h + 9);
        ctx.restore();
    };

    const lbs = v => `${Number(v).toLocaleString('en-US')} lbs`;
    if (g.previousBest > 0) tick(g.previousBest, `YOUR BEST ${lbs(g.previousBest)}`, theme.muted, true);
    if (g.record > 0)       tick(g.record, `RECORD ${lbs(g.record)}`, '#ffd166', false);

    // The catch itself: a diamond on the bar.
    const cx = at(g.weight), cy = y + h / 2, r = 11;
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

function statTile(ctx, label, value, x, y, w, theme, accent) {
    const h = 78;
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = theme.panel;
    ctx.fill();
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillStyle = theme.muted;
    ctx.fillText(label, x + 16, y + 12);
    // Step the size down before truncating: a payout is the number that matters.
    let size = 30;
    ctx.font = `bold ${size}px ${FONT}`;
    while (size > 18 && ctx.measureText(value).width > w - 32) {
        size -= 2;
        ctx.font = `bold ${size}px ${FONT}`;
    }
    ctx.fillStyle = accent ?? '#ffffff';
    ctx.fillText(fitText(ctx, value, w - 32), x + 16, y + 34 + (30 - size) / 2);
    ctx.restore();
}

/**
 * @param {object} opts
 * @param {string} opts.angler            display name, drawn as "<NAME> LANDED"
 * @param {{name: string, iconId: ?string}} opts.fish
 * @param {string} opts.tierLabel         e.g. "Legendary"
 * @param {string} opts.tierStars         e.g. "★★★★★"
 * @param {string} opts.tierColor         #rrggbb
 * @param {?string} opts.sizeLabel        e.g. "Trophy"
 * @param {number} opts.weight            lbs; 0 for a fish that is not weighed
 * @param {?{min: number, max: number, previousBest: number, record: number}} opts.gauge
 * @param {number} opts.payout            coins, drawn without a symbol
 * @param {number} opts.xp
 * @param {?{label: string, value: string}} opts.extraStat  a third tile (crit, streak)
 * @param {{text: string, color: string}[]} opts.badges
 * @param {string} opts.place             where it was caught
 * @returns {Promise<Buffer>} PNG
 */
async function createCatchCard(opts) {
    const theme = themeFor('fish');
    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext('2d');
    const tierColor = opts.tierColor ?? theme.accent;

    paintBackground(ctx, CARD_W, CARD_H, theme);

    // The glow the fish sits in, in its tier's colour.
    const gx = ART_X + ART_SIZE / 2, gy = ART_Y + ART_SIZE / 2;
    const glow = ctx.createRadialGradient(gx, gy, 10, gx, gy, 300);
    glow.addColorStop(0, hexToRgba(tierColor, 0.55));
    glow.addColorStop(0.55, hexToRgba(tierColor, 0.12));
    glow.addColorStop(1, hexToRgba(tierColor, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    ctx.save();
    ctx.beginPath();
    ctx.arc(gx, gy, ART_SIZE * 0.62, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = hexToRgba(tierColor, 0.8);
    ctx.stroke();
    ctx.restore();

    await drawEntry(ctx, { iconId: opts.fish.iconId, name: opts.fish.name, color: tierColor }, ART_X, ART_Y, ART_SIZE, theme);

    // Tier ribbon under the art.
    ctx.save();
    ctx.font = `bold 20px ${FONT}`;
    const ribbon = `${opts.tierLabel.toUpperCase()}  ${opts.tierStars ?? ''}`.trim();
    const rw = ctx.measureText(ribbon).width + 40;
    ctx.restore();
    pill(ctx, ribbon, gx - rw / 2, ART_Y + ART_SIZE + 38, tierColor, { font: `bold 20px ${FONT}`, padX: 20, h: 40, fill: hexToRgba(tierColor, 0.35) });

    // Right panel: who, what, how big.
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `bold 18px ${FONT}`;
    ctx.fillStyle = theme.muted;
    ctx.fillText(fitText(ctx, `${String(opts.angler ?? '').toUpperCase()} LANDED`, PANEL_W), PANEL_X, 48);

    ctx.font = `bold 50px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fitText(ctx, opts.fish.name, PANEL_W), PANEL_X, 74);

    ctx.font = `bold 24px ${FONT}`;
    ctx.fillStyle = tierColor;
    const sizeLine = opts.weight > 0
        ? `${opts.sizeLabel ? `${opts.sizeLabel} · ` : ''}${opts.weight.toLocaleString('en-US')} lbs`
        : (opts.sizeLabel ?? 'Too strange to weigh');
    ctx.fillText(fitText(ctx, sizeLine, PANEL_W), PANEL_X, 136);
    ctx.restore();

    if (opts.gauge && opts.weight > 0) {
        drawWeightGauge(ctx, { ...opts.gauge, weight: opts.weight }, PANEL_X, 206, PANEL_W, tierColor, theme);
    }

    // Stat tiles.
    const tiles = [
        { label: 'COINS', value: `+${Number(opts.payout ?? 0).toLocaleString('en-US')}`, accent: '#ffd166' },
        { label: 'XP', value: `+${Number(opts.xp ?? 0).toLocaleString('en-US')}` },
    ];
    if (opts.extraStat) tiles.push({ ...opts.extraStat, accent: tierColor });
    const gap = 14;
    const tileW = (PANEL_W - gap * (tiles.length - 1)) / tiles.length;
    tiles.forEach((t, i) => statTile(ctx, t.label, t.value, PANEL_X + i * (tileW + gap), 262, tileW, theme, t.accent));

    // Badges.
    let bx = PANEL_X;
    for (const b of (opts.badges ?? []).slice(0, 4)) {
        ctx.save();
        ctx.font = `bold 16px ${FONT}`;
        const w = ctx.measureText(b.text).width + 28;
        ctx.restore();
        if (bx + w > PANEL_X + PANEL_W) break;
        pill(ctx, b.text, bx, 362, b.color, { font: `bold 16px ${FONT}`, h: 32 });
        bx += w + 10;
    }

    // Where.
    ctx.save();
    ctx.font = `16px ${FONT}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(fitText(ctx, opts.place ?? '', 400), CARD_W - 24, CARD_H - 14);
    ctx.restore();

    return encodeCanvas(canvas);
}

module.exports = { createCatchCard, CARD_W, CARD_H };
