'use strict';

/**
 * The Hall of Champions card: the picture `/leaderboard type:Hall of Champions`
 * carries above its text. The other boards rank one list, so they stand on a
 * podium (utils/leaderboardCard); the hall is weeks of four crowned winners, so
 * it is drawn as a wall of plaques instead — one row per week, newest first,
 * one plaque per track in the track's own colours:
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ MY SERVER                                                     ♛      │
 *   │ Hall of Champions                                                    │
 *   │ Weekly champions of the last 3 weeks                                 │
 *   │ WEEK 38  Sep 14 – Sep 20, 2026  [LATEST]                             │
 *   │ ┌─HUNTER──┐ ┌─MINER───┐ ┌─ANGLER──┐ ┌EXPLORER─┐                      │
 *   │ │   ♛     │ │   ♛     │ │   ♛     │ │         │                      │
 *   │ │ (avatar)│ │ (avatar)│ │ (avatar)│ │Unclaimed│                      │
 *   │ │  Alice  │ │  Bob    │ │  Carol  │ │         │                      │
 *   │ │  4,000  │ │  3,000  │ │  12     │ │         │                      │
 *   │ └─────────┘ └─────────┘ └─────────┘ └─────────┘                      │
 *   │ WEEK 37 …                                                            │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * A track nobody won that week keeps its place as an empty plaque, so the
 * columns line up down the wall and a gap reads as a gap.
 *
 * The same contract as the rest of the family: an illustration, not the record
 * — every name and number is also in the embed text, the attachment carries alt
 * text, and nothing drawn is an emoji.
 *
 * @module utils/championsHallCard
 */

const { createCanvas } = require('canvas');
const { encodeCanvas } = require('./canvasEncode');
const { primitives } = require('./grindProfileCard');
const { drawing } = require('./leaderboardCard');

const { FONT, themeFor, paintBackground, roundRect, fitText, shade } = primitives;
const { loadAvatar, plain, hexToRgba, fitFont, drawPortrait, drawCrown, MEDAL } = drawing;

const CARD_W = 1000;
const PAD = 50;
const HEADER_H = 150;
const WEEK_HEAD = 40;
const PLAQUE_H = 222;
const PLAQUE_GAP = 16;
const WEEK_GAP = 22;
const FOOTER_H = 44;
const MAX_WEEKS = 6;

const GOLD = MEDAL[0];

/** The tracks, in the order a week's announcement names them. */
const TRACKS = ['hunt', 'mine', 'fish', 'explore'];

/** The Monday a 'YYYY-Www' ISO week starts on (UTC), or null for a malformed key. */
function mondayOf(weekKey) {
    const m = /^(\d{4})-W(\d{2})$/.exec(String(weekKey ?? ''));
    if (!m) return null;
    const year = Number(m[1]), week = Number(m[2]);
    // 4 January is always in ISO week 1; step back to that week's Monday.
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const week1 = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000;
    return new Date(week1 + (week - 1) * 7 * 86_400_000);
}

/** "Week 38" and "Sep 15 – Sep 21, 2026" for a week key; the key itself if it does not parse. */
function weekLabel(weekKey) {
    const monday = mondayOf(weekKey);
    if (!monday) return { title: String(weekKey ?? ''), range: '' };
    const sunday = new Date(monday.getTime() + 6 * 86_400_000);
    const fmt = (d, withYear) => d.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', timeZone: 'UTC', ...(withYear ? { year: 'numeric' } : {}),
    });
    return {
        title: `Week ${Number(weekKey.slice(-2))}`,
        range: `${fmt(monday, false)} – ${fmt(sunday, true)}`,
    };
}

/** What each track's champion is called, for a plaque nobody has won. */
const ROLE = { hunt: 'HUNTER', mine: 'MINER', fish: 'ANGLER', explore: 'EXPLORER' };

/** "HUNTER" from "🏹 Hunter of the Week". */
function roleOf(title, category) {
    const word = plain(title).replace(/\s+of the week$/i, '');
    return word ? word.toUpperCase() : (ROLE[category] ?? String(category ?? '').toUpperCase());
}

