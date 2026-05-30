'use strict';

const { createCanvas, loadImage, registerFont } = require('canvas');

try { registerFont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',      { family: 'DejaVu Sans' }); } catch {}
try { registerFont('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', { family: 'DejaVu Sans', weight: 'bold' }); } catch {}

const TILE_W   = 220;
const TILE_H   = 260;
const TILE_PAD = 18;
const COLS     = 4;
const HEADER_H = 80;

const THEMES = {
    hunt:          { bgTop: '#1a3318', bgBottom: '#0a160a', accent: '#27ae60', tile: '#27512f', tileInner: '#16331c', name: '#ffffff', price: '#f1c40f', muted: '#9bc8a3' },
    fish:          { bgTop: '#0d2538', bgBottom: '#07182a', accent: '#2980b9', tile: '#1f4566', tileInner: '#12283d', name: '#ffffff', price: '#f1c40f', muted: '#9bc1dc' },
    mine:          { bgTop: '#2e1c10', bgBottom: '#170c05', accent: '#b5651d', tile: '#4d3119', tileInner: '#2b1a0c', name: '#ffffff', price: '#f1c40f', muted: '#d1a988' },
    shop_common:   { bgTop: '#1c1c1c', bgBottom: '#111111', accent: '#7f8c8d', tile: '#333333', tileInner: '#222222', name: '#ffffff', price: '#f1c40f', muted: '#aaaaaa' },
    shop_uncommon: { bgTop: '#152a15', bgBottom: '#0c1c0c', accent: '#27ae60', tile: '#1e4a1e', tileInner: '#0f2a0f', name: '#ffffff', price: '#f1c40f', muted: '#a9d1a9' },
    shop_rare:     { bgTop: '#0e1f3a', bgBottom: '#071428', accent: '#2980b9', tile: '#1a3866', tileInner: '#0f2040', name: '#ffffff', price: '#f1c40f', muted: '#8ab4d6' },
    shop_epic:     { bgTop: '#1a0c2e', bgBottom: '#100720', accent: '#9b59b6', tile: '#301848', tileInner: '#1c0c2e', name: '#ffffff', price: '#f1c40f', muted: '#c49ed6' },
    shop_mythic:   { bgTop: '#2e1800', bgBottom: '#1c1000', accent: '#e67e22', tile: '#4d2e00', tileInner: '#2d1a00', name: '#ffffff', price: '#f1c40f', muted: '#d4a76a' },
};

function getTheme(activity) {
    return THEMES[activity] || THEMES.hunt;
}

async function renderCategoryBanner({ activity, title, subtitle, items, currency }) {
    const theme = getTheme(activity);
    const safeItems = items.slice(0, 16);
    const count = Math.max(1, safeItems.length);
    const cols  = Math.min(COLS, count);
    const rows  = Math.ceil(count / COLS);

    const width  = cols * TILE_W + (cols + 1) * TILE_PAD;
    const height = HEADER_H + rows * TILE_H + (rows + 1) * TILE_PAD;

    const canvas = createCanvas(width, height);
    const ctx    = canvas.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, theme.bgTop);
    bg.addColorStop(1, theme.bgBottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = theme.accent;
    ctx.fillRect(0, 0, width, HEADER_H);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, HEADER_H - 4, width, 4);

    ctx.fillStyle    = '#ffffff';
    ctx.font         = 'bold 30px "DejaVu Sans"';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, 24, HEADER_H / 2 - (subtitle ? 10 : 0));
    if (subtitle) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font      = '16px "DejaVu Sans"';
        ctx.fillText(subtitle, 24, HEADER_H / 2 + 16);
    }

    for (let i = 0; i < safeItems.length; i++) {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const x   = TILE_PAD + col * (TILE_W + TILE_PAD);
        const y   = HEADER_H + TILE_PAD + row * (TILE_H + TILE_PAD);
        await renderTile(ctx, safeItems[i], x, y, theme, currency);
    }

    return canvas.toBuffer('image/png');
}

async function renderTile(ctx, item, x, y, theme, currency) {
    roundRect(ctx, x, y, TILE_W, TILE_H, 14);
    ctx.fillStyle = theme.tile;
    ctx.fill();

    const imgX = x + 12;
    const imgY = y + 12;
    const imgW = TILE_W - 24;
    const imgH = 170;
    roundRect(ctx, imgX, imgY, imgW, imgH, 10);
    ctx.fillStyle = theme.tileInner;
    ctx.fill();

    let drewImage = false;
    if (item.imageBuffer) {
        try {
            const img = await Promise.race([
                loadImage(item.imageBuffer),
                new Promise((_, reject) => setTimeout(() => reject(new Error('loadImage timeout')), 2000))
            ]);
            const fit = fitContain(img.width, img.height, imgW - 16, imgH - 16);
            const dx  = imgX + (imgW - fit.w) / 2;
            const dy  = imgY + (imgH - fit.h) / 2;
            ctx.save();
            roundRect(ctx, imgX, imgY, imgW, imgH, 10);
            ctx.clip();
            ctx.drawImage(img, dx, dy, fit.w, fit.h);
            ctx.restore();
            drewImage = true;
        } catch { /* fall through to glyph */ }
    }
    if (!drewImage) {
        ctx.fillStyle    = '#ffffff';
        ctx.font         = 'bold 72px "DejaVu Sans"';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(item.emoji || '?', imgX + imgW / 2, imgY + imgH / 2);
        ctx.textAlign    = 'start';
    }

    if (item.badge) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        roundRect(ctx, imgX + 8, imgY + 8, 44, 22, 6);
        ctx.fill();
        ctx.fillStyle    = '#ffffff';
        ctx.font         = 'bold 13px "DejaVu Sans"';
        ctx.textBaseline = 'middle';
        ctx.textAlign    = 'center';
        ctx.fillText(item.badge, imgX + 8 + 22, imgY + 8 + 11);
        ctx.textAlign    = 'start';
    }

    ctx.fillStyle    = theme.name;
    ctx.font         = 'bold 17px "DejaVu Sans"';
    ctx.textBaseline = 'top';
    ctx.fillText(truncate(ctx, item.name, TILE_W - 24), x + 12, imgY + imgH + 10);

    if (item.price != null) {
        ctx.fillStyle = theme.price;
        ctx.font      = 'bold 15px "DejaVu Sans"';
        ctx.fillText(`${currency}${item.price.toLocaleString()}`, x + 12, imgY + imgH + 34);
    } else if (item.subline) {
        ctx.fillStyle = theme.muted;
        ctx.font      = '14px "DejaVu Sans"';
        ctx.fillText(truncate(ctx, item.subline, TILE_W - 24), x + 12, imgY + imgH + 34);
    }

    if (item.subline && item.price != null) {
        ctx.fillStyle = theme.muted;
        ctx.font      = '13px "DejaVu Sans"';
        ctx.fillText(truncate(ctx, item.subline, TILE_W - 24), x + 12, imgY + imgH + 54);
    }
}

function fitContain(w, h, maxW, maxH) {
    const r = Math.min(maxW / w, maxH / h);
    return { w: w * r, h: h * r };
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
}

function truncate(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return text + '…';
}

module.exports = { renderCategoryBanner, getTheme };
