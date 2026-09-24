'use strict';

/**
 * Draws the blackjack table: felt, rail, the dealer's cards, the player's hand
 * or split hands, a chip for each stake and a banner for the result.
 *
 * Every card is drawn from primitives — the suits are vector paths, not font
 * glyphs — because suit glyphs are exactly what the text table got wrong: ♥
 * renders as a full-width emoji on some clients and breaks every box around
 * it. Only the ranks and labels need a font, and those fall back cleanly.
 *
 * `renderTable` takes a plain view of the table (see the typedef) rather than
 * the game's state, so it can be drawn and looked at without playing a hand.
 * It resolves to a PNG buffer; the encode runs off the event loop.
 *
 * @module games/casino/blackjackTable
 */

const { createCanvas } = require('canvas');
const { ensureFontsRegistered } = require('../../utils/registerFonts');
const { encodeCanvas } = require('../../utils/canvasEncode');

ensureFontsRegistered();

const W = 960;
const H = 560;
const CARD_W = 92;
const CARD_H = 128;
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

/**
 * @typedef {{ value: string, suit: string }} Card
 * @typedef {{ text: string, tone: keyof TONES }} Tag
 * @typedef {object} TableView
 * @property {{ cards: Card[], holeHidden: boolean, label: string, tone?: string }} dealer
 * @property {{ cards: Card[], label: string, bet: number, active?: boolean, tag?: ?Tag }[]} hands
 * @property {?Tag} [banner]   the round's result, drawn across the middle of the felt
 */

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// ── Suits ────────────────────────────────────────────────────────────────────
// Each is drawn centred on (x, y) inside a box roughly `s` tall.

function heartPath(ctx, x, y, s) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.42);
    ctx.bezierCurveTo(x - s * 0.08, y + s * 0.32, x - s * 0.5, y + s * 0.05, x - s * 0.5, y - s * 0.17);
    ctx.bezierCurveTo(x - s * 0.5, y - s * 0.42, x - s * 0.12, y - s * 0.5, x, y - s * 0.24);
    ctx.bezierCurveTo(x + s * 0.12, y - s * 0.5, x + s * 0.5, y - s * 0.42, x + s * 0.5, y - s * 0.17);
    ctx.bezierCurveTo(x + s * 0.5, y + s * 0.05, x + s * 0.08, y + s * 0.32, x, y + s * 0.42);
    ctx.closePath();
}

function drawSuit(ctx, suit, x, y, s) {
    ctx.save();
    ctx.fillStyle = suit === '♥' || suit === '♦' ? RED : BLACK;
    if (suit === '♥') {
        heartPath(ctx, x, y, s);
        ctx.fill();
    } else if (suit === '♦') {
        ctx.beginPath();
        ctx.moveTo(x, y - s * 0.5);
        ctx.quadraticCurveTo(x + s * 0.18, y - s * 0.18, x + s * 0.38, y);
        ctx.quadraticCurveTo(x + s * 0.18, y + s * 0.18, x, y + s * 0.5);
        ctx.quadraticCurveTo(x - s * 0.18, y + s * 0.18, x - s * 0.38, y);
        ctx.quadraticCurveTo(x - s * 0.18, y - s * 0.18, x, y - s * 0.5);
        ctx.fill();
    } else if (suit === '♠') {
        // An upside-down heart, nudged up to leave room for the stem.
        ctx.save();
        ctx.translate(x, y - s * 0.08);
        ctx.rotate(Math.PI);
        heartPath(ctx, 0, 0, s * 0.9);
        ctx.fill();
        ctx.restore();
        stem(ctx, x, y, s);
    } else {
        const r = s * 0.2;
        for (const [dx, dy] of [[0, -0.24], [-0.23, 0.07], [0.23, 0.07]]) {
            ctx.beginPath();
            ctx.arc(x + dx * s, y + dy * s, r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.fillRect(x - s * 0.05, y - s * 0.05, s * 0.1, s * 0.2);
        stem(ctx, x, y, s);
    }
    ctx.restore();
}

function stem(ctx, x, y, s) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.1);
    ctx.quadraticCurveTo(x + s * 0.06, y + s * 0.4, x + s * 0.2, y + s * 0.5);
    ctx.lineTo(x - s * 0.2, y + s * 0.5);
    ctx.quadraticCurveTo(x - s * 0.06, y + s * 0.4, x, y + s * 0.1);
    ctx.fill();
}

