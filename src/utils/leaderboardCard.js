'use strict';

/**
 * The leaderboard card: the picture every ranked board carries above its text —
 * `/leaderboard` (every type but the Hall of Champions, which has a card of
 * its own in utils/championsHallCard), `/achievements leaderboard`, `/streak`,
 * `/pet leaderboard`, `/season leaderboard`, `/duel leaderboard`,
 * `/syndicate leaderboard` and `/fish tournament status`. One layout, so the
 * boards read as one family:
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ MY SERVER                                                            │
 *   │ Achievements                                                         │
 *   │ Top 10 by total achievements earned                                  │
 *   │                              ♛                                       │
 *   │   ┌──────────┐        ┌────────────┐        ┌──────────┐             │
 *   │   │  (ava 2) │        │  (ava 1)   │        │  (ava 3) │             │
 *   │   │  Bob     │        │  Alice     │        │  Carol   │             │
 *   │   │  38      │        │  42        │        │  31      │             │
 *   │   └──────────┘        └────────────┘        └──────────┘             │
 *   │ ▐ #4  (a) Dave ──────────────────────────────────────────── 27 ▌    │
 *   │ ▐ #5  (a) Erin ─────────────────────────────────────── 22 ▌         │
 *   │   …                                                                  │
 *   │   YOUR STANDING                                                      │
 *   │ ▐ #14 (a) You ──────────────────────────────────── 9 ▌              │
 *   │ footer                                                               │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * The top three stand on a podium with their avatars in gold, silver and
 * bronze; the rest are rows whose faint bar measures them against first place;
 * the caller, when they are off the board, gets a row of their own under it.
 *
 * The same contract as every card in the family (utils/grindProfileCard): an
 * illustration, not the record — every name and number here is also in the
 * embed text, the attachment carries alt text, and nothing drawn is a currency
 * symbol or an emoji (a guild currency can be a custom Discord emoji, and
 * node-canvas draws colour emoji as boxes), so values are plain numbers and
 * words.
 *
 * @module utils/leaderboardCard
 */

const { createCanvas, loadImage } = require('canvas');
const { EmbedBuilder } = require('discord.js');
const { encodeCanvas } = require('./canvasEncode');
const { primitives } = require('./grindProfileCard');
const { renderAttachment } = require('./grindProfileView');
const { renderQueued } = require('./cardRenderQueue');
const { sendPublicResponse } = require('./interactionAck');

const { FONT, themeFor, paintBackground, drawEntry, roundRect, fitText, shade } = primitives;

const CARD_W = 1000;
const PODIUM_BOTTOM = 500;
const ROWS_TOP = 522;
const ROW_H = 58;
const ROW_GAP = 8;
const YOU_HEAD = 34;
const FOOTER_H = 44;
const PAD = 50;

const MEDAL = ['#ffd166', '#c9d1d9', '#d08b4f'];
const MEDAL_WORD = ['1ST', '2ND', '3RD'];

// The podium: first in the middle and raised, second on the left, third on
// the right — the order a podium is read in.
const PODIUM = [
    { cx: 500, top: 190, w: 290, r: 70 },
    { cx: 208, top: 236, w: 266, r: 56 },
    { cx: 792, top: 236, w: 266, r: 56 },
];

// Stand-in colours for an avatar that would not load, picked by name so a
// member keeps their colour from one render to the next.
const DISC_PALETTE = ['#5dade2', '#58d68d', '#f5b041', '#ec7063', '#af7ac5', '#48c9b0', '#f4d03f', '#dc7633', '#85929e', '#e59866'];

const AVATAR_TIMEOUT_MS = 3_000;
const AVATAR_CACHE_MAX = 300;

// Decoded avatars by URL. Discord's avatar URLs carry the image's hash, so a
// changed avatar is a new key and an entry can never go stale — the cap only
// bounds memory. A failed load is not cached: it may be a blip.
const avatarCache = new Map();

function loadWithTimeout(url, ms) {
    let timer;
    return Promise.race([
        loadImage(url).finally(() => clearTimeout(timer)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('avatar load timed out')), ms); }),
    ]);
}

async function loadAvatar(url) {
    if (!url) return null;
    if (avatarCache.has(url)) return avatarCache.get(url);
    try {
        const img = await loadWithTimeout(url, AVATAR_TIMEOUT_MS);
        if (avatarCache.size >= AVATAR_CACHE_MAX) avatarCache.delete(avatarCache.keys().next().value);
        avatarCache.set(url, img);
        return img;
    } catch {
        return null;
    }
}

