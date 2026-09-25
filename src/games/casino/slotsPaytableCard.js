'use strict';

/**
 * The slots paytable, as one image.
 *
 * Drawn in the style of the Hunt / Fish / Mine cards (utils/grindProfileCard.js)
 * with their primitives and a `slots` palette from the same THEMES table: the
 * accent stripe, the 32px title over a muted subtitle, stat tiles, uppercase
 * section heads over a hairline rule, and rounded 6% panels. Gold rims mark
 * the jackpot the way that family marks an active buff.
 *
 * Portrait and narrower than the grind cards (820 wide against their 1000) with
 * the same type sizes, because it is read on phones: Discord scales an image
 * to the screen's width, so the narrower canvas is the bigger text.
 *
 * Every figure comes from slotsReels — the rows, the odds, the return — so a
 * paytable change redraws the card; nothing here is typed out twice. The
 * symbols are Twemoji (src/assets/slot-symbols), the art Discord draws on the
 * reels, so the card and the machine show one set.
 *
 * The paytable is the same for every player and every spin, so it is drawn
 * once per process and the PNG kept. `slots.js` falls back to its text embed if
 * the render fails, and gives the attachment alt text carrying the rows.
 *
 * @module games/casino/slotsPaytableCard
 */

const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const { ensureFontsRegistered } = require('../../utils/registerFonts');
const { encodeCanvas } = require('../../utils/canvasEncode');
const { THEMES, primitives } = require('../../utils/grindProfileCard');
const {
    SYMBOLS, HEAT_MAX, TRIPLE_WILD_MULT, TRIPLE_BOOST_MULT, FREE_SPINS,
    LUCKY_CHARM_RESPIN, LUCKY_STREAK_REFUND, PROGRESSIVE_RETURN, JACKPOT_CAP_MULT, odds,
} = require('./slotsReels');
const { RANDOM_DROP_RETURN } = require('../../services/casinoJackpotService');
const { LUCKY_SAVE_MAX_BET } = require('../../services/effectsService');

ensureFontsRegistered();

const { FONT, roundRect, fitText, paintBackground } = primitives;
const THEME = THEMES.slots;
const GOLD  = '#f5c542';   // the grind cards' buff-pill gold
const RULE  = 'rgba(255,255,255,0.08)';
const ART   = path.join(__dirname, '..', '..', 'assets', 'slot-symbols');

const W   = 820;
const PAD = 32;
const HEADER_H     = 104;
const SECTION_HEAD = 34;
const ROW_H   = 58;
const ROW_GAP = 8;
const JACKPOT_H = 76;
const FEATURE_ICON = 48;
const FEATURE_TEXT_X = PAD + 18 + FEATURE_ICON + 18;
const FEATURE_TEXT_W = W - FEATURE_TEXT_X - PAD - 18;

const ICON = {
    Cherry: 'cherry', Lemon: 'lemon', Grape: 'grape', Bell: 'bell', Diamond: 'diamond',
    Star: 'star', Wild: 'wild', Boost: 'boost', Scatter: 'scatter',
};

// Loaded once per process and shared with the machine (slotsTable.js), so the
// paytable and the reels draw the same bitmaps from one cache.
const art = new Map();
/** A symbol's Twemoji bitmap by file name ("cherry", "wild"…), as a promise. */
function icon(name) {
    if (!art.has(name)) art.set(name, loadImage(path.join(ART, `${name}.png`)));
    return art.get(name);
}

const fmt = n => Math.round(n).toLocaleString('en-US');
const pct = x => `${(x * 100).toFixed(1)}%`;

function tile(ctx, x, y, w, h, r = 12) {
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = THEME.panel;
    ctx.fill();
}

function goldTile(ctx, x, y, w, h) {
    roundRect(ctx, x, y, w, h, 14);
    ctx.fillStyle = 'rgba(245,197,66,0.12)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = GOLD;
    ctx.stroke();
}

/** The grind cards' section head: accent label, an optional muted note, a hairline. */
function sectionHead(ctx, label, y, note) {
    ctx.textAlign = 'left';
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillStyle = THEME.accent;
    ctx.fillText(label.toUpperCase(), PAD, y + 20);
    if (note) {
        ctx.font = `15px ${FONT}`;
        ctx.fillStyle = THEME.muted;
        ctx.textAlign = 'right';
        ctx.fillText(note, W - PAD, y + 20);
        ctx.textAlign = 'left';
    }
    ctx.fillStyle = RULE;
    ctx.fillRect(PAD, y + 28, W - PAD * 2, 1);
}