// ── Cards ────────────────────────────────────────────────────────────────────

function cardShadow(ctx) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 4;
}

function drawCardFace(ctx, card, x, y) {
    ctx.save();
    cardShadow(ctx);
    roundRect(ctx, x, y, CARD_W, CARD_H, 9);
    ctx.fillStyle = '#fbfaf5';
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRect(ctx, x + 0.5, y + 0.5, CARD_W - 1, CARD_H - 1, 9);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const color = card.suit === '♥' || card.suit === '♦' ? RED : BLACK;
    const corner = (cx, cy) => {
        ctx.fillStyle = color;
        ctx.font = `bold ${card.value === '10' ? 18 : 22}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(card.value, cx, cy);
        drawSuit(ctx, card.suit, cx, cy + 13, 13);
    };
    corner(x + 14, y + 25);
    ctx.save();
    ctx.translate(x + CARD_W, y + CARD_H);
    ctx.rotate(Math.PI);
    corner(14, 25);
    ctx.restore();

    const mx = x + CARD_W / 2;
    const my = y + CARD_H / 2;
    if (['J', 'Q', 'K'].includes(card.value)) {
        roundRect(ctx, x + 26, y + 16, CARD_W - 52, CARD_H - 32, 5);
        ctx.fillStyle = color === RED ? 'rgba(208,33,58,0.08)' : 'rgba(24,24,27,0.07)';
        ctx.fill();
        ctx.strokeStyle = color === RED ? 'rgba(208,33,58,0.45)' : 'rgba(24,24,27,0.4)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = `bold 34px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(card.value, mx, my - 12);
        drawSuit(ctx, card.suit, mx, my + 20, 20);
    } else if (card.value === 'A') {
        drawSuit(ctx, card.suit, mx, my, 50);
    } else {
        drawSuit(ctx, card.suit, mx, my, 38);
    }
    ctx.restore();
}

function drawCardBack(ctx, x, y) {
    ctx.save();
    cardShadow(ctx);
    roundRect(ctx, x, y, CARD_W, CARD_H, 9);
    ctx.fillStyle = '#fbfaf5';
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRect(ctx, x + 6, y + 6, CARD_W - 12, CARD_H - 12, 6);
    ctx.fillStyle = '#9e1b32';
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    for (let d = -CARD_H; d < CARD_W + CARD_H; d += 10) {
        ctx.beginPath();
        ctx.moveTo(x + d, y);
        ctx.lineTo(x + d + CARD_H, y + CARD_H);
        ctx.moveTo(x + d + CARD_H, y);
        ctx.lineTo(x + d, y + CARD_H);
        ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    roundRect(ctx, x + 6, y + 6, CARD_W - 12, CARD_H - 12, 6);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
}

/** The x of each card in a fanned group, centred on `cx`, never wider than `maxW`. */
function fanPositions(count, cx, maxW) {
    const natural = CARD_W + 14;
    const step = count > 1 ? Math.min(natural, (maxW - CARD_W) / (count - 1)) : 0;
    const width = CARD_W + step * (count - 1);
    const left = cx - width / 2;
    return { xs: Array.from({ length: count }, (_, i) => left + i * step), left, width };
}

// ── Labels, chips and banners ────────────────────────────────────────────────

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

function drawFelt(ctx) {
    const g = ctx.createRadialGradient(W / 2, H * 0.42, 60, W / 2, H * 0.5, W * 0.72);
    g.addColorStop(0, '#23895a');
    g.addColorStop(0.6, '#15603d');
    g.addColorStop(1, '#0a3522');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Felt grain: a faint diagonal weave, deterministic so frames do not shimmer.
    ctx.save();
    ctx.globalAlpha = 0.035;
    ctx.strokeStyle = '#ffffff';
    for (let d = -H; d < W; d += 6) {
        ctx.beginPath();
        ctx.moveTo(d, 0);
        ctx.lineTo(d + H, H);
        ctx.stroke();
    }
    ctx.restore();

    // The printed arc and the table's rules, the way a real layout carries them.
    ctx.save();
    ctx.strokeStyle = 'rgba(244,197,66,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(W / 2, 40, W * 0.47, 275, 0, Math.PI * 0.14, Math.PI * 0.86);
    ctx.stroke();
    ctx.restore();

    // The rail.
    ctx.save();
    roundRect(ctx, 7, 7, W - 14, H - 14, 26);
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#4a2a14';
    ctx.stroke();
    roundRect(ctx, 14, 14, W - 28, H - 28, 20);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,214,150,0.35)';
    ctx.stroke();
    ctx.restore();
}

