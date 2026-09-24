'use strict';

/**
 * The slots paytable, as one image.
 *
 * Every figure on it comes from slotsReels — the rows, the odds, the return —
 * so a paytable change moves the picture with it; nothing here is typed out
 * twice. The symbols are Twemoji (src/assets/slot-symbols), the same art
 * Discord draws on the reels, so the card and the machine show one set.
 *
 * The paytable is the same for every player and every spin, so it is drawn
 * once per process and the PNG kept. `slots.js` falls back to its text embed if
 * the render ever fails, and gives the attachment alt text carrying the rows.
 *
 * @module games/casino/slotsPaytableCard
 */

const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const { ensureFontsRegistered } = require('../../utils/registerFonts');
const { encodeCanvas } = require('../../utils/canvasEncode');
const {
    SYMBOLS, HEAT_MAX, TRIPLE_WILD_MULT, TRIPLE_BOOST_MULT, FREE_SPINS,
    LUCKY_CHARM_RESPIN, LUCKY_STREAK_REFUND, PROGRESSIVE_RETURN, JACKPOT_CAP_MULT, odds,
} = require('./slotsReels');
const { RANDOM_DROP_RETURN } = require('../../services/casinoJackpotService');
const { LUCKY_SAVE_MAX_BET } = require('../../services/effectsService');

ensureFontsRegistered();

const FONT = '"DejaVu Sans"';
const ART  = path.join(__dirname, '..', '..', 'assets', 'slot-symbols');

const W = 1600;
const H = 1000;
const PAD = 56;

const C = {
    bgTop:    '#1c1538',
    bgBottom: '#0a0714',
    panel:    'rgba(255,255,255,0.045)',
    rule:     'rgba(255,255,255,0.08)',
    text:     '#f4f1ff',
    muted:    '#a79fc9',
    faint:    '#6f6893',
    gold:     '#ffcf5a',
    accent:   '#8b7cff',
    jackpotA: '#7b2ff7',
    jackpotB: '#f107a3',
};

const ICON = {
    Cherry: 'cherry', Lemon: 'lemon', Grape: 'grape', Bell: 'bell', Diamond: 'diamond',
    Star: 'star', Wild: 'wild', Boost: 'boost', Scatter: 'scatter',
};

const art = new Map();
async function icon(name) {
    if (!art.has(name)) art.set(name, loadImage(path.join(ART, `${name}.png`)));
    return art.get(name);
}

const fmt = n => Math.round(n).toLocaleString('en-US');
const pct = x => `${(x * 100).toFixed(1)}%`;

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function panel(ctx, x, y, w, h, fill = C.panel) {
    roundRect(ctx, x, y, w, h, 18);
    ctx.fillStyle = fill;
    ctx.fill();
}

function text(ctx, str, x, y, { size = 20, weight = 'normal', color = C.text, align = 'left', spacing = 0 } = {}) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    if (!spacing) { ctx.fillText(str, x, y); return ctx.measureText(str).width; }
    // Letter-spaced caps for the small labels; canvas has no letterSpacing here.
    const chars = [...str];
    const width = chars.reduce((sum, ch) => sum + ctx.measureText(ch).width + spacing, -spacing);
    let cx = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    ctx.textAlign = 'left';
    for (const ch of chars) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + spacing; }
    return width;
}

/** Wraps `str` into lines no wider than `maxWidth`, drawn from (x, y). Returns the y after it. */
function paragraph(ctx, str, x, y, maxWidth, { size = 19, color = C.muted, lineHeight = 1.4 } = {}) {
    ctx.font = `normal ${size}px ${FONT}`;
    const words = str.split(' ');
    let line = '';
    for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (ctx.measureText(next).width > maxWidth && line) {
            text(ctx, line, x, y, { size, color });
            line = word;
            y += size * lineHeight;
        } else {
            line = next;
        }
    }
    if (line) text(ctx, line, x, y, { size, color });
    return y + size * lineHeight;
}

async function symbols(ctx, names, x, y, size, gap = 8) {
    for (const [i, name] of names.entries()) {
        if (!name) continue;
        ctx.drawImage(await icon(name), x + i * (size + gap), y, size, size);
    }
}

// ─── Sections ────────────────────────────────────────────────────────────────