/** `str` broken into lines no wider than `width` at the current font. */
function wrap(ctx, str, width) {
    const lines = [];
    let line = '';
    for (const word of str.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(next).width > width) { lines.push(line); line = word; } else { line = next; }
    }
    if (line) lines.push(line);
    return lines;
}

async function drawIcons(ctx, names, x, y, size, gap) {
    for (const [i, name] of names.entries()) ctx.drawImage(await icon(name), x + i * (size + gap), y, size, size);
}

// ─── What goes on it ─────────────────────────────────────────────────────────

function content() {
    const o = odds();
    const oneIn = key => `1 in ${fmt(1 / o.lines.get(key))}`;
    const regular = SYMBOLS.filter(s => s.type === 'regular').reverse();
    return {
        stats: [
            { label: 'Return to player', value: pct(o.reelReturn + PROGRESSIVE_RETURN + RANDOM_DROP_RETURN) },
            { label: 'Spins that win', value: pct(o.hitRate) },
            { label: 'Free spins', value: `1 in ${fmt(1 / o.freeSpinRate)}` },
        ],
        jackpot: { odds: oneIn('jackpot') },
        rows: [
            { icons: ['boost', 'boost', 'boost'], pays: TRIPLE_BOOST_MULT, odds: oneIn('mult3'), note: 'Wilds count' },
            ...regular.map(s => ({ icons: Array(3).fill(ICON[s.name]), pays: s.three, odds: oneIn(`three:${s.name}`) })),
        ],
        pairs: regular.filter(s => s.pair > 0)
            .map(s => ({ icons: [ICON[s.name], ICON[s.name]], pays: s.pair, odds: oneIn(`pair:${s.name}`) })),
        features: [
            { icon: 'wild', title: 'Wild', body: 'Stands in for any symbol except the Scatter. The line is read the way that pays best.' },
            { icon: 'boost', title: 'Boost', body: 'Each Boost on the line doubles a line win: one is ×2, two are ×4.' },
            {
                icon: 'scatter', title: 'Free Spins',
                body: `Two Scatters anywhere: ${FREE_SPINS[2].spins} free spins. Three: ${FREE_SPINS[3].spins} at ${FREE_SPINS[3].mult}×. Paid on top of the line win.`,
            },
            {
                icon: 'fire', title: 'Heat Meter',
                body: `Every paid spin adds one. At ${HEAT_MAX}, your next spin is a Hot Spin: reel 1 lands a Bell, Diamond or Star.`,
            },
            {
                icon: 'clover', title: 'Luck Items',
                body: `Lucky Charm re-spins ${pct(LUCKY_CHARM_RESPIN)} of losing spins; Lucky Streak refunds ${pct(LUCKY_STREAK_REFUND)}. Bets up to ${fmt(LUCKY_SAVE_MAX_BET)}. Coin boosters don't apply.`,
            },
        ],
        footer: `Return: ${pct(o.reelReturn)} from the reels and features, up to ${pct(PROGRESSIVE_RETURN)} from Triple Wild pots, ${pct(RANDOM_DROP_RETURN)} from random pool drops.`,
    };
}

// Heights, shared by the canvas size and the draw, so neither can drift.
function featureHeight(ctx, f) {
    ctx.font = `15px ${FONT}`;
    return Math.max(FEATURE_ICON + 32, 44 + wrap(ctx, f.body, FEATURE_TEXT_W).length * 21 + 12);
}

