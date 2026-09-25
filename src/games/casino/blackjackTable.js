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
const {
    FONT, RED, BLACK, GOLD, roundRect, pill, feltGrain, drawRail, drawBanner, shortAmount, drawChip,
} = require('./tableArt');

ensureFontsRegistered();

const W = 960;
const H = 560;
const CARD_W = 92;
const CARD_H = 128;

/**
 * @typedef {{ value: string, suit: string }} Card
 * @typedef {{ text: string, tone: keyof import('./tableArt').TONES }} Tag
 * @typedef {object} TableView
 * @property {{ cards: Card[], holeHidden: boolean, label: string, tone?: string }} dealer
 * @property {{ cards: Card[], label: string, bet: number, active?: boolean, tag?: ?Tag }[]} hands
 * @property {?Tag} [banner]   the round's result, drawn across the middle of the felt
 */

// ── Suits ────────────────────────────────────────────────────────────────────
// Each is drawn centred on (x, y) inside a box roughly `s` tall.

/** Traces a heart, which the spade reuses upside down. */
function heartPath(ctx, x, y, s) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.42);
    ctx.bezierCurveTo(x - s * 0.08, y + s * 0.32, x - s * 0.5, y + s * 0.05, x - s * 0.5, y - s * 0.17);
    ctx.bezierCurveTo(x - s * 0.5, y - s * 0.42, x - s * 0.12, y - s * 0.5, x, y - s * 0.24);
    ctx.bezierCurveTo(x + s * 0.12, y - s * 0.5, x + s * 0.5, y - s * 0.42, x + s * 0.5, y - s * 0.17);
    ctx.bezierCurveTo(x + s * 0.5, y + s * 0.05, x + s * 0.08, y + s * 0.32, x, y + s * 0.42);
    ctx.closePath();
}

/** Draws one suit symbol as a vector shape in its colour. */
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

/** The flared stem under a spade or a club. */
function stem(ctx, x, y, s) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.1);
    ctx.quadraticCurveTo(x + s * 0.06, y + s * 0.4, x + s * 0.2, y + s * 0.5);
    ctx.lineTo(x - s * 0.2, y + s * 0.5);
    ctx.quadraticCurveTo(x - s * 0.06, y + s * 0.4, x, y + s * 0.1);
    ctx.fill();
}

// ── Cards ────────────────────────────────────────────────────────────────────

/** The drop shadow every card casts on the felt. */
function cardShadow(ctx) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 4;
}

/** A face-up card: corner indices, and a large pip or a framed court letter in the middle. */
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

/** The dealer's face-down hole card. */
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

// ── The felt and the banner ──────────────────────────────────────────────────

/** The table itself: felt, grain, the printed arc and the rail. */
function drawFelt(ctx) {
    const g = ctx.createRadialGradient(W / 2, H * 0.42, 60, W / 2, H * 0.5, W * 0.72);
    g.addColorStop(0, '#23895a');
    g.addColorStop(0.6, '#15603d');
    g.addColorStop(1, '#0a3522');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    feltGrain(ctx, W, H);

    // The printed arc and the table's rules, the way a real layout carries them.
    ctx.save();
    ctx.strokeStyle = 'rgba(244,197,66,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(W / 2, 40, W * 0.47, 275, 0, Math.PI * 0.14, Math.PI * 0.86);
    ctx.stroke();
    ctx.restore();

    drawRail(ctx, W, H);
}

/** The payout rules printed on the felt, shown while no result banner covers them. */
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

/** Draws a fanned hand and returns where it landed, for the chip and highlight around it. */
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
    if (view.banner) drawBanner(ctx, view.banner, W / 2, 250, W - 120);
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
