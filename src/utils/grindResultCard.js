'use strict';

/**
 * The picture half of a grind result — what a `/hunt start` kill looks like
 * when it lands. The fourth card in the family utils/grindProfileCard.js
 * started, drawn with the same kit so the screens read as one set.
 *
 *   ┌───────────────────────────────────────────────────────────────────┐
 *   │ ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ tier-coloured rule ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ │
 *   │  ╭─────────╮   RARE ★★★  CRITICAL  PRISTINE  LEVEL 11 → 12        │
 *   │  │  art in │   Red Deer                          (zone art, faint)│
 *   │  │  a tier │   Whispering Woods                                   │
 *   │  │  halo   │   +1,240 coins      +85 XP   LEVEL 11 → 12           │
 *   │  ╰─────────╯   1.50x streak × 2.00x crit × 1.20x trophy = 3.60x   │
 *   │  [Perfect approach] [Perfect shot] [Found: Rabbit's Foot]         │
 *   │  ▌APEX: Dire Alpha brought down — +1,800 coins                    │
 *   └───────────────────────────────────────────────────────────────────┘
 *
 * The same contract as its siblings: an illustration, not the record. Every
 * number here is also in the embed text beside it, callers give the file alt
 * text, and nothing on the canvas is a currency symbol or an emoji — a guild
 * currency can be a custom Discord emoji and node-canvas draws colour emoji as
 * boxes, so amounts are in "coins" and labels are words.
 *
 * @module utils/grindResultCard
 */

const { createCanvas } = require('canvas');
const { encodeCanvas } = require('./canvasEncode');
const { primitives } = require('./grindProfileCard');

const { FONT, themeFor, loadIcon, drawEntry, roundRect, fitText, shade, paintBackground } = primitives;

const W = 1000;
const PAD = 36;
const ART = 250;
const HEAD_H = 330;
const CHIP_H = 34;
const APEX_H = 62;

/** Tier colours by tier number — the same ramp the rarity ribbon uses. */
const TIER_COLOR = { 1: '#9e9e9e', 2: '#4caf50', 3: '#2196f3', 4: '#9c27b0', 5: '#ff9800', 6: '#e74c3c' };
const TIER_WORD  = { 1: 'COMMON', 2: 'UNCOMMON', 3: 'RARE', 4: 'EPIC', 5: 'LEGENDARY', 6: 'MYTHICAL' };
const GOLD = '#f5c542';
const APEX_COLOR = { perfect: GOLD, win: '#2ecc71', survived: '#3498db', escaped: '#8a6a4a' };

/** Strips emoji and other pictographs a canvas cannot draw, and the spaces they leave. */
function plain(text) {
    return String(text ?? '')
        .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}/gu, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

const n = v => Number(v ?? 0).toLocaleString('en-US');

/** A rounded label; returns its width so a row of them can be laid out. */
function pill(ctx, text, x, y, { color, fill = null, textColor = null, h = 30, size = 15 } = {}) {
    ctx.save();
    ctx.font = `bold ${size}px ${FONT}`;
    const w = ctx.measureText(text).width + 24;
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = fill ?? `${color}29`;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = textColor ?? color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 12, y + h / 2 + 1);
    ctx.restore();
    return w;
}

/** The animal on a soft halo in its tier colour — brighter and wider the rarer it is. */
async function drawHero(ctx, entry, x, y, tierNum, theme) {
    const color = TIER_COLOR[tierNum] ?? theme.accent;
    const cx = x + ART / 2, cy = y + ART / 2;

    ctx.save();
    roundRect(ctx, x, y, ART, ART, 28);
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fill();
    ctx.clip();
    const halo = ctx.createRadialGradient(cx, cy, ART * 0.08, cx, cy, ART * (0.55 + tierNum * 0.04));
    halo.addColorStop(0, `${shade(color, 0.25)}${tierNum >= 5 ? 'cc' : '88'}`);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(x, y, ART, ART);
    ctx.restore();

    ctx.save();
    roundRect(ctx, x, y, ART, ART, 28);
    ctx.lineWidth = tierNum >= 5 ? 5 : 3;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();

    const inset = 26;
    await drawEntry(ctx, { ...entry, color }, x + inset, y + inset, ART - inset * 2, theme);
}

