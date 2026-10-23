'use strict';

/**
 * Draws the slot machine in the blackjack table's language (blackjackTable.js):
 * the same felt grain and wooden rail, recoloured to slots' purple; the same
 * pills, chip stack and glowing result banner (tableArt.js); and a reel window
 * where blackjack deals its cards.
 *
 * The window is three white reel faces, each showing its three stopped symbols
 * with the rows above and below the payline dimmed, or a motion blur while the
 * reel still turns. Gold arrows mark the payline and a gold outline marks each
 * cell that paid. A free-spin round swaps the window for a strip of small
 * tiles, one per free spin, so the whole round is one picture rather than one
 * upload per spin.
 *
 * The symbols are the Twemoji bitmaps the paytable card draws
 * (src/assets/slot-symbols), so the machine and its paytable show one set, and
 * they are drawn large: Discord scales a 960-wide image down to a phone's
 * width, and a payline symbol has to survive that.
 *
 * `renderMachine` takes a plain view (see the typedef) rather than the game's
 * state, so it can be drawn and looked at without playing a spin. It resolves
 * to a JPEG buffer; the encode runs off the event loop.
 *
 * @module games/casino/slotsTable
 */

const { createCanvas } = require('canvas');
const { ensureFontsRegistered } = require('../../utils/registerFonts');
const { encodeCanvas } = require('../../utils/canvasEncode');
const { symbolArt } = require('./slotsPaytableCard');
const {
    FONT, GOLD, TONES, roundRect, pill, feltGrain, drawRail, drawBanner, shortAmount, drawChip,
} = require('./tableArt');

ensureFontsRegistered();

const W = 960;
const H = 560;

// The reel window.
const REEL_W = 176;
const CELL   = 100;
const GAP    = 16;
const WIN_H  = CELL * 3;
const WIN_X  = (W - (3 * REEL_W + 2 * GAP)) / 2;
const WIN_Y  = 72;
const LINE_SYMBOL = 86;    // the payline's symbol, the one that has to read on a phone
const SIDE_SYMBOL = 64;    // the rows above and below it

// Where things sit down the felt.
const STATUS_Y = 40;
const TAG_Y    = WIN_Y + WIN_H + 34;
const BANNER_Y = 478;

// The free-spin strip spans the felt between the rails.
const STRIP_X = 60;
const STRIP_W = W - STRIP_X * 2;

// Slots' purple (THEMES.slots in grindProfileCard.js), lifted into a felt.
const FELT     = ['#5a3aa8', '#35207a', '#170d3a'];
const BACKING  = 'rgba(14,8,34,0.85)';
const REEL_INK = 'rgba(40,20,80,0.30)';
const GLOW     = { gold: GOLD, hot: TONES.hot.fill };

const SPIN_BLUR = ['cherry', 'bell', 'lemon', 'star', 'grape', 'diamond', 'cherry', 'lemon'];

/**
 * @typedef {{ text: string, tone: keyof TONES }} Tag
 *
 * @typedef {object} Reel
 * @property {?string[]} cells     top, payline, bottom, by art name ("cherry"); null while spinning
 * @property {'gold'|'hot'} [glow] a held reel (gold) or a Hot Spin's locked one (hot)
 * @property {number[]} [hits]     rows (0–2) of this reel outlined as part of a win
 *
 * @typedef {object} FreeRun
 * @property {string[]} cells      the free spin's payline, by art name
 * @property {number} pay          what it paid
 *
 * @typedef {object} MachineView
 * @property {number} bet
 * @property {number} pot          the progressive pool
 * @property {number} heat         0 to heatMax
 * @property {number} heatMax
 * @property {boolean} [hot]       a Hot Spin: the meter reads HOT SPIN
 * @property {Reel[]} [reels]      the window; left out when `free` is drawn instead
 * @property {(?FreeRun)[]} [free] one tile per free spin, null for one not yet played
 * @property {?Tag} [tag]          the line, a tease or a feature, under the window
 * @property {?Tag} [banner]       the spin's result
 * @property {?string} [status]    a quiet pill where the banner goes, while there is none
 */

