'use strict';

/**
 * Draws the roulette table: a top-down single-zero wheel with the ball, and
 * beside it the result, the player's bet and chip, a result banner, a small
 * betting layout lit up with the pockets the bet covers, and the recent spins.
 *
 * The wheel's moving parts — the number ring, the pockets, the cone and the
 * turret — are drawn once per process into an offscreen canvas and rotated per
 * frame, so a spin costs one image composite per frame rather than 37 wedges
 * and 37 rotated labels.
 *
 * `renderRouletteTable` takes a plain view (see the typedef) rather than the
 * game's state, so it can be drawn and looked at without spinning. It resolves
 * to a JPEG buffer; the encode runs off the event loop.
 *
 * @module games/casino/rouletteTable
 */

const { createCanvas } = require('canvas');
const { ensureFontsRegistered } = require('../../utils/registerFonts');
const { encodeCanvas } = require('../../utils/canvasEncode');
const { FONT, GOLD, TONES, roundRect, feltGrain, drawRail, drawChip, shortAmount } = require('./tableArt');
const { WHEEL_ORDER, POCKETS, colorOf } = require('./rouletteWheel');

ensureFontsRegistered();

const W = 1000;
const H = 560;

// The wheel.
const CX = 292;
const CY = 280;
const R_OUTER   = 252;   // outside of the wooden bowl
const R_TRACK   = 226;   // inside of the rim: the ball track starts here
const R_NUMBERS = 196;   // outside of the number ring (the rotating part)
const R_POCKETS = 166;   // number ring gives way to the pockets
const R_CONE    = 134;   // pockets give way to the cone
const BALL_ON_TRACK  = 211;
const BALL_IN_POCKET = 150;
const BALL_R = 9;
const STEP = (Math.PI * 2) / POCKETS;
const TOP  = -Math.PI / 2;

// The side panel.
const PX = 572;
const PW = 398;

const POCKET_FILL = { red: '#c0182f', black: '#141417', green: '#138a45' };
const POCKET_EDGE = { red: '#e6394f', black: '#3a3a40', green: '#23b764' };

/**
 * @typedef {object} RouletteFrame
 * @property {number} wheel     rotation applied to the wheel, radians
 * @property {number} ball      where the ball is, radians, screen space
 * @property {boolean} onTrack  on the outer track (true) or in a pocket (false)
 * @property {number} speed     0 at rest, 1 at full tilt: drives the blur
 *
 * @typedef {{ text: string, tone: keyof TONES }} Tag
 *
 * @typedef {object} RouletteView
 * @property {RouletteFrame} frame
 * @property {?number} result   the winning number, or null while spinning
 * @property {string} betLabel  "RED", "#17"
 * @property {string} odds      "1:1"
 * @property {number} bet       the stake, drawn as a chip
 * @property {number[]} covered the pockets the bet wins on
 * @property {?Tag} [banner]
 * @property {number[]} [history]  recent results, oldest first
 */

// ── The wheel ────────────────────────────────────────────────────────────────

/** Angle of the centre of the pocket at `index` on an unrotated wheel. */
const pocketAngle = index => TOP + index * STEP;

/** A ring segment between two radii and two angles, as the current path. */
function annularSector(ctx, cx, cy, rIn, rOut, a0, a1) {
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, a0, a1);
    ctx.arc(cx, cy, rIn, a1, a0, true);
    ctx.closePath();
}

let rotorCache = null;

/**
 * The part of the wheel that turns — number ring, pockets, cone, turret —
 * drawn once, centred in a square canvas, with zero at twelve o'clock.
 */
