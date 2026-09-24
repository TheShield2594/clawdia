'use strict';

/**
 * The drawing primitives the casino's table renderers share: the palette, the
 * rounded rectangle, the label pill and the chip stack.
 *
 * They started in blackjackTable.js, and moved here when roulette grew a table
 * of its own, so the two games draw the same chip for the same stake and the
 * same pill for the same kind of label.
 *
 * @module games/casino/tableArt
 */

const FONT = '"DejaVu Sans", sans-serif';

const RED   = '#d0213a';
const BLACK = '#18181b';
const GOLD  = '#f4c542';

const TONES = {
    win:  { fill: '#1f9d55', text: '#ffffff' },
    lose: { fill: '#c62839', text: '#ffffff' },
    push: { fill: '#e0a526', text: '#1b1300' },
    gold: { fill: GOLD,      text: '#2a1d00' },
    info: { fill: 'rgba(0,0,0,0.55)', text: '#ffffff' },
};

/** Traces a rounded rectangle as the current path. */
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** A rounded label centred on (cx, cy), coloured by tone. */
function pill(ctx, text, cx, cy, tone = 'info', size = 18) {
    const { fill, text: ink } = TONES[tone] ?? TONES.info;
    ctx.save();
    ctx.font = `bold ${size}px ${FONT}`;
    const w = ctx.measureText(text).width + size * 1.4;
    const h = size * 1.75;
    roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h / 2);
    ctx.fillStyle = fill;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + 1);
    ctx.restore();
}

/** 950 → "950", 12_500 → "12.5K", 3_000_000 → "3M". */
function shortAmount(n) {
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [size, suffix] of units) {
        if (n >= size) {
            const v = n / size;
            return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${suffix}`;
        }
    }
    return `${n}`;
}

const CHIP_COLORS = [
    [1e6, '#1c1c1c', GOLD],
    [1e5, '#6d28d9', '#ffffff'],
    [1e4, '#111827', '#ffffff'],
    [1e3, '#15803d', '#ffffff'],
    [100, '#1d4ed8', '#ffffff'],
    [0,   '#b91c1c', '#ffffff'],
];

/** A short chip stack showing the stake, coloured by denomination. */
function drawChip(ctx, amount, cx, cy) {
    const [, body, ink] = CHIP_COLORS.find(([min]) => amount >= min);
    const r = 30;
    ctx.save();
    // A short stack under the top chip.
    for (let i = 2; i >= 1; i--) {
        ctx.beginPath();
        ctx.ellipse(cx, cy + i * 5, r, r * 0.92, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(cx, cy + i * 5 - 1, r, r * 0.92, 0, 0, Math.PI * 2);
        ctx.fillStyle = body;
        ctx.fill();
    }
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    // Edge inserts.
    ctx.strokeStyle = '#f5f5f4';
    ctx.lineWidth = 7;
    for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r - 3.5, a, a + 0.32);
        ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r - 10, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ink;
    const text = shortAmount(amount);
    ctx.font = `bold ${text.length > 4 ? 12 : 14}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + 1);
    ctx.restore();
}

module.exports = { FONT, RED, BLACK, GOLD, TONES, roundRect, pill, shortAmount, drawChip };