function drawRulesPrint(ctx) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(244,197,66,0.6)';
    ctx.font = `bold 22px ${FONT}`;
    ctx.fillText('BLACKJACK PAYS 3 TO 2', W / 2, 238);
    ctx.fillStyle = 'rgba(244,197,66,0.42)';
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillText('DEALER STANDS ON SOFT 17  ·  INSURANCE PAYS 2 TO 1', W / 2, 264);
    ctx.restore();
}

function drawBanner(ctx, banner) {
    const { fill } = TONES[banner.tone] ?? TONES.info;
    ctx.save();
    ctx.font = `bold 38px ${FONT}`;
    const w = Math.min(W - 120, ctx.measureText(banner.text).width + 80);
    const h = 60;
    const x = W / 2 - w / 2;
    const y = 250 - h / 2;
    ctx.shadowColor = fill;
    ctx.shadowBlur = 28;
    roundRect(ctx, x, y, w, h, 14);
    ctx.fillStyle = 'rgba(8,20,14,0.82)';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = fill;
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(banner.text, W / 2, 252, w - 40);
    ctx.restore();
}

function drawGroup(ctx, cards, cx, top, maxW, holeHidden = false) {
    const { xs, left, width } = fanPositions(cards.length, cx, maxW);
    cards.forEach((card, i) => {
        if (holeHidden && i === 1) drawCardBack(ctx, xs[i], top);
        else drawCardFace(ctx, card, xs[i], top);
    });
    return { left, width };
}

/**
 * Draws the table and encodes it.
 *
 * @param {TableView} view
 * @returns {Promise<Buffer>} a PNG
 */
async function renderTable(view) {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    drawFelt(ctx);
    if (view.banner) drawBanner(ctx, view.banner);
    else drawRulesPrint(ctx);

    // Dealer.
    const dealerTop = 62;
    drawGroup(ctx, view.dealer.cards, W / 2, dealerTop, 560, view.dealer.holeHidden);
    pill(ctx, `DEALER · ${view.dealer.label.toUpperCase()}`, W / 2, 36, view.dealer.tone ?? 'info');

    // Player.
    const hands = view.hands;
    const playerTop = 330;
    const split = hands.length > 1;
    const centres = split ? [W * 0.29, W * 0.71] : [W / 2];
    const groupW = split ? 330 : 520;
    hands.forEach((hand, i) => {
        const cx = centres[i];
        const { left, width } = fanPositions(hand.cards.length, cx, groupW);
        if (hand.active && split) {
            ctx.save();
            ctx.shadowColor = GOLD;
            ctx.shadowBlur = 22;
            roundRect(ctx, left - 10, playerTop - 10, width + 20, CARD_H + 20, 14);
            ctx.lineWidth = 3;
            ctx.strokeStyle = GOLD;
            ctx.stroke();
            ctx.restore();
        }
        drawGroup(ctx, hand.cards, cx, playerTop, groupW);
        drawChip(ctx, hand.bet, left - 44, playerTop + CARD_H - 34);
        const name = split ? `HAND ${i + 1}` : 'YOU';
        pill(ctx, `${name} · ${hand.label.toUpperCase()}`, cx, playerTop + CARD_H + 32, hand.active && split ? 'gold' : 'info');
        if (hand.tag) pill(ctx, hand.tag.text, cx, playerTop - 24, hand.tag.tone, 16);
    });

    return encodeCanvas(canvas);
}

module.exports = { renderTable, shortAmount, W, H };