async function header(ctx, o) {
    ctx.drawImage(await icon('slots'), PAD, 40, 76, 76);
    text(ctx, 'SLOTS', PAD + 96, 92, { size: 50, weight: 'bold', spacing: 6 });
    text(ctx, 'PAYTABLE  ·  PAYS ON THE MIDDLE LINE',
        PAD + 98, 124, { size: 16, color: C.muted, spacing: 1.5 });

    // The three figures a player asks first, top right.
    const stats = [
        [pct(o.reelReturn + PROGRESSIVE_RETURN + RANDOM_DROP_RETURN), 'RETURN TO PLAYER'],
        [pct(o.hitRate), 'SPINS WITH A LINE WIN'],
        [`1 in ${fmt(1 / o.freeSpinRate)}`, 'SPINS TRIGGER FREE SPINS'],
    ];
    let x = W - PAD;
    for (const [value, label] of [...stats].reverse()) {
        ctx.font = `bold 34px ${FONT}`;
        const w = Math.max(ctx.measureText(value).width, 200) + 44;
        panel(ctx, x - w, 36, w, 92);
        text(ctx, value, x - w / 2, 84, { size: 34, weight: 'bold', color: C.gold, align: 'center' });
        text(ctx, label, x - w / 2, 110, { size: 12, color: C.muted, align: 'center', spacing: 1.2 });
        x -= w + 14;
    }
}

async function lineWins(ctx, o) {
    const x = PAD, y = 160, w = 820, h = H - y - 70;
    panel(ctx, x, y, w, h);
    text(ctx, 'LINE WINS', x + 32, y + 46, { size: 16, weight: 'bold', color: C.accent, spacing: 2 });
    text(ctx, 'PAYS', x + w - 196, y + 46, { size: 13, color: C.faint, align: 'right', spacing: 1.5 });
    text(ctx, 'ODDS', x + w - 32, y + 46, { size: 13, color: C.faint, align: 'right', spacing: 1.5 });

    const oneIn = key => `1 in ${fmt(1 / o.lines.get(key))}`;
    const iconSize = 46;
    let ry = y + 70;

    // Triple Wild: the jackpot row, on its own band.
    const band = ctx.createLinearGradient(x + 16, 0, x + w - 16, 0);
    band.addColorStop(0, 'rgba(123,47,247,0.45)');
    band.addColorStop(1, 'rgba(241,7,163,0.30)');
    roundRect(ctx, x + 16, ry, w - 32, 78, 14);
    ctx.fillStyle = band;
    ctx.fill();
    await symbols(ctx, ['wild', 'wild', 'wild'], x + 34, ry + 16, iconSize);
    text(ctx, 'JACKPOT', x + 220, ry + 32, { size: 14, weight: 'bold', color: '#ffd6f3', spacing: 2 });
    text(ctx, `+ the pot, up to ${JACKPOT_CAP_MULT}× the bet`, x + 220, ry + 58, { size: 17, color: C.text });
    text(ctx, `${TRIPLE_WILD_MULT}×`, x + w - 196, ry + 52, { size: 34, weight: 'bold', color: C.gold, align: 'right' });
    text(ctx, oneIn('jackpot'), x + w - 32, ry + 50, { size: 17, color: C.muted, align: 'right' });
    ry += 92;

    const rows = [
        { icons: ['boost', 'boost', 'boost'], pays: TRIPLE_BOOST_MULT, key: 'mult3', note: 'Wilds count' },
        ...SYMBOLS.filter(s => s.type === 'regular').reverse()
            .map(s => ({ icons: Array(3).fill(ICON[s.name]), pays: s.three, key: `three:${s.name}` })),
    ];
    const pairs = SYMBOLS.filter(s => s.type === 'regular' && s.pair > 0).reverse()
        .map(s => ({ icons: [ICON[s.name], ICON[s.name]], pays: s.pair, key: `pair:${s.name}` }));

    const rowH = 50;
    const drawRow = async (row, i) => {
        if (i % 2 === 0) { roundRect(ctx, x + 16, ry - 4, w - 32, rowH, 10); ctx.fillStyle = 'rgba(255,255,255,0.025)'; ctx.fill(); }
        await symbols(ctx, row.icons, x + 34, ry + 2, 40, 10);
        if (row.note) text(ctx, row.note, x + 220, ry + 29, { size: 16, color: C.faint });
        text(ctx, `${row.pays}×`, x + w - 196, ry + 31, { size: 26, weight: 'bold', color: C.gold, align: 'right' });
        text(ctx, oneIn(row.key), x + w - 32, ry + 30, { size: 17, color: C.muted, align: 'right' });
        ry += rowH;
    };
    for (const [i, row] of rows.entries()) await drawRow(row, i);

    ry += 14;
    ctx.fillStyle = C.rule;
    ctx.fillRect(x + 32, ry, w - 64, 1);
    ry += 30;
    text(ctx, 'PAIRS', x + 32, ry, { size: 13, weight: 'bold', color: C.accent, spacing: 2 });
    text(ctx, 'any two on the line, a Wild counting as either', x + 110, ry, { size: 15, color: C.faint });
    ry += 16;
    for (const [i, row] of pairs.entries()) await drawRow(row, i + 1);
}

