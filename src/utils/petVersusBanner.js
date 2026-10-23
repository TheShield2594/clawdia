'use strict';

/**
 * The banner a member battle shows its fighters on (#1184): both pets'
 * portraits side by side with a "VS" between them. An embed has one image and
 * one thumbnail, and a thumbnail each would have put one pet in the corner and
 * the other nowhere, so the two are drawn onto one strip.
 *
 * Takes the portrait attachments `petArt` returns (their buffers are what is
 * drawn) and resolves to an AttachmentBuilder, or null when neither pet ships
 * art or drawing fails — the embed text already names both fighters, so a
 * battle never waits on this.
 */

const { AttachmentBuilder } = require('discord.js');
const { encodeCanvas } = require('./canvasEncode');

const W = 480, H = 200, PORTRAIT = 168;
const BANNER_NAME = 'pet-battle-vs.png';

async function portrait(loadImage, art) {
    const data = art?.attachment?.attachment;
    if (!Buffer.isBuffer(data)) return null;
    try { return await loadImage(data); } catch { return null; }
}

async function renderVersusBanner(artA, artB, { alt = 'Both fighters, side by side' } = {}) {
    if (!artA && !artB) return null;
    try {
        const { createCanvas, loadImage } = require('canvas');
        const [imgA, imgB] = await Promise.all([portrait(loadImage, artA), portrait(loadImage, artB)]);
        if (!imgA && !imgB) return null;

        const canvas = createCanvas(W, H);
        const ctx = canvas.getContext('2d');
        const bg = ctx.createLinearGradient(0, 0, W, 0);
        bg.addColorStop(0, '#1f3a5f');
        bg.addColorStop(0.5, '#141821');
        bg.addColorStop(1, '#5f1f2a');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        const y = (H - PORTRAIT) / 2;
        if (imgA) ctx.drawImage(imgA, 16, y, PORTRAIT, PORTRAIT);
        if (imgB) {
            // Mirrored, so the two face each other.
            ctx.save();
            ctx.translate(W - 16, y);
            ctx.scale(-1, 1);
            ctx.drawImage(imgB, 0, 0, PORTRAIT, PORTRAIT);
            ctx.restore();
        }

        ctx.font = 'bold 44px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 6;
        ctx.strokeStyle = '#000000';
        ctx.strokeText('VS', W / 2, H / 2);
        ctx.fillStyle = '#ffd166';
        ctx.fillText('VS', W / 2, H / 2);

        const buffer = await encodeCanvas(canvas);
        return new AttachmentBuilder(buffer, { name: BANNER_NAME, description: alt.slice(0, 1024) });
    } catch (err) {
        console.error('[pet battle] versus banner failed:', err.message);
        return null;
    }
}

module.exports = { renderVersusBanner, BANNER_NAME };
