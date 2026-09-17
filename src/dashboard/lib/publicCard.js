'use strict';

// The share image for a public player card (#1018).
//
// A link to /s/:guildId/u/:userId is shared overwhelmingly in Discord, and
// Discord's unfurler renders a raster og:image, not the HTML card — so the page
// needs a PNG the same way the landing page does. This reuses the paw, the pill
// and the palette from scripts/make-og-image.js so a shared player card reads as
// the same product as the landing card, rather than a second drawing that
// drifted from it.
//
// Unlike the landing card, this one is per-player and cannot be a committed PNG,
// so it is drawn per request. The route caches it and rate-limits it; node-canvas
// registers the DejaVu faces registerFonts.js already ships for every card the
// bot draws, so nothing new is vendored to render it.

const { createCanvas } = require('canvas');
const { ensureFontsRegistered } = require('../../utils/registerFonts');
const { encodeCanvas } = require('../../utils/canvasEncode');
const {
    drawPaw,
    roundedRect,
    WIDTH,
    HEIGHT,
    MARGIN,
    palette,
} = require('../../../scripts/make-og-image');

const { CREAM_50, CREAM_100, CREAM_200, INK_950, INK_500, RUST } = palette;

/** Trim a string to fit a max pixel width, adding an ellipsis when it is cut. */
function fit(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let cut = text;
    while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
        cut = cut.slice(0, -1);
    }
    return `${cut}…`;
}

/**
 * Draw a player card to a PNG buffer.
 *
 * Async because the encode is: the one-argument `canvas.toBuffer()` blocks the
 * event loop, and the dashboard shares its process with the gateway (#592), so
 * the pixels are handed to `encodeCanvas` to serialize off-thread.
 *
 * @param {object} card the shape buildPlayerCard returns
 * @returns {Promise<Buffer>} image/png
 */
async function renderPlayerCard(card) {
    ensureFontsRegistered();

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'alphabetic';

    // Background, watermark paw and the ink rule down the left edge — the same
    // three moves the landing card opens with, so the two share a frame.
    ctx.fillStyle = CREAM_50;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    drawPaw(ctx, WIDTH - 350, HEIGHT - 396, 470, CREAM_200, null);
    ctx.fillStyle = INK_950;
    ctx.fillRect(0, 0, 14, HEIGHT);

    // Lockup, smaller than the landing card's so the player's name is the
    // headline rather than the brand.
    drawPaw(ctx, MARGIN, 66, 34, INK_950, RUST);
    ctx.fillStyle = INK_500;
    ctx.font = '26px "DejaVu Serif"';
    ctx.fillText('Clawdia', MARGIN + 46, 92);

    // The server this card belongs to, as an eyebrow above the name.
    ctx.font = '24px "DejaVu Sans"';
    ctx.fillStyle = INK_500;
    ctx.fillText(fit(ctx, `${card.guild?.name ?? 'Server'} · Level ${card.level} · Rank #${card.rank}`, WIDTH - MARGIN * 2), MARGIN, 168);

    // The player's name — the headline.
    ctx.font = 'bold 72px "DejaVu Sans"';
    ctx.fillStyle = INK_950;
    ctx.fillText(fit(ctx, card.name ?? 'Member', WIDTH - MARGIN * 2), MARGIN, 248);

    // The prestige title, when they have one, in rust under the name.
    if (card.prestigeTitle) {
        ctx.font = '30px "DejaVu Sans"';
        ctx.fillStyle = RUST;
        ctx.fillText(fit(ctx, card.prestigeTitle, WIDTH - MARGIN * 2), MARGIN, 296);
    }

    // Three stat tiles: net worth, streak, achievements. Drawn as labelled
    // figures rather than a paragraph so the card reads at a thumbnail.
    const stats = [
        { label: 'NET WORTH', value: Number(card.netWorth ?? 0).toLocaleString() },
        { label: 'STREAK', value: `${card.streak ?? 0} day${card.streak === 1 ? '' : 's'}` },
        { label: 'ACHIEVEMENTS', value: String(card.achievementsCount ?? 0) },
    ];
    const tileW = (WIDTH - MARGIN * 2 - 40) / 3;
    const tileY = 360;
    stats.forEach((s, i) => {
        const x = MARGIN + i * (tileW + 20);
        ctx.fillStyle = CREAM_100;
        roundedRect(ctx, x, tileY, tileW, 130, 16);
        ctx.fill();
        ctx.fillStyle = INK_500;
        ctx.font = '20px "DejaVu Sans"';
        ctx.fillText(s.label, x + 24, tileY + 44);
        ctx.fillStyle = INK_950;
        ctx.font = 'bold 40px "DejaVu Sans"';
        ctx.fillText(fit(ctx, s.value, tileW - 48), x + 24, tileY + 98);
    });

    // The pill the landing card ends on, reused to say this is a public profile.
    ctx.font = '25px "DejaVu Sans"';
    const pillText = 'Public profile · clawdia';
    const pillWidth = ctx.measureText(pillText).width + 56;
    ctx.fillStyle = CREAM_100;
    roundedRect(ctx, MARGIN, HEIGHT - 110, pillWidth, 56, 28);
    ctx.fill();
    ctx.fillStyle = RUST;
    ctx.fillText(pillText, MARGIN + 28, HEIGHT - 73);

    return encodeCanvas(canvas, 'image/png');
}

module.exports = { renderPlayerCard };