// ── The felt ─────────────────────────────────────────────────────────────────

let feltCache = null;

/** Felt, grain and rail: the same for every frame, so drawn once and kept. */
function felt() {
    if (feltCache) return feltCache;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(W / 2, H * 0.42, 60, W / 2, H * 0.5, W * 0.72);
    g.addColorStop(0, FELT[0]);
    g.addColorStop(0.6, FELT[1]);
    g.addColorStop(1, FELT[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    feltGrain(ctx, W, H);
    drawRail(ctx, W, H);
    feltCache = canvas;
    return canvas;
}

// ── The status row ───────────────────────────────────────────────────────────

/** A pill's width at `size`, as tableArt's pill draws it. */
function pillWidth(ctx, text, size) {
    ctx.save();
    ctx.font = `bold ${size}px ${FONT}`;
    const w = ctx.measureText(text).width + size * 1.4;
    ctx.restore();
    return w;
}

/** The Heat meter, top left: ten segments filling orange, or HOT SPIN once full. */
function drawHeat(ctx, heat, heatMax, hot) {
    const left = 44;
    if (hot) {
        pill(ctx, 'HOT SPIN', left + pillWidth(ctx, 'HOT SPIN', 16) / 2, STATUS_Y, 'hot', 16);
        return;
    }
    const seg = 11;
    const segGap = 3;
    ctx.save();
    ctx.font = `bold 15px ${FONT}`;
    const labelW = ctx.measureText('HEAT').width;
    const w = 16 + labelW + 10 + heatMax * seg + (heatMax - 1) * segGap + 16;
    const h = 28;
    roundRect(ctx, left, STATUS_Y - h / 2, w, h, h / 2);
    ctx.fillStyle = TONES.info.fill;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('HEAT', left + 16, STATUS_Y + 1);
    const x0 = left + 16 + labelW + 10;
    for (let i = 0; i < heatMax; i++) {
        roundRect(ctx, x0 + i * (seg + segGap), STATUS_Y - 7, seg, 14, 3);
        ctx.fillStyle = i < heat ? TONES.hot.fill : 'rgba(255,255,255,0.18)';
        ctx.fill();
    }
    ctx.restore();
}

function drawStatusRow(ctx, view) {
    drawHeat(ctx, view.heat, view.heatMax, view.hot);
    pill(ctx, `SLOTS · BET ${view.bet.toLocaleString('en-US')}`, W / 2, STATUS_Y);
    const pot = `POT ${shortAmount(Math.round(view.pot))}`;
    pill(ctx, pot, W - 44 - pillWidth(ctx, pot, 16) / 2, STATUS_Y, 'gold', 16);
}

// ── The reels ────────────────────────────────────────────────────────────────

const reelX = i => WIN_X + i * (REEL_W + GAP);

/** The white face of a reel, with its drop shadow, or a coloured glow when it has one. */
function reelFace(ctx, x, y, w, h, glow) {
    ctx.save();
    ctx.shadowColor = glow ?? 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = glow ? 30 : 10;
    ctx.shadowOffsetY = glow ? 0 : 4;
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = '#fbfaf7';
    ctx.fill();
    ctx.restore();
}

/** The reel's curve: darker towards the top and bottom, over whatever is on it. */
function reelShade(ctx, x, y, w, h) {
    const shade = ctx.createLinearGradient(0, y, 0, y + h);
    shade.addColorStop(0, REEL_INK);
    shade.addColorStop(0.3, 'rgba(40,20,80,0)');
    shade.addColorStop(0.7, 'rgba(40,20,80,0)');
    shade.addColorStop(1, REEL_INK);
    ctx.fillStyle = shade;
    ctx.fillRect(x, y, w, h);
}

const blurCache = new Map();

/**
 * A spinning reel's face, symbols smeared down the strip under a bright streak.
 * The same three blurs serve every spin, so each is drawn once; `offset`
 * starts each reel at a different point of the sequence so they do not match.
 */
async function spinningStrip(offset) {
    if (blurCache.has(offset)) return blurCache.get(offset);
    const canvas = createCanvas(REEL_W, WIN_H);
    const ctx = canvas.getContext('2d');
    const size = 84;
    for (let k = 0; k < 7; k++) {
        const art = await symbolArt(SPIN_BLUR[(k + offset) % SPIN_BLUR.length]);
        for (let s = 0; s < 5; s++) {
            ctx.globalAlpha = 0.15;
            ctx.drawImage(art, (REEL_W - size) / 2, -44 + k * 62 + s * 9, size, size);
        }
    }
    ctx.globalAlpha = 1;
    const streak = ctx.createLinearGradient(0, 0, REEL_W, 0);
    streak.addColorStop(0, 'rgba(255,255,255,0)');
    streak.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    streak.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = streak;
    ctx.fillRect(0, 0, REEL_W, WIN_H);
    blurCache.set(offset, canvas);
    return canvas;
}

/** A gold outline round one cell that took part in a win. */
function outlineCell(ctx, x, y, w, h) {
    ctx.save();
    ctx.shadowColor = GOLD;
    ctx.shadowBlur = 18;
    roundRect(ctx, x, y, w, h, 10);
    ctx.lineWidth = 4;
    ctx.strokeStyle = GOLD;
    ctx.stroke();
    ctx.restore();
}

async function drawReel(ctx, i, reel) {
    const x = reelX(i);
    const y = WIN_Y;
    reelFace(ctx, x, y, REEL_W, WIN_H, reel.glow ? GLOW[reel.glow] : null);

    ctx.save();
    roundRect(ctx, x, y, REEL_W, WIN_H, 12);
    ctx.clip();
    if (!reel.cells) {
        ctx.drawImage(await spinningStrip(i * 3), x, y);
    } else {
        for (const [row, name] of reel.cells.entries()) {
            const s = row === 1 ? LINE_SYMBOL : SIDE_SYMBOL;
            // Off the line, only a cell that counted (a Scatter) keeps full strength.
            ctx.globalAlpha = row === 1 || reel.hits?.includes(row) ? 1 : 0.45;
            ctx.drawImage(await symbolArt(name), x + (REEL_W - s) / 2, y + row * CELL + (CELL - s) / 2, s, s);
        }
        ctx.globalAlpha = 1;
    }
    reelShade(ctx, x, y, REEL_W, WIN_H);
    ctx.restore();

    for (const row of reel.hits ?? []) outlineCell(ctx, x + 6, y + row * CELL + 4, REEL_W - 12, CELL - 8);
}

/** The payline: a gold arrow either side of the window and a faint rule between. */
function drawPayline(ctx) {
    const y = WIN_Y + CELL * 1.5;
    ctx.save();
    ctx.fillStyle = GOLD;
    for (const [x, dir] of [[WIN_X - 16, 1], [W - WIN_X + 16, -1]]) {
        ctx.beginPath();
        ctx.moveTo(x + dir * 12, y);
        ctx.lineTo(x - dir * 7, y - 14);
        ctx.lineTo(x - dir * 7, y + 14);
        ctx.closePath();
        ctx.fill();
    }
    ctx.globalAlpha = 0.35;
    ctx.fillRect(WIN_X, y - 1, W - WIN_X * 2, 2);
    ctx.restore();
}

// ── The free-spin strip ──────────────────────────────────────────────────────

/** Columns for `n` tiles: four to a row up to eight, then five. */
const stripColumns = n => (n <= 4 ? n : n <= 8 ? 4 : 5);

async function drawStrip(ctx, runs) {
    const cols = stripColumns(runs.length);
    const rows = Math.ceil(runs.length / cols);
    const gapX = 14;
    const gapY = 12;
    const tileW = (STRIP_W - (cols - 1) * gapX) / cols;
    const tileH = Math.min(140, (WIN_H - (rows - 1) * gapY) / rows);
    const top = WIN_Y + (WIN_H - (rows * tileH + (rows - 1) * gapY)) / 2;
    const size = Math.min((tileW - 36) / 3, tileH - 46);

    for (const [i, run] of runs.entries()) {
        const x = STRIP_X + (i % cols) * (tileW + gapX);
        const y = top + Math.floor(i / cols) * (tileH + gapY);

        if (!run) {
            // Not played yet: an empty slot with its number.
            ctx.save();
            roundRect(ctx, x, y, tileW, tileH, 12);
            ctx.fillStyle = 'rgba(0,0,0,0.28)';
            ctx.fill();
            ctx.setLineDash([6, 5]);
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(255,255,255,0.22)';
            ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.font = `bold 26px ${FONT}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(i + 1), x + tileW / 2, y + tileH / 2);
            ctx.restore();
            continue;
        }

        const won = run.pay > 0;
        reelFace(ctx, x, y, tileW, tileH, null);
        ctx.save();
        roundRect(ctx, x, y, tileW, tileH, 12);
        ctx.clip();
        const left = x + (tileW - (3 * size + 2 * 6)) / 2;
        ctx.globalAlpha = won ? 1 : 0.55;
        for (const [k, name] of run.cells.entries()) {
            ctx.drawImage(await symbolArt(name), left + k * (size + 6), y + 12, size, size);
        }
        ctx.globalAlpha = 1;
        reelShade(ctx, x, y, tileW, tileH);
        ctx.restore();

        ctx.save();
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'center';
        ctx.font = `bold ${won ? 19 : 15}px ${FONT}`;
        ctx.fillStyle = won ? TONES.win.fill : '#8a8398';
        ctx.fillText(won ? `+${run.pay.toLocaleString('en-US')}` : 'no win', x + tileW / 2, y + tileH - 13, tileW - 16);
        ctx.restore();

        if (won) outlineCell(ctx, x + 1, y + 1, tileW - 2, tileH - 2);
    }
}

// ── The frame ────────────────────────────────────────────────────────────────

/** Whether a view is the plain all-reels-spinning frame, which is cached. */
const isSpinningFrame = view =>
    !view.free && !view.tag && !view.banner && view.reels.every(r => !r.cells && !r.glow);

// Encoded spinning frames, keyed by the only things that change on one: the
// status row, the chip and the status pill. A small LRU; a replay run at one
// stake re-uses them as the Heat meter comes round.
const SPIN_CACHE_MAX = 48;
const spinCache = new Map();

async function drawMachine(view) {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(felt(), 0, 0);
    drawStatusRow(ctx, view);

    if (view.free) {
        await drawStrip(ctx, view.free);
    } else {
        for (const [i, reel] of view.reels.entries()) await drawReel(ctx, i, reel);
        drawPayline(ctx);
        drawChip(ctx, view.bet, WIN_X - 76, WIN_Y + WIN_H - 36);
    }

    if (view.tag) pill(ctx, view.tag.text, W / 2, TAG_Y, view.tag.tone, 17);
    if (view.banner) drawBanner(ctx, view.banner, W / 2, BANNER_Y, W - 160, BACKING);
    else if (view.status) pill(ctx, view.status, W / 2, BANNER_Y, 'info', 17);

    // JPEG, as roulette's table: the felt's gradient and grain make a large
    // PNG, and a spin uploads several frames.
    return encodeCanvas(canvas, 'image/jpeg');
}

/**
 * Draws the machine and encodes it.
 *
 * @param {MachineView} view
 * @returns {Promise<Buffer>} a JPEG
 */
async function renderMachine(view) {
    if (!isSpinningFrame(view)) return drawMachine(view);

    const key = JSON.stringify([view.bet, shortAmount(Math.round(view.pot)), view.heat, view.heatMax, Boolean(view.hot), view.status ?? '']);
    if (spinCache.has(key)) {
        const hit = spinCache.get(key);
        spinCache.delete(key);
        spinCache.set(key, hit);
        return hit;
    }
    // The promise is kept, so frames asked for at once share one draw; a
    // failed draw is dropped, so the next spin tries again.
    const drawn = drawMachine(view).catch(err => { spinCache.delete(key); throw err; });
    spinCache.set(key, drawn);
    if (spinCache.size > SPIN_CACHE_MAX) spinCache.delete(spinCache.keys().next().value);
    return drawn;
}

module.exports = { renderMachine, W, H, __test__: { spinCache } };