/** Chips wrap onto as many rows as they need; this is how many that is. */
function chipRows(ctx, chips, maxW) {
    ctx.font = `bold 15px ${FONT}`;
    let rows = chips.length ? 1 : 0, x = 0;
    for (const c of chips) {
        const w = ctx.measureText(c.text).width + 24;
        if (x > 0 && x + w > maxW) { rows += 1; x = 0; }
        x += w + 10;
    }
    return rows;
}

/**
 * @param {object} opts
 * @param {'hunt'|'fish'|'mine'} opts.activity             picks the palette
 * @param {{name: string, iconId: ?string}} opts.subject   the animal / catch / ore
 * @param {number}  opts.tierNum                           1 common … 6 event
 * @param {?{name: string, iconId: ?string}} [opts.place]  zone art, drawn faint
 * @param {number}  opts.payout                            coins credited (0 when capped)
 * @param {?number} [opts.forfeited]                       set when the daily cap took it all
 * @param {number}  opts.xp
 * @param {?{from: number, to: number}} [opts.levelUp]
 * @param {boolean} [opts.crit]
 * @param {?{label: string, color: string}} [opts.grade]   trophy quality
 * @param {{label: string, value: number}[]} [opts.multipliers]  e.g. { label: 'crit', value: 2 }
 * @param {{text: string, tone?: 'good'|'bad'|'info'}[]} [opts.chips]  how the run went
 * @param {?{outcome: string, title: string, payout: number}} [opts.apex]  the duel, once resolved
 * @returns {Promise<Buffer>} PNG
 */