function layout(ctx, c) {
    let y = HEADER_H + 72 + 26;                                     // header, stat tiles
    y += SECTION_HEAD + JACKPOT_H + ROW_GAP + c.rows.length * (ROW_H + ROW_GAP) + 16;
    y += SECTION_HEAD + c.pairs.length * (ROW_H + ROW_GAP) + 16;
    y += SECTION_HEAD + c.features.reduce((h, f) => h + featureHeight(ctx, f) + ROW_GAP, 0) + 8;
    return y + 64;                                                  // footer
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

async function payRow(ctx, row, y) {
    tile(ctx, PAD, y, W - PAD * 2, ROW_H);
    const size = 40;
    await drawIcons(ctx, row.icons, PAD + 16, y + (ROW_H - size) / 2, size, 6);
    if (row.note) {
        ctx.font = `15px ${FONT}`;
        ctx.fillStyle = THEME.muted;
        ctx.textAlign = 'left';
        ctx.fillText(row.note, PAD + 16 + 3 * size + 2 * 6 + 20, y + 35);
    }
    ctx.font = `bold 26px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'right';
    ctx.fillText(`${row.pays}×`, W - PAD - 150, y + 38);
    ctx.font = `15px ${FONT}`;
    ctx.fillStyle = THEME.muted;
    ctx.fillText(row.odds, W - PAD - 16, y + 36);
    ctx.textAlign = 'left';
}

async function drawPaytable() {
    const scratch = createCanvas(1, 1).getContext('2d');
    const c = content();
    const H = layout(scratch, c);

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    paintBackground(ctx, W, H, THEME);
    ctx.fillStyle = THEME.accent;
    ctx.fillRect(0, 0, W, 6);

    // ── Header
    ctx.font = `bold 32px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Slots Paytable', PAD, 56);
    ctx.font = `17px ${FONT}`;
    ctx.fillStyle = THEME.muted;
    ctx.fillText(fitText(ctx, 'Wins pay on the middle line, as multiples of your bet.', W - PAD * 2 - 90), PAD, 84);
    ctx.drawImage(await icon('slots'), W - PAD - 68, 24, 68, 68);

    // ── Stat tiles
    let y = HEADER_H;
    const gap = 14;
    const tileW = (W - PAD * 2 - gap * (c.stats.length - 1)) / c.stats.length;
    c.stats.forEach((s, i) => {
        const x = PAD + i * (tileW + gap);
        tile(ctx, x, y, tileW, 72);
        ctx.font = `13px ${FONT}`;
        ctx.fillStyle = THEME.muted;
        ctx.fillText(fitText(ctx, s.label.toUpperCase(), tileW - 28), x + 16, y + 25);
        ctx.font = `bold 26px ${FONT}`;
        ctx.fillStyle = i === 0 ? GOLD : '#ffffff';
        ctx.fillText(fitText(ctx, s.value, tileW - 28), x + 16, y + 58);
    });
    y += 72 + 26;

    // ── Line wins
    sectionHead(ctx, 'Line wins', y, 'pays · odds');
    y += SECTION_HEAD;

    goldTile(ctx, PAD, y, W - PAD * 2, JACKPOT_H);
    await drawIcons(ctx, ['wild', 'wild', 'wild'], PAD + 16, y + (JACKPOT_H - 44) / 2, 44, 6);
    const jx = PAD + 16 + 3 * 44 + 2 * 6 + 20;
    ctx.font = `bold 17px ${FONT}`;
    ctx.fillStyle = GOLD;
    ctx.fillText('JACKPOT', jx, y + 32);
    ctx.font = `15px ${FONT}`;
    ctx.fillStyle = THEME.muted;
    ctx.fillText(`+ the pot, up to ${JACKPOT_CAP_MULT}× the bet`, jx, y + 56);
    ctx.font = `bold 26px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'right';
    ctx.fillText(`${TRIPLE_WILD_MULT}×`, W - PAD - 150, y + 47);
    ctx.font = `15px ${FONT}`;
    ctx.fillStyle = THEME.muted;
    ctx.fillText(c.jackpot.odds, W - PAD - 16, y + 45);
    ctx.textAlign = 'left';
    y += JACKPOT_H + ROW_GAP;

    for (const row of c.rows) { await payRow(ctx, row, y); y += ROW_H + ROW_GAP; }
    y += 16;

    // ── Pairs
    sectionHead(ctx, 'Pairs', y, 'a Wild counts as either');
    y += SECTION_HEAD;
    for (const row of c.pairs) { await payRow(ctx, row, y); y += ROW_H + ROW_GAP; }
    y += 16;

    // ── Features
    sectionHead(ctx, 'Features', y);
    y += SECTION_HEAD;
    for (const f of c.features) {
        const h = featureHeight(ctx, f);
        tile(ctx, PAD, y, W - PAD * 2, h);
        ctx.drawImage(await icon(f.icon), PAD + 18, y + (h - FEATURE_ICON) / 2, FEATURE_ICON, FEATURE_ICON);
        ctx.font = `bold 17px ${FONT}`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(f.title, FEATURE_TEXT_X, y + 32);
        ctx.font = `15px ${FONT}`;
        ctx.fillStyle = THEME.muted;
        wrap(ctx, f.body, FEATURE_TEXT_W).forEach((line, i) => ctx.fillText(line, FEATURE_TEXT_X, y + 56 + i * 21));
        y += h + ROW_GAP;
    }

    // ── Footer
    y += 8;
    ctx.fillStyle = RULE;
    ctx.fillRect(PAD, y, W - PAD * 2, 1);
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = THEME.muted;
    ctx.fillText(fitText(ctx, c.footer, W - PAD * 2), PAD, y + 26);
    ctx.fillText('Every line win pays more than the bet.', PAD, y + 46);
    ctx.textAlign = 'right';
    ctx.fillText('Symbols: Twemoji, CC-BY 4.0', W - PAD, y + 46);
    ctx.textAlign = 'left';

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

module.exports = { paytableImage, paytableAltText, symbolArt: icon };