function hexToRgba(hex, alpha) {
    const v = parseInt(String(hex).replace('#', ''), 16);
    if (!Number.isFinite(v)) return `rgba(255,255,255,${alpha})`;
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

/** Strips emoji and the joiners around them, which a canvas cannot draw. */
function plain(text) {
    return String(text ?? '')
        .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}|<a?:\w+:\d+>/gu, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function discColor(name) {
    let h = 0;
    for (const ch of String(name ?? '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return DISC_PALETTE[h % DISC_PALETTE.length];
}

function initial(name) {
    const ch = [...plain(name)].find(c => /[\p{L}\p{N}]/u.test(c));
    return ch ? ch.toUpperCase() : '?';
}

/**
 * One portrait in a circle of radius `r` at (cx, cy): the member's avatar, the
 * entry's bundled art (a pet's portrait), or a coloured disc with an initial.
 */
async function drawPortrait(ctx, entry, cx, cy, r, ring, theme) {
    const img = entry.avatar ?? null;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    if (img) {
        ctx.clip();
        ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    } else if (entry.iconId) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fill();
    } else {
        const color = discColor(entry.name);
        const fill = ctx.createRadialGradient(cx, cy - r * 0.4, r * 0.1, cx, cy, r);
        fill.addColorStop(0, shade(color, 0.3));
        fill.addColorStop(1, shade(color, -0.5));
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.font = `bold ${Math.round(r * 0.9)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(initial(entry.name), cx, cy + r * 0.05);
    }
    ctx.restore();

    if (!img && entry.iconId) {
        const s = r * 1.85;
        await drawEntry(ctx, { iconId: entry.iconId, name: entry.name, color: ring }, cx - s / 2, cy - s / 2, s, theme);
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(3, r * 0.08);
    ctx.strokeStyle = ring;
    ctx.stroke();
    ctx.restore();
}

/** A crown, drawn as a shape rather than the emoji a canvas cannot draw. */
function drawCrown(ctx, cx, bottom, w, color) {
    const h = w * 0.62;
    const top = bottom - h;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, bottom);
    ctx.lineTo(cx - w / 2, top + h * 0.3);
    ctx.lineTo(cx - w / 4, top + h * 0.62);
    ctx.lineTo(cx, top);
    ctx.lineTo(cx + w / 4, top + h * 0.62);
    ctx.lineTo(cx + w / 2, top + h * 0.3);
    ctx.lineTo(cx + w / 2, bottom);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, shade(color, 0.35));
    grad.addColorStop(1, shade(color, -0.25));
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = shade(color, -0.5);
    ctx.stroke();
    for (const [x, y] of [[cx - w / 2, top + h * 0.3], [cx, top], [cx + w / 2, top + h * 0.3]]) {
        ctx.beginPath();
        ctx.arc(x, y, w * 0.07, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
    }
    ctx.restore();
}

/** A rank number on a disc, pinned to the bottom of a podium avatar. */
function rankDisc(ctx, text, cx, cy, color) {
    const r = 17;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#0b0b0b';
    ctx.stroke();
    ctx.font = `bold 17px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#111111';
    ctx.fillText(text, cx, cy + 1);
    ctx.restore();
}

/** Sets the largest font from `size` down to `min` that fits `text` in `maxW`. */
function fitFont(ctx, text, size, min, maxW) {
    ctx.font = `bold ${size}px ${FONT}`;
    while (size > min && ctx.measureText(text).width > maxW) {
        size -= 2;
        ctx.font = `bold ${size}px ${FONT}`;
    }
    return size;
}

async function drawPodiumSlot(ctx, entry, slot, place, theme) {
    const color = MEDAL[place];
    const x = slot.cx - slot.w / 2;
    const h = PODIUM_BOTTOM - slot.top;

    // The panel, lit from the top in the medal's colour.
    roundRect(ctx, x, slot.top, slot.w, h, 18);
    const lit = ctx.createLinearGradient(0, slot.top, 0, PODIUM_BOTTOM);
    lit.addColorStop(0, hexToRgba(color, place === 0 ? 0.26 : 0.18));
    lit.addColorStop(1, 'rgba(255,255,255,0.03)');
    ctx.fillStyle = lit;
    ctx.fill();
    ctx.lineWidth = entry.you ? 3 : 2;
    ctx.strokeStyle = entry.you ? theme.accent : hexToRgba(color, 0.55);
    ctx.stroke();

    // A glow behind the avatar, then the avatar breaking the panel's top edge.
    const cy = slot.top + 18 + slot.r;
    const glow = ctx.createRadialGradient(slot.cx, cy, slot.r * 0.4, slot.cx, cy, slot.r * 2);
    glow.addColorStop(0, hexToRgba(color, 0.35));
    glow.addColorStop(1, hexToRgba(color, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(slot.cx - slot.r * 2, cy - slot.r * 2, slot.r * 4, slot.r * 4);

    await drawPortrait(ctx, entry, slot.cx, cy, slot.r, color, theme);
    if (place === 0) drawCrown(ctx, slot.cx, cy - slot.r - 4, 64, color);
    rankDisc(ctx, String(entry.rank ?? place + 1), slot.cx + slot.r * 0.72, cy + slot.r * 0.72, color);

    const inner = slot.w - 32;
    let y = cy + slot.r + 16;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const name = plain(entry.name) || 'Unknown';
    const nameSize = fitFont(ctx, name, place === 0 ? 26 : 22, 16, inner);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fitText(ctx, name, inner), slot.cx, y);
    y += nameSize + 10;

    const value = plain(entry.value);
    const valueSize = fitFont(ctx, value, place === 0 ? 32 : 26, 16, inner);
    ctx.fillStyle = color;
    ctx.fillText(fitText(ctx, value, inner), slot.cx, y);
    y += valueSize + 8;

    const detail = plain(entry.detail);
    if (detail && y + 16 < PODIUM_BOTTOM - 8) {
        ctx.font = `15px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.fillText(fitText(ctx, detail, inner), slot.cx, y);
    }

    // The place, small, in the panel's corner.
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillStyle = hexToRgba(color, 0.9);
    ctx.textAlign = 'left';
    ctx.fillText(MEDAL_WORD[place], x + 14, slot.top + 12);
    ctx.restore();
}

async function drawRow(ctx, entry, y, topScore, theme) {
    const x = PAD, w = CARD_W - PAD * 2;

    roundRect(ctx, x, y, w, ROW_H, 12);
    ctx.fillStyle = theme.panel;
    ctx.fill();

    // How far behind first place, as a faint bar across the row.
    if (topScore > 0 && Number.isFinite(entry.score) && entry.score > 0) {
        const frac = Math.max(0, Math.min(1, entry.score / topScore));
        ctx.save();
        roundRect(ctx, x, y, w, ROW_H, 12);
        ctx.clip();
        const barW = Math.max(24, w * frac);
        const grad = ctx.createLinearGradient(x, 0, x + barW, 0);
        grad.addColorStop(0, hexToRgba(theme.accent, 0.04));
        grad.addColorStop(1, hexToRgba(theme.accent, 0.22));
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barW, ROW_H);
        ctx.restore();
    }

    if (entry.you) {
        roundRect(ctx, x, y, w, ROW_H, 12);
        ctx.lineWidth = 2;
        ctx.strokeStyle = theme.accent;
        ctx.stroke();
    }

    const rank = entry.rank != null ? `#${Number(entry.rank).toLocaleString('en-US')}` : '';
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    fitFont(ctx, rank, 22, 14, 70);
    ctx.fillStyle = entry.you ? theme.accent : theme.muted;
    ctx.fillText(rank, x + 18, y + ROW_H / 2 + 1);
    ctx.restore();

    const ar = 20;
    await drawPortrait(ctx, entry, x + 118, y + ROW_H / 2, ar, entry.you ? theme.accent : 'rgba(255,255,255,0.25)', theme);

    // The value on the right, sized first so the name knows how much room it has.
    const value = plain(entry.value);
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    fitFont(ctx, value, 22, 14, 260);
    const valueW = ctx.measureText(value).width;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(value, x + w - 20, y + ROW_H / 2 + 1);
    ctx.restore();

    const textX = x + 152;
    const textW = w - (textX - x) - valueW - 44;
    const name = plain(entry.name) || 'Unknown';
    const detail = plain(entry.detail);
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `bold 20px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    const label = entry.you ? `${name}  (you)` : name;
    ctx.fillText(fitText(ctx, label, textW), textX, detail ? y + 20 : y + ROW_H / 2 + 1);
    if (detail) {
        ctx.font = `14px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.fillText(fitText(ctx, detail, textW), textX, y + 41);
    }
    ctx.restore();
}

/** The height a card of `rowCount` rows under the podium, and an optional "you" row, draws at. */
function cardHeight(rowCount, hasYou, hasFooter) {
    let h = ROWS_TOP + rowCount * (ROW_H + ROW_GAP);
    if (hasYou) h += YOU_HEAD + ROW_H + ROW_GAP;
    return h + (hasFooter ? FOOTER_H : 18);
}

/**
 * @param {object} opts
 * @param {string}  opts.theme     a utils/grindProfileCard palette ('board', 'hunt', 'pets', …)
 * @param {string}  opts.title     e.g. "Achievements"
 * @param {?string} [opts.kicker]  above the title, e.g. the server's name
 * @param {?string} [opts.subtitle] under the title, e.g. "Top 10 by total earned"
 * @param {{rank?: number, name: string, value: string, detail?: string,
 *          score?: number, avatarUrl?: ?string, iconId?: ?string, you?: boolean}[]} opts.entries
 *        best first; the first three stand on the podium. `score` sizes the
 *        row's bar against first place; `you` outlines the caller's own entry.
 * @param {?object} [opts.you]     the caller's own entry, drawn under the board
 *        when they are not on it (same shape as an entry)
 * @param {?string} [opts.footer]
 * @returns {Promise<Buffer>} PNG
 */
async function createLeaderboardCard(opts) {
    const theme = themeFor(opts.theme);
    const entries = (opts.entries ?? []).slice(0, 10);
    const podium = entries.slice(0, 3);
    const rows = entries.slice(3);
    const you = opts.you && !entries.some(e => e.you) ? { ...opts.you, you: true } : null;
    const footer = plain(opts.footer);

    // Every portrait at once: the avatar loads are network round trips.
    const all = [...entries, ...(you ? [you] : [])];
    const avatars = await Promise.all(all.map(e => loadAvatar(e.avatarUrl)));
    all.forEach((e, i) => { e.avatar = avatars[i]; });

    const height = cardHeight(rows.length, !!you, !!footer);
    const canvas = createCanvas(CARD_W, height);
    const ctx = canvas.getContext('2d');
    paintBackground(ctx, CARD_W, height, theme);

    // A wash of the accent behind the podium.
    const wash = ctx.createRadialGradient(500, 330, 40, 500, 330, 520);
    wash.addColorStop(0, hexToRgba(theme.accent, 0.16));
    wash.addColorStop(1, hexToRgba(theme.accent, 0));
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, CARD_W, PODIUM_BOTTOM + 60);

    // Header.
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const kicker = plain(opts.kicker).toUpperCase();
    if (kicker) {
        ctx.font = `bold 16px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.fillText(fitText(ctx, kicker, CARD_W - PAD * 2), PAD, 32);
    }
    ctx.fillStyle = theme.accent;
    ctx.fillRect(PAD, 58, 6, 44);
    const title = plain(opts.title) || 'Leaderboard';
    fitFont(ctx, title, 40, 24, CARD_W - PAD * 2 - 20);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fitText(ctx, title, CARD_W - PAD * 2 - 20), PAD + 20, 60);
    const subtitle = plain(opts.subtitle);
    if (subtitle) {
        ctx.font = `18px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.fillText(fitText(ctx, subtitle, CARD_W - PAD * 2 - 20), PAD + 20, 110);
    }
    ctx.restore();

    for (let i = 0; i < podium.length; i++) {
        await drawPodiumSlot(ctx, podium[i], PODIUM[i], i, theme);
    }

    const topScore = Number.isFinite(entries[0]?.score) ? entries[0].score : 0;
    let y = ROWS_TOP;
    for (const entry of rows) {
        await drawRow(ctx, entry, y, topScore, theme);
        y += ROW_H + ROW_GAP;
    }

    if (you) {
        ctx.save();
        ctx.font = `bold 14px ${FONT}`;
        ctx.fillStyle = theme.muted;
        ctx.textBaseline = 'top';
        ctx.fillText('YOUR STANDING', PAD + 4, y + 10);
        ctx.restore();
        y += YOU_HEAD;
        await drawRow(ctx, you, y, topScore, theme);
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

/** What a screen reader says for the card: the same board, as a sentence. */
function altText(opts) {
    const title = plain(opts.title) || 'Leaderboard';
    // "Achievements leaderboard", but not "Pet Leaderboard leaderboard".
    const named = /leaderboard|ladder|race|records|all-time|tournament/i.test(title) ? title : `${title} leaderboard`;
    const board = `${named}${opts.kicker ? ` for ${plain(opts.kicker)}` : ''}`;
    const line = e => `${e.rank ?? '?'}. ${plain(e.name) || 'Unknown'}, ${plain(e.value)}${e.detail ? ` (${plain(e.detail)})` : ''}`;
    const parts = [`${board}.`, `${(opts.entries ?? []).slice(0, 10).map(line).join('; ')}.`];
    if (opts.you && !(opts.entries ?? []).some(e => e.you)) parts.push(`You: ${line(opts.you)}.`);
    return parts.join(' ');
}

/** A PNG avatar URL for a discord.js User (or GuildMember), or null. */
function avatarUrlOf(user) {
    if (!user || typeof user.displayAvatarURL !== 'function') return null;
    try {
        return user.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true });
    } catch {
        return null;
    }
}

/** A name for the card: a member's display name, a user's global or user name. */
function displayNameOf(user) {
    return user?.displayName ?? user?.globalName ?? user?.username ?? null;
}

/**
 * Sends a board: the card as an image-only embed leading the message, with the
 * board's text embed under it as the record. Defers first, since the avatar
 * loads and the draw can outrun Discord's three-second window. If the card
 * cannot be drawn — refused by the render queue, or the render throws — the
 * text embed goes out alone, as boards always did.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').EmbedBuilder} embed   the text half
 * @param {object} cardOpts  createLeaderboardCard's options
 * @param {object} [extra]   more reply fields (components, …)
 */
async function sendBoard(interaction, embed, cardOpts, extra = {}) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply();
    const file = await boardAttachment(interaction.guild?.id, cardOpts);
    const payload = file
        ? { ...extra, embeds: [boardImageEmbed(embed, file), embed], files: [file] }
        : { ...extra, embeds: [embed] };
    return sendPublicResponse(interaction, payload);
}

/**
 * Sends a board builder's payload (utils/grindLeaderboard,
 * utils/economyLeaderboards): through `sendBoard` when it carries a picture
 * card, else as it is — an empty board's ephemeral note, say.
 */
async function replyBoard(interaction, board) {
    if (!board.card) return interaction.reply(board);
    const { card, embeds, ...extra } = board;
    return sendBoard(interaction, embeds[0], card, extra);
}

const CARD_FILE = 'leaderboard.png';

/**
 * The card as an attachment, or null when it was refused or failed to draw.
 * Options with a `draw` of their own (and its `describe`, for the alt text)
 * are another card in the family — the Hall of Champions
 * (utils/championsHallCard) — sent the same way; anything else is a board.
 */
async function boardAttachment(guildId, cardOpts) {
    if (!cardOpts) return null;
    const draw = cardOpts.draw ?? createLeaderboardCard;
    const describe = cardOpts.describe ?? altText;
    if (!cardOpts.draw && !cardOpts.entries?.length) return null;
    return renderQueued(guildId ?? 'dm', () =>
        renderAttachment(() => draw(cardOpts), cardOpts.fileName ?? CARD_FILE, describe(cardOpts)));
}

/** The image-only embed the card rides in, in the text embed's colour. */
function boardImageEmbed(embed, file) {
    const image = new EmbedBuilder().setImage(`attachment://${file.name}`);
    const color = embed?.data?.color;
    if (color != null) image.setColor(color);
    return image;
}

module.exports = {
    createLeaderboardCard,
    sendBoard,
    replyBoard,
    boardAttachment,
    boardImageEmbed,
    altText,
    avatarUrlOf,
    displayNameOf,
    CARD_FILE,
    // The drawing pieces, for the other cards in the family (the Hall of
    // Champions) so a champion's portrait and crown match the podium's.
    drawing: { loadAvatar, plain, hexToRgba, fitFont, drawPortrait, drawCrown, MEDAL },
    __test__: { plain, cardHeight, initial, avatarCache },
};