function rotor() {
    if (rotorCache) return rotorCache;
    const size = R_NUMBERS * 2 + 4;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const c = size / 2;

    // Number ring.
    WHEEL_ORDER.forEach((n, i) => {
        const a = pocketAngle(i);
        const colour = colorOf(n);
        annularSector(ctx, c, c, R_POCKETS, R_NUMBERS, a - STEP / 2, a + STEP / 2);
        const g = ctx.createRadialGradient(c, c, R_POCKETS, c, c, R_NUMBERS);
        g.addColorStop(0, POCKET_FILL[colour]);
        g.addColorStop(1, POCKET_EDGE[colour]);
        ctx.fillStyle = g;
        ctx.fill();

        ctx.save();
        ctx.translate(c + Math.cos(a) * (R_NUMBERS - 15), c + Math.sin(a) * (R_NUMBERS - 15));
        ctx.rotate(a + Math.PI / 2);
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${n >= 10 ? 15 : 17}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(n), 0, 0);
        ctx.restore();
    });

    // Pockets: the same colours, darker and shaded, as though recessed.
    WHEEL_ORDER.forEach((n, i) => {
        const a = pocketAngle(i);
        annularSector(ctx, c, c, R_CONE, R_POCKETS, a - STEP / 2, a + STEP / 2);
        const g = ctx.createRadialGradient(c, c, R_CONE, c, c, R_POCKETS);
        g.addColorStop(0, '#0b0b0d');
        g.addColorStop(0.55, POCKET_FILL[colorOf(n)]);
        g.addColorStop(1, '#0b0b0d');
        ctx.fillStyle = g;
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
    });

    // Frets: the metal dividers between pockets, and the rings either side.
    ctx.strokeStyle = '#d9b75a';
    ctx.lineWidth = 1.6;
    for (let i = 0; i < POCKETS; i++) {
        const a = pocketAngle(i) - STEP / 2;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * R_CONE, c + Math.sin(a) * R_CONE);
        ctx.lineTo(c + Math.cos(a) * R_NUMBERS, c + Math.sin(a) * R_NUMBERS);
        ctx.stroke();
    }
    for (const [r, w] of [[R_NUMBERS, 2.5], [R_POCKETS, 2], [R_CONE, 3]]) {
        ctx.beginPath();
        ctx.arc(c, c, r, 0, Math.PI * 2);
        ctx.lineWidth = w;
        ctx.stroke();
    }

    // The cone: turned wood, lighter toward the light.
    const cone = ctx.createRadialGradient(c - 30, c - 40, 10, c, c, R_CONE);
    cone.addColorStop(0, '#9a6232');
    cone.addColorStop(0.55, '#6a3b17');
    cone.addColorStop(1, '#3a1e09');
    ctx.beginPath();
    ctx.arc(c, c, R_CONE - 1.5, 0, Math.PI * 2);
    ctx.fillStyle = cone;
    ctx.fill();
    // Wood grain: faint concentric rings.
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    for (let r = 30; r < R_CONE - 6; r += 9) {
        ctx.beginPath();
        ctx.arc(c, c, r, 0, Math.PI * 2);
        ctx.stroke();
    }

    // The turret: four arms and a knob, in brass.
    const brass = ctx.createLinearGradient(c - 90, c - 90, c + 90, c + 90);
    brass.addColorStop(0, '#fff1b8');
    brass.addColorStop(0.5, '#d4a93a');
    brass.addColorStop(1, '#7a5a14');
    ctx.save();
    ctx.translate(c, c);
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = brass;
    for (let k = 0; k < 4; k++) {
        ctx.save();
        ctx.rotate((k * Math.PI) / 2 + Math.PI / 4);
        roundRect(ctx, -5, -92, 10, 92, 4);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, -92, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(0, 0, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(-6, -7, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fill();
    ctx.restore();

    rotorCache = canvas;
    return canvas;
}

/** The bowl the wheel sits in: wooden rim, gold edge and the ball track. Doesn't turn. */
function drawBowl(ctx) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 10;
    const wood = ctx.createRadialGradient(CX - 60, CY - 80, 40, CX, CY, R_OUTER);
    wood.addColorStop(0, '#8a5227');
    wood.addColorStop(0.7, '#5a2f10');
    wood.addColorStop(1, '#2e1605');
    ctx.beginPath();
    ctx.arc(CX, CY, R_OUTER, 0, Math.PI * 2);
    ctx.fillStyle = wood;
    ctx.fill();
    ctx.restore();

    // Gold lip on the rim.
    ctx.save();
    ctx.beginPath();
    ctx.arc(CX, CY, R_OUTER - 5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(244,197,66,0.75)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // The ball track: polished, dark, with a sheen.
    const track = ctx.createRadialGradient(CX, CY, R_NUMBERS, CX, CY, R_TRACK);
    track.addColorStop(0, '#1d140d');
    track.addColorStop(0.6, '#3b2717');
    track.addColorStop(1, '#170e07');
    ctx.beginPath();
    ctx.arc(CX, CY, R_TRACK, 0, Math.PI * 2);
    ctx.fillStyle = track;
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.arc(CX, CY, R_TRACK - 8, Math.PI * 1.1, Math.PI * 1.6);
    ctx.strokeStyle = 'rgba(255,230,190,0.18)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.restore();

    // Deflectors: the brass diamonds on the track that scatter the ball.
    ctx.fillStyle = '#d4a93a';
    for (let k = 0; k < 8; k++) {
        const a = TOP + (k * Math.PI) / 4 + Math.PI / 8;
        const x = CX + Math.cos(a) * (R_TRACK - 13);
        const y = CY + Math.sin(a) * (R_TRACK - 13);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(0, -5);
        ctx.lineTo(6, 0);
        ctx.lineTo(0, 5);
        ctx.lineTo(-6, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }
}

/** The turning part of the wheel, blurred by its speed. */
function drawRotor(ctx, angle, speed) {
    const img = rotor();
    const half = img.width / 2;
    const at = (a, alpha) => {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(CX, CY);
        ctx.rotate(a);
        ctx.drawImage(img, -half, -half);
        ctx.restore();
    };
    at(angle, 1);
    // Motion blur: ghosts trailing the direction of travel (clockwise).
    const ghosts = speed > 0.05 ? 4 : 0;
    for (let k = 1; k <= ghosts; k++) at(angle - k * STEP * 0.35 * speed, 0.22);
}

/** The ball, with a streak behind it when it is moving. */
function drawBall(ctx, angle, radius, speed) {
    // The ball runs anticlockwise, so the streak is at larger angles.
    const streak = Math.round(10 * speed);
    for (let k = streak; k >= 1; k--) {
        const a = angle + k * 0.045;
        ctx.beginPath();
        ctx.arc(CX + Math.cos(a) * radius, CY + Math.sin(a) * radius, BALL_R * (1 - k / (streak + 4)), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${0.28 * (1 - k / (streak + 1))})`;
        ctx.fill();
    }
    const x = CX + Math.cos(angle) * radius;
    const y = CY + Math.sin(angle) * radius;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 3;
    const g = ctx.createRadialGradient(x - 3, y - 3, 1, x, y, BALL_R);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.6, '#e8e8ea');
    g.addColorStop(1, '#9a9aa2');
    ctx.beginPath();
    ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
}

/** The winning pocket at twelve o'clock, lit, and the marker above it. */
function drawWinGlow(ctx) {
    ctx.save();
    annularSector(ctx, CX, CY, R_CONE, R_NUMBERS, TOP - STEP / 2, TOP + STEP / 2);
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 22;
    ctx.strokeStyle = '#fff6d6';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
}

function drawMarker(ctx) {
    const y = CY - R_OUTER + 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(CX - 13, y - 14);
    ctx.lineTo(CX + 13, y - 14);
    ctx.lineTo(CX, y + 12);
    ctx.closePath();
    ctx.fillStyle = GOLD;
    ctx.fill();
    ctx.restore();
}

// ── The felt ─────────────────────────────────────────────────────────────────

function drawFelt(ctx) {
    const g = ctx.createRadialGradient(W * 0.55, H * 0.45, 60, W / 2, H / 2, W * 0.75);
    g.addColorStop(0, '#1f7d52');
    g.addColorStop(0.6, '#125536');
    g.addColorStop(1, '#08301e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    feltGrain(ctx, W, H);
    drawRail(ctx, W, H);
}

// ── The panel ────────────────────────────────────────────────────────────────

function drawHeading(ctx) {
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(244,197,66,0.9)';
    ctx.font = `bold 22px ${FONT}`;
    ctx.fillText('EUROPEAN ROULETTE', PX, 56);
    ctx.fillStyle = 'rgba(244,197,66,0.5)';
    ctx.font = `bold 12px ${FONT}`;
    ctx.fillText('SINGLE ZERO  ·  STRAIGHT UP PAYS 35 TO 1', PX, 76);
    ctx.restore();
}

/** The big number: the pocket that won, or a question mark while the ball runs. */
function drawResultTile(ctx, result) {
    const x = PX;
    const y = 94;
    const s = 150;
    ctx.save();
    ctx.shadowColor = result === null ? 'rgba(0,0,0,0.5)' : POCKET_EDGE[colorOf(result)];
    ctx.shadowBlur = result === null ? 12 : 26;
    roundRect(ctx, x, y, s, s, 20);
    if (result === null) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
    } else {
        const g = ctx.createLinearGradient(x, y, x, y + s);
        g.addColorStop(0, POCKET_EDGE[colorOf(result)]);
        g.addColorStop(1, POCKET_FILL[colorOf(result)]);
        ctx.fillStyle = g;
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = result === null ? 'rgba(244,197,66,0.35)' : GOLD;
    ctx.stroke();

    ctx.fillStyle = result === null ? 'rgba(255,255,255,0.35)' : '#ffffff';
    ctx.font = `bold ${result === null ? 80 : result >= 10 ? 78 : 88}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(result === null ? '?' : String(result), x + s / 2, y + s / 2 + 4);
    ctx.restore();
}

/** The bet, its odds and the chip that staked it, to the right of the tile. */
function drawBetBox(ctx, view) {
    const x = PX + 172;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(244,197,66,0.65)';
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillText('YOUR BET', x, 112);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 30px ${FONT}`;
    ctx.fillText(view.betLabel, x, 146, PW - 172);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText(`PAYS ${view.odds}`, x, 170);
    ctx.restore();

    drawChip(ctx, view.bet, x + 30, 212);
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `bold 16px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`WAGER ${shortAmount(view.bet)}`, x + 70, 214);
    ctx.restore();
}

function drawBanner(ctx, banner) {
    const { fill } = TONES[banner.tone] ?? TONES.info;
    const y = 266;
    const h = 54;
    ctx.save();
    ctx.shadowColor = fill;
    ctx.shadowBlur = 24;
    roundRect(ctx, PX, y, PW, h, 14);
    ctx.fillStyle = 'rgba(8,20,14,0.82)';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = fill;
    ctx.stroke();
    ctx.fillStyle = fill === TONES.info.fill ? '#ffffff' : fill;
    ctx.font = `bold 28px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(banner.text, PX + PW / 2, y + h / 2 + 2, PW - 30);
    ctx.restore();
}

/**
 * The betting layout in miniature: zero, then twelve columns of three. The
 * pockets the bet covers are lit in gold; the rest are dimmed; the winning
 * number carries the ball.
 */
function drawLayout(ctx, covered, result) {
    const top = 342;
    const cell = 30;
    const zeroW = 36;
    const x0 = PX + (PW - (zeroW + cell * 12)) / 2;
    const lit = new Set(covered);

    const drawCell = (n, x, y, w, h) => {
        const on = lit.has(n);
        ctx.save();
        ctx.globalAlpha = on ? 1 : 0.42;
        ctx.fillStyle = POCKET_FILL[colorOf(n)];
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${n >= 10 ? 12 : 13}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(n), x + w / 2, y + h / 2 + 1);
        ctx.restore();
        if (on) {
            ctx.save();
            ctx.strokeStyle = GOLD;
            ctx.lineWidth = 2;
            ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
            ctx.restore();
        }
    };

    drawCell(0, x0, top, zeroW, cell * 3);
    for (let col = 0; col < 12; col++) {
        for (let row = 0; row < 3; row++) {
            // Top row is the third column: 3, 6, … 36.
            const n = col * 3 + (3 - row);
            drawCell(n, x0 + zeroW + col * cell, top + row * cell, cell, cell);
        }
    }

    if (result !== null) {
        const [x, y, w, h] = result === 0
            ? [x0, top, zeroW, cell * 3]
            : [x0 + zeroW + Math.floor((result - 1) / 3) * cell, top + (2 - ((result - 1) % 3)) * cell, cell, cell];
        ctx.save();
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 16;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
        ctx.restore();
        const g = ctx.createRadialGradient(x + w - 8, y + 6, 1, x + w - 7, y + 7, 6);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(1, '#a0a0a8');
        ctx.beginPath();
        ctx.arc(x + w - 7, y + 7, 5, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
    }
}

/** The last spins at this server's table, newest first, and how they split. */
function drawHistory(ctx, history) {
    const recent = [...history].reverse().slice(0, 12);
    const y = 474;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(244,197,66,0.65)';
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillText('RECENT SPINS', PX, y - 22);

    if (history.length) {
        const count = c => history.filter(n => colorOf(n) === c).length;
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = `bold 12px ${FONT}`;
        ctx.fillText(
            `${count('red')} RED · ${count('black')} BLACK · ${count('green')} ZERO`,
            PX + PW, y - 22,
        );
    }

    recent.forEach((n, i) => {
        const cx = PX + 15 + i * 33;
        ctx.beginPath();
        ctx.arc(cx, y + 8, 14, 0, Math.PI * 2);
        ctx.fillStyle = POCKET_FILL[colorOf(n)];
        ctx.fill();
        ctx.lineWidth = i === 0 ? 2.5 : 1;
        ctx.strokeStyle = i === 0 ? GOLD : 'rgba(255,255,255,0.35)';
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${n >= 10 ? 12 : 13}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(n), cx, y + 9);
    });
    if (!recent.length) {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = `bold 14px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('First spin at this table', PX, y + 8);
    }
    ctx.restore();
}

/**
 * Draws the table and encodes it.
 *
 * @param {RouletteView} view
 * @returns {Promise<Buffer>} a JPEG
 */
async function renderRouletteTable(view) {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const { frame, result } = view;
    const settled = result !== null;

    drawFelt(ctx);
    drawBowl(ctx);
    drawRotor(ctx, frame.wheel, frame.speed);
    if (settled) drawWinGlow(ctx);
    drawBall(ctx, frame.ball, frame.onTrack ? BALL_ON_TRACK : BALL_IN_POCKET, frame.onTrack ? frame.speed : 0);
    drawMarker(ctx);

    drawHeading(ctx);
    drawResultTile(ctx, settled ? result : null);
    drawBetBox(ctx, view);
    drawBanner(ctx, view.banner ?? { text: 'NO MORE BETS', tone: 'info' });
    drawLayout(ctx, view.covered, settled ? result : null);
    drawHistory(ctx, view.history ?? []);

    // JPEG, not PNG: the felt's gradients and grain make a 500 KB PNG, and a
    // spin uploads one per frame. At this quality it is a fifth of that and
    // looks the same in a Discord embed.
    return encodeCanvas(canvas, 'image/jpeg');
}

module.exports = { renderRouletteTable, W, H };