async function createGrindResultCard(opts) {
    const theme = themeFor(opts.activity);
    const tierNum = Math.min(6, Math.max(1, opts.tierNum | 0 || 1));
    const tierColor = TIER_COLOR[tierNum];
    const chips = (opts.chips ?? []).map(c => ({ ...c, text: plain(c.text) })).filter(c => c.text);

    // Height depends on how many chip rows and whether a duel is banked.
    const measure = createCanvas(1, 1).getContext('2d');
    const rows = chipRows(measure, chips, W - PAD * 2);
    const height = HEAD_H + (rows ? rows * (CHIP_H + 10) + 8 : 0) + (opts.apex ? APEX_H + 14 : 0) + PAD - 12;

    const canvas = createCanvas(W, height);
    const ctx = canvas.getContext('2d');
    paintBackground(ctx, W, height, theme);

    // The place, huge and faint on the right, as on the profile card.
    const placeImg = await loadIcon(opts.place?.iconId);
    if (placeImg) {
        ctx.save();
        ctx.globalAlpha = 0.10;
        ctx.drawImage(placeImg, W - 380, -20, 420, 420);
        ctx.restore();
    }

    // A wash of the tier colour from the top — the rarer, the stronger.
    const wash = ctx.createLinearGradient(0, 0, 0, HEAD_H);
    wash.addColorStop(0, `${tierColor}${tierNum >= 5 ? '55' : tierNum >= 3 ? '33' : '1a'}`);
    wash.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, HEAD_H);
    ctx.fillStyle = tierColor;
    ctx.fillRect(0, 0, W, 8);

    await drawHero(ctx, { iconId: opts.subject.iconId, name: opts.subject.name }, PAD, 44, tierNum, theme);

    const tx = PAD + ART + 34;
    const tw = W - tx - PAD;

    // ── Tags: tier and stars, crit, trophy grade
    let x = tx;
    x += pill(ctx, `${TIER_WORD[tierNum]}  ${'★'.repeat(tierNum)}`, x, 48, { color: tierColor }) + 10;
    if (opts.crit) x += pill(ctx, 'CRITICAL', x, 48, { color: GOLD, fill: GOLD, textColor: '#1a1400' }) + 10;
    if (opts.grade?.label) x += pill(ctx, plain(opts.grade.label).toUpperCase(), x, 48, { color: opts.grade.color ?? theme.accent }) + 10;
    // Up here rather than beside the XP, where a five-figure payout leaves no room.
    if (opts.levelUp) pill(ctx, `LEVEL ${opts.levelUp.from} → ${opts.levelUp.to}`, x, 48, { color: '#b9a6ff' });

    // ── Name and place
    ctx.fillStyle = '#ffffff';
    let nameSize = 54;
    ctx.font = `bold ${nameSize}px ${FONT}`;
    const name = plain(opts.subject.name);
    while (nameSize > 34 && ctx.measureText(name).width > tw) {
        nameSize -= 2;
        ctx.font = `bold ${nameSize}px ${FONT}`;
    }
    ctx.fillText(fitText(ctx, name, tw), tx, 132);
    if (opts.place?.name) {
        ctx.font = `19px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.fillText(fitText(ctx, plain(opts.place.name), tw), tx, 164);
    }

    // ── The payout, big — or, at the daily cap, what the cap took
    const payY = 232;
    if (opts.forfeited != null && !(opts.payout > 0)) {
        ctx.font = `bold 46px ${FONT}`;
        ctx.fillStyle = '#8a8a8a';
        const text = n(opts.forfeited);
        ctx.fillText(text, tx, payY);
        const tWidth = ctx.measureText(text).width;
        ctx.fillRect(tx - 4, payY - 16, tWidth + 8, 4);
        ctx.font = `bold 16px ${FONT}`;
        ctx.fillStyle = '#e5534b';
        ctx.fillText('DAILY CAP', tx + tWidth + 14, payY - 8);
        x = tx + tWidth + 14 + ctx.measureText('DAILY CAP').width + 30;
    } else {
        ctx.font = `bold 60px ${FONT}`;
        ctx.fillStyle = GOLD;
        const text = `+${n(opts.payout)}`;
        ctx.fillText(text, tx, payY);
        const tWidth = ctx.measureText(text).width;
        ctx.font = `bold 22px ${FONT}`;
        ctx.fillStyle = shade(GOLD, -0.2);
        ctx.fillText('coins', tx + tWidth + 10, payY);
        x = tx + tWidth + 10 + ctx.measureText('coins').width + 34;
    }
    ctx.font = `bold 26px ${FONT}`;
    ctx.fillStyle = '#b9a6ff';
    const xpText = `+${n(opts.xp)} XP`;
    ctx.fillText(xpText, x, payY);

    // ── The multiplier stack
    const mults = (opts.multipliers ?? []).filter(m => m.value > 1);
    if (mults.length) {
        const combined = mults.reduce((p, m) => p * m.value, 1);
        ctx.font = `18px ${FONT}`;
        ctx.fillStyle = theme.muted;
        const line = `${mults.map(m => `${m.value.toFixed(2)}x ${plain(m.label)}`).join('  ×  ')}  =  `;
        ctx.fillText(fitText(ctx, line, tw - 90), tx, payY + 44);
        const lw = Math.min(ctx.measureText(line).width, tw - 90);
        ctx.font = `bold 20px ${FONT}`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`${combined.toFixed(2)}x`, tx + lw, payY + 44);
    }

    // ── How the run went
    let y = HEAD_H;
    if (chips.length) {
        const TONE = { good: theme.accent, bad: '#e5534b', info: theme.muted, gold: GOLD };
        let cx = PAD;
        ctx.font = `bold 15px ${FONT}`;
        for (const c of chips) {
            const w = ctx.measureText(c.text).width + 24;
            if (cx > PAD && cx + w > W - PAD) { cx = PAD; y += CHIP_H + 10; }
            pill(ctx, c.text, cx, y, { color: TONE[c.tone] ?? theme.muted, h: CHIP_H });
            cx += w + 10;
        }
        y += CHIP_H + 18;
    }

    // ── The duel, once it is over
    if (opts.apex) {
        const color = APEX_COLOR[opts.apex.outcome] ?? theme.accent;
        roundRect(ctx, PAD, y, W - PAD * 2, APEX_H, 14);
        ctx.fillStyle = `${color}24`;
        ctx.fill();
        ctx.fillStyle = color;
        ctx.fillRect(PAD, y, 6, APEX_H);
        ctx.font = `bold 14px ${FONT}`;
        ctx.fillText('APEX DUEL', PAD + 22, y + 24);
        ctx.font = `bold 20px ${FONT}`;
        ctx.fillStyle = '#ffffff';
        const bonus = opts.apex.payout > 0 ? `+${n(opts.apex.payout)} coins` : 'no bonus';
        ctx.fillText(fitText(ctx, plain(opts.apex.title), W - PAD * 2 - 240), PAD + 22, y + 48);
        ctx.textAlign = 'right';
        ctx.fillStyle = opts.apex.payout > 0 ? GOLD : theme.muted;
        ctx.fillText(bonus, W - PAD - 20, y + 40);
        ctx.textAlign = 'left';
    }

    return encodeCanvas(canvas);
}

module.exports = { createGrindResultCard, TIER_COLOR, __test__: { plain, chipRows } };
