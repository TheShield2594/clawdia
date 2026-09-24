// Mockup for the slots table image (see the linked issue). Run: node docs/mockups/slots-machine-table.js
// Draws /casino slots in blackjackTable.js's visual language: the felt, the rail, the pills,
// the chip and the banner, with a reel window where the cards go. Not wired into the game.
const R = require('path').join(__dirname, '..', '..') + '/';
const { createCanvas, loadImage } = require('canvas');
const { ensureFontsRegistered } = require(R + 'src/utils/registerFonts');
const fs = require('fs');
ensureFontsRegistered();

const W = 960, H = 560, FONT = '"DejaVu Sans", sans-serif', GOLD = '#f4c542';
const TONES = {
    win: { fill: '#1f9d55', text: '#ffffff' }, lose: { fill: '#c62839', text: '#ffffff' },
    push: { fill: '#e0a526', text: '#1b1300' }, gold: { fill: GOLD, text: '#2a1d00' },
    info: { fill: 'rgba(0,0,0,0.55)', text: '#ffffff' },
};
const art = {};
const sym = n => art[n];

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function pill(ctx, text, cx, cy, tone = 'info', size = 18) {
    const { fill, text: ink } = TONES[tone]; ctx.save(); ctx.font = `bold ${size}px ${FONT}`;
    const w = ctx.measureText(text).width + size * 1.4, h = size * 1.75;
    roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h / 2); ctx.fillStyle = fill; ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 6; ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, cx, cy + 1); ctx.restore();
}
function drawChip(ctx, amount, cx, cy) {
    const body = '#1d4ed8', ink = '#fff', r = 30; ctx.save();
    for (let i = 2; i >= 1; i--) { ctx.beginPath(); ctx.ellipse(cx, cy + i * 5, r, r * 0.92, 0, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill(); ctx.beginPath(); ctx.ellipse(cx, cy + i * 5 - 1, r, r * 0.92, 0, 0, Math.PI * 2); ctx.fillStyle = body; ctx.fill(); }
    ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 6; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = body; ctx.fill(); ctx.shadowColor = 'transparent';
    ctx.strokeStyle = '#f5f5f4'; ctx.lineWidth = 7; for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; ctx.beginPath(); ctx.arc(cx, cy, r - 3.5, a, a + 0.32); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(cx, cy, r - 10, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = ink; ctx.font = `bold 14px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(amount), cx, cy + 1); ctx.restore();
}
// The table, as blackjack draws it, in the slots palette: same grain, same rail.
function drawFelt(ctx) {
    const g = ctx.createRadialGradient(W / 2, H * 0.42, 60, W / 2, H * 0.5, W * 0.72);
    g.addColorStop(0, '#5a3aa8'); g.addColorStop(0.6, '#35207a'); g.addColorStop(1, '#170d3a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalAlpha = 0.035; ctx.strokeStyle = '#fff';
    for (let d = -H; d < W; d += 6) { ctx.beginPath(); ctx.moveTo(d, 0); ctx.lineTo(d + H, H); ctx.stroke(); }
    ctx.restore();
    ctx.save(); roundRect(ctx, 7, 7, W - 14, H - 14, 26); ctx.lineWidth = 14; ctx.strokeStyle = '#4a2a14'; ctx.stroke();
    roundRect(ctx, 14, 14, W - 28, H - 28, 20); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,214,150,0.35)'; ctx.stroke(); ctx.restore();
}
function drawBanner(ctx, text, tone, y) {
    const { fill } = TONES[tone]; ctx.save(); ctx.font = `bold 38px ${FONT}`;
    const w = Math.min(W - 120, ctx.measureText(text).width + 80), h = 60, x = W / 2 - w / 2;
    ctx.shadowColor = fill; ctx.shadowBlur = 28; roundRect(ctx, x, y - h / 2, w, h, 14); ctx.fillStyle = 'rgba(14,8,34,0.85)'; ctx.fill();
    ctx.shadowBlur = 0; ctx.lineWidth = 3; ctx.strokeStyle = fill; ctx.stroke();
    ctx.fillStyle = fill; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, W / 2, y + 2, w - 40); ctx.restore();
}

// ── The reels ──
const REEL_W = 150, CELL = 96, GAP = 16, WIN_X = (W - (3 * REEL_W + 2 * GAP)) / 2, WIN_Y = 70, WIN_H = CELL * 3;
function reelX(i) { return WIN_X + i * (REEL_W + GAP); }
function drawReel(ctx, i, cells, { spinning = false, glow = null, lineHit = false } = {}) {
    const x = reelX(i), y = WIN_Y;
    ctx.save();
    if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = 26; }
    roundRect(ctx, x, y, REEL_W, WIN_H, 12); ctx.fillStyle = '#fbfaf7'; ctx.fill();
    ctx.shadowBlur = 0; ctx.restore();
    ctx.save(); roundRect(ctx, x, y, REEL_W, WIN_H, 12); ctx.clip();
    // The reel's curve: darker at the top and bottom.
    const shade = ctx.createLinearGradient(0, y, 0, y + WIN_H);
    shade.addColorStop(0, 'rgba(40,20,80,0.30)'); shade.addColorStop(0.3, 'rgba(40,20,80,0)'); shade.addColorStop(0.7, 'rgba(40,20,80,0)'); shade.addColorStop(1, 'rgba(40,20,80,0.30)');
    if (spinning) {
        // Motion: symbols smeared down the strip, over a streaked face.
        const seq = ['cherry', 'bell', 'lemon', 'star', 'grape', 'diamond', 'cherry'];
        for (let k = 0; k < seq.length; k++) for (let s = 0; s < 5; s++) {
            ctx.globalAlpha = 0.16; ctx.drawImage(sym(seq[k]), x + 35, y - 40 + k * 62 + s * 9, 80, 80);
        }
        ctx.globalAlpha = 1;
        const streak = ctx.createLinearGradient(x, 0, x + REEL_W, 0);
        streak.addColorStop(0, 'rgba(255,255,255,0.0)'); streak.addColorStop(0.5, 'rgba(255,255,255,0.55)'); streak.addColorStop(1, 'rgba(255,255,255,0.0)');
        ctx.fillStyle = streak; ctx.fillRect(x, y, REEL_W, WIN_H);
    } else {
        cells.forEach((name, r) => {
            const s = r === 1 ? 78 : 64;
            ctx.globalAlpha = r === 1 ? 1 : 0.5;
            ctx.drawImage(sym(name), x + (REEL_W - s) / 2, y + r * CELL + (CELL - s) / 2, s, s);
        });
        ctx.globalAlpha = 1;
    }
    ctx.fillStyle = shade; ctx.fillRect(x, y, REEL_W, WIN_H);
    ctx.restore();
    if (lineHit) {
        ctx.save(); ctx.shadowColor = GOLD; ctx.shadowBlur = 18; roundRect(ctx, x + 6, y + CELL + 4, REEL_W - 12, CELL - 8, 10);
        ctx.lineWidth = 3; ctx.strokeStyle = GOLD; ctx.stroke(); ctx.restore();
    }
}
function drawPayline(ctx) {
    const y = WIN_Y + CELL * 1.5;
    ctx.save(); ctx.fillStyle = GOLD;
    for (const [x, dir] of [[WIN_X - 14, 1], [W - WIN_X + 14, -1]]) {
        ctx.beginPath(); ctx.moveTo(x + dir * 12, y); ctx.lineTo(x - dir * 6, y - 12); ctx.lineTo(x - dir * 6, y + 12); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 0.35; ctx.fillRect(WIN_X, y - 1, W - WIN_X * 2, 2); ctx.restore();
}
function heat(ctx, n, hot) {
    pill(ctx, hot ? 'HOT SPIN' : `HEAT ${'■'.repeat(n)}${'□'.repeat(10 - n)}`, 150, 38, hot ? 'gold' : 'info', 14);
}

async function frame(view) {
    const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
    drawFelt(ctx);
    pill(ctx, `SLOTS · BET ${view.bet.toLocaleString('en-US')}`, W / 2, 38);
    pill(ctx, `POT ${view.pot}`, W - 150, 38, 'gold', 14);
    heat(ctx, view.heat, view.hot);
    view.reels.forEach((r, i) => drawReel(ctx, i, r.cells, r));
    drawPayline(ctx);
    drawChip(ctx, view.bet, WIN_X - 70, WIN_Y + WIN_H - 34);
    if (view.tag) pill(ctx, view.tag.text, W / 2, 392, view.tag.tone, 16);
    if (view.banner) drawBanner(ctx, view.banner.text, view.banner.tone, 470);
    else if (view.status) pill(ctx, view.status, W / 2, 470, 'info', 16);
    return canvas;
}

(async () => {
    for (const n of ['cherry', 'lemon', 'grape', 'bell', 'diamond', 'star', 'wild', 'boost', 'scatter']) art[n] = await loadImage(`${R}src/assets/slot-symbols/${n}.png`);
    const base = { bet: 250, pot: '48.2K', heat: 5 };
    const states = [
        ['1 · Spinning', { ...base, reels: [{ spinning: true }, { spinning: true }, { spinning: true }], status: 'SPINNING…' }],
        ['2 · Last reel holds', { ...base, reels: [{ cells: ['star', 'wild', 'grape'] }, { cells: ['diamond', 'wild', 'cherry'] }, { spinning: true, glow: GOLD }], tag: { text: 'ONE MORE WILD FOR THE JACKPOT', tone: 'gold' } }],
        ['3 · A win', { ...base, heat: 6, reels: [{ cells: ['star', 'wild', 'grape'], lineHit: true }, { cells: ['diamond', 'wild', 'cherry'], lineHit: true }, { cells: ['lemon', 'diamond', 'bell'], lineHit: true }], tag: { text: 'THREE DIAMONDS · 40×', tone: 'win' }, banner: { text: 'MEGA WIN  +9,750', tone: 'gold' } }],
        ['4 · Jackpot', { ...base, pot: '10K', reels: [{ cells: ['diamond', 'wild', 'lemon'], lineHit: true, glow: GOLD }, { cells: ['star', 'wild', 'grape'], lineHit: true, glow: GOLD }, { cells: ['bell', 'wild', 'cherry'], lineHit: true, glow: GOLD }], tag: { text: 'TRIPLE WILD · 100× + THE POT', tone: 'gold' }, banner: { text: 'JACKPOT  +73,250', tone: 'gold' } }],
        ['5 · A loss', { ...base, heat: 7, reels: [{ cells: ['bell', 'cherry', 'star'] }, { cells: ['grape', 'lemon', 'cherry'] }, { cells: ['cherry', 'grape', 'diamond'] }], banner: { text: 'NO WIN', tone: 'lose' } }],
        ['6 · Hot Spin', { ...base, heat: 10, hot: true, reels: [{ cells: ['grape', 'star', 'cherry'], glow: '#ff7a1a' }, { spinning: true }, { spinning: true }], tag: { text: 'HOT SPIN · REEL 1 LOCKED', tone: 'gold' } }],
    ];
    const frames = [];
    for (const [label, v] of states) {
        const c = await frame(v);
        frames.push([label, c]);
        fs.writeFileSync(`${require('os').tmpdir()}/slots-mock-${label.split(' · ')[0]}.png`, c.toBuffer());
    }
    // A contact sheet for the issue: two columns, captioned.
    const cols = 2, pad = 30, cap = 44, rows = Math.ceil(frames.length / cols);
    const sheet = createCanvas(cols * W + (cols + 1) * pad, rows * (H + cap) + (rows + 1) * pad - pad + 20);
    const s = sheet.getContext('2d'); s.fillStyle = '#1e1f22'; s.fillRect(0, 0, sheet.width, sheet.height);
    frames.forEach(([label, c], i) => {
        const x = pad + (i % cols) * (W + pad), y = pad + Math.floor(i / cols) * (H + cap + pad);
        s.fillStyle = '#dbdee1'; s.font = `bold 24px ${FONT}`; s.fillText(label, x, y + 26);
        s.drawImage(c, x, y + cap);
    });
    fs.writeFileSync(`${__dirname}/slots-machine-table.jpg`, sheet.toBuffer('image/jpeg', { quality: 0.9 }));
    console.log('ok', sheet.width, sheet.height);
})();