function cardHeight(weekCount, hasFooter) {
    return HEADER_H + weekCount * (WEEK_HEAD + PLAQUE_H + WEEK_GAP) + (hasFooter ? FOOTER_H : 0);
}

async function drawPlaque(ctx, champ, category, x, y, w, latest) {
    const theme = themeFor(category);
    const accent = theme.accent;

    roundRect(ctx, x, y, w, PLAQUE_H, 16);
    if (!champ) {
        // Nobody won this track this week: the place is kept, and empty.
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.025)';
        ctx.fill();
        ctx.setLineDash([7, 6]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.font = `bold 14px ${FONT}`;
        ctx.fillStyle = hexToRgba(accent, 0.55);
        ctx.fillText(roleOf(null, category), x + w / 2, y + 16);
        ctx.font = `16px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillText('Unclaimed', x + w / 2, y + PLAQUE_H / 2 - 8);
        ctx.restore();
        return;
    }

    // The plaque in the track's colours, lit from the top.
    const lit = ctx.createLinearGradient(0, y, 0, y + PLAQUE_H);
    lit.addColorStop(0, hexToRgba(shade(theme.top, 0.25), 0.95));
    lit.addColorStop(1, hexToRgba(theme.bottom, 0.9));
    ctx.fillStyle = lit;
    ctx.fill();
    ctx.lineWidth = latest ? 3 : 2;
    ctx.strokeStyle = latest ? accent : hexToRgba(accent, 0.55);
    ctx.stroke();

    const cx = x + w / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillStyle = accent;
    ctx.fillText(fitText(ctx, champ.role, w - 24), cx, y + 16);
    ctx.restore();

    const r = 38, cy = y + 98;
    const glow = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 2);
    glow.addColorStop(0, hexToRgba(accent, 0.35));
    glow.addColorStop(1, hexToRgba(accent, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(cx - r * 2, cy - r * 2, r * 4, r * 4);
    await drawPortrait(ctx, champ, cx, cy, r, accent, theme);
    drawCrown(ctx, cx, cy - r - 3, 34, GOLD);

    const inner = w - 24;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const name = plain(champ.name) || 'Unknown';
    fitFont(ctx, name, 19, 13, inner);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fitText(ctx, name, inner), cx, y + 148);

    const total = Number(champ.total ?? 0).toLocaleString('en-US');
    fitFont(ctx, total, 24, 14, inner);
    ctx.fillStyle = accent;
    ctx.fillText(fitText(ctx, total, inner), cx, y + 172);

    const runs = champ.runs > 1 ? ` · ${Number(champ.runs).toLocaleString('en-US')} runs` : '';
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = theme.muted;
    ctx.fillText(fitText(ctx, `${plain(champ.unit)}${runs}`, inner), cx, y + 200);
    ctx.restore();
}

/**
 * @param {object} opts
 * @param {?string} [opts.kicker]   above the title, e.g. the server's name
 * @param {{week: string, champions: Object<string, {name: string, avatarUrl?: ?string,
 *          total: number, unit: string, runs?: number, role: string}>}[]} opts.weeks
 *        newest first, champions keyed by category (hunt / mine / fish / explore)
 * @param {?string} [opts.footer]
 * @returns {Promise<Buffer>} PNG
 */
async function createChampionsHallCard(opts) {
    const theme = themeFor('board');
    const weeks = (opts.weeks ?? []).slice(0, MAX_WEEKS);
    const footer = plain(opts.footer);

    // Every portrait at once: the avatar loads are network round trips.
    const champs = weeks.flatMap(w => Object.values(w.champions ?? {}));
    const avatars = await Promise.all(champs.map(c => loadAvatar(c.avatarUrl)));
    champs.forEach((c, i) => { c.avatar = avatars[i]; });

    const height = cardHeight(weeks.length, !!footer);
    const canvas = createCanvas(CARD_W, height);
    const ctx = canvas.getContext('2d');
    paintBackground(ctx, CARD_W, height, theme);

    const wash = ctx.createRadialGradient(CARD_W - 160, 40, 20, CARD_W - 160, 40, 520);
    wash.addColorStop(0, hexToRgba(GOLD, 0.2));
    wash.addColorStop(1, hexToRgba(GOLD, 0));
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, CARD_W, Math.min(height, 700));

    // A great faint crown behind the header.
    ctx.save();
    ctx.globalAlpha = 0.18;
    drawCrown(ctx, CARD_W - 150, 132, 150, GOLD);
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const kicker = plain(opts.kicker).toUpperCase();
    if (kicker) {
        ctx.font = `bold 16px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.fillText(fitText(ctx, kicker, CARD_W - PAD * 2 - 220), PAD, 32);
    }
    ctx.fillStyle = GOLD;
    ctx.fillRect(PAD, 58, 6, 44);
    ctx.font = `bold 40px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Hall of Champions', PAD + 20, 60);
    ctx.font = `18px ${FONT}`;
    ctx.fillStyle = theme.muted;
    ctx.fillText(
        weeks.length === 1 ? 'The champions of the last week' : `Weekly champions of the last ${weeks.length} weeks`,
        PAD + 20, 110);
    ctx.restore();

    const colW = (CARD_W - PAD * 2 - PLAQUE_GAP * (TRACKS.length - 1)) / TRACKS.length;
    let y = HEADER_H;
    for (let i = 0; i < weeks.length; i++) {
        const week = weeks[i];
        const label = weekLabel(week.week);

        ctx.save();
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.font = `bold 20px ${FONT}`;
        ctx.fillStyle = i === 0 ? GOLD : '#ffffff';
        ctx.fillText(label.title.toUpperCase(), PAD, y + 18);
        let lx = PAD + ctx.measureText(label.title.toUpperCase()).width + 14;
        if (label.range) {
            ctx.font = `16px ${FONT}`;
            ctx.fillStyle = theme.muted;
            ctx.fillText(label.range, lx, y + 19);
            lx += ctx.measureText(label.range).width + 14;
        }
        if (i === 0) {
            ctx.font = `bold 12px ${FONT}`;
            const pw = ctx.measureText('LATEST').width + 20;
            roundRect(ctx, lx, y + 7, pw, 24, 12);
            ctx.fillStyle = hexToRgba(GOLD, 0.2);
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = GOLD;
            ctx.stroke();
            ctx.fillStyle = GOLD;
            ctx.fillText('LATEST', lx + 10, y + 20);
        }
        ctx.restore();
        y += WEEK_HEAD;

        for (let c = 0; c < TRACKS.length; c++) {
            const x = PAD + c * (colW + PLAQUE_GAP);
            await drawPlaque(ctx, week.champions?.[TRACKS[c]] ?? null, TRACKS[c], x, y, colW, i === 0);
        }
        y += PLAQUE_H + WEEK_GAP;
    }

    if (footer) {
        ctx.save();
        ctx.font = `15px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.textBaseline = 'bottom';
        ctx.fillText(fitText(ctx, footer, CARD_W - PAD * 2), PAD, height - 16);
        ctx.restore();
    }

    return encodeCanvas(canvas);
}

/** What a screen reader says for the card: every week's champions, as sentences. */
function altText(opts) {
    const parts = [`Hall of Champions${opts.kicker ? ` for ${plain(opts.kicker)}` : ''}.`];
    for (const week of (opts.weeks ?? []).slice(0, MAX_WEEKS)) {
        const label = weekLabel(week.week);
        const lines = TRACKS
            .map(cat => week.champions?.[cat])
            .filter(Boolean)
            .map(ch => `${plain(ch.role).toLowerCase()} ${plain(ch.name) || 'Unknown'}, ${Number(ch.total ?? 0).toLocaleString('en-US')} ${plain(ch.unit)}`
                + (ch.runs > 1 ? ` over ${ch.runs} runs` : ''));
        parts.push(`${label.title}${label.range ? ` (${label.range})` : ''}: ${lines.join('; ') || 'no champions'}.`);
    }
    return parts.join(' ');
}

module.exports = {
    createChampionsHallCard,
    altText,
    roleOf,
    CARD_FILE: 'hall-of-champions.png',
    MAX_WEEKS,
    __test__: { mondayOf, weekLabel, cardHeight },
};