async function features(ctx) {
    const x = PAD + 820 + 28, w = W - PAD - x;
    let y = 160;
    const iconSize = 52;

    const cards = [
        { icon: 'wild', title: 'WILD', body: 'Stands in for any symbol except the Scatter, and the line is read the way that pays best.' },
        { icon: 'boost', title: 'BOOST', body: 'Every Boost on the line doubles a line win: one is ×2, two are ×4.' },
        {
            icon: 'scatter', title: 'FREE SPINS',
            body: `Two Scatters anywhere in the window: ${FREE_SPINS[2].spins} free spins. Three: ${FREE_SPINS[3].spins} free spins at ${FREE_SPINS[3].mult}×. Paid on top of the line.`,
        },
        {
            icon: 'fire', title: 'HEAT METER',
            body: `Every paid spin adds one. At ${HEAT_MAX}, your next spin is a Hot Spin: reel 1 lands a Bell, Diamond or Star.`,
            extra: ['bell', 'diamond', 'star'],
        },
        {
            icon: 'clover', title: 'LUCK ITEMS',
            body: `Lucky Charm re-spins ${pct(LUCKY_CHARM_RESPIN)} of losing spins, Lucky Streak refunds ${pct(LUCKY_STREAK_REFUND)}, on bets up to ${fmt(LUCKY_SAVE_MAX_BET)}. Coin boosters don't apply.`,
        },
    ];

    const gap = 14;
    const cardH = Math.floor((H - 70 - y - gap * (cards.length - 1)) / cards.length);
    for (const card of cards) {
        panel(ctx, x, y, w, cardH);
        ctx.drawImage(await icon(card.icon), x + 24, y + (cardH - iconSize) / 2, iconSize, iconSize);
        const titleW = text(ctx, card.title, x + 100, y + 38, { size: 15, weight: 'bold', color: C.accent, spacing: 2 });
        // Small symbols set beside the title rather than over the body text.
        if (card.extra) await symbols(ctx, card.extra, x + 100 + titleW + 14, y + 18, 26, 4);
        paragraph(ctx, card.body, x + 100, y + 66, w - 124, { size: 17 });
        y += cardH + gap;
    }
}

function footer(ctx, o) {
    const y = H - 30;
    text(ctx, `Return: ${pct(o.reelReturn)} from the reels and features, up to ${pct(PROGRESSIVE_RETURN)} from Triple Wild pots and ${pct(RANDOM_DROP_RETURN)} from random pool drops. Every line win pays more than the bet.`,
        PAD, y, { size: 14, color: C.faint });
    text(ctx, 'Symbols: Twemoji, CC-BY 4.0', W - PAD, y, { size: 12, color: C.faint, align: 'right' });
}

// ─── The card ────────────────────────────────────────────────────────────────

async function drawPaytable() {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, C.bgTop);
    bg.addColorStop(1, C.bgBottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    // A faint glow behind the title, so the top reads as the top.
    const glow = ctx.createRadialGradient(280, 60, 0, 280, 60, 520);
    glow.addColorStop(0, 'rgba(139,124,255,0.22)');
    glow.addColorStop(1, 'rgba(139,124,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    const o = odds();
    await header(ctx, o);
    await lineWins(ctx, o);
    await features(ctx);
    footer(ctx, o);
    return encodeCanvas(canvas);
}

let rendered = null;

/**
 * The paytable PNG. Drawn once per process; concurrent first calls share the
 * one render, and a failed render is not cached, so the next press retries.
 *
 * @returns {Promise<Buffer>}
 */
function paytableImage() {
    if (!rendered) rendered = drawPaytable().catch(err => { rendered = null; throw err; });
    return rendered;
}

/** Alt text for the attachment: the rows, for anyone the picture does not reach. */
function paytableAltText() {
    const regular = SYMBOLS.filter(s => s.type === 'regular').reverse();
    return [
        `Slots paytable. Triple Wild ${TRIPLE_WILD_MULT}x plus the progressive pot up to ${JACKPOT_CAP_MULT}x the bet.`,
        `Triple Boost ${TRIPLE_BOOST_MULT}x.`,
        ...regular.map(s => `Three ${s.plural} ${s.three}x.`),
        ...regular.filter(s => s.pair).map(s => `Pair of ${s.plural} ${s.pair}x.`),
        `Two Scatters give ${FREE_SPINS[2].spins} free spins, three give ${FREE_SPINS[3].spins} at ${FREE_SPINS[3].mult}x.`,
        `Every ${HEAT_MAX} paid spins, a Hot Spin.`,
    ].join(' ');
}

module.exports = { paytableImage, paytableAltText };
