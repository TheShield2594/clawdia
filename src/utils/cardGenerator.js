/**
 * Every image the bot draws for itself: the welcome card, the rank card, the
 * war and wealth banners, pet sprites, achievement toasts and the season recap.
 *
 * Each `create*` returns a PNG `Buffer`, ready to hand to discord.js as an
 * `AttachmentBuilder`. They never throw for a missing avatar or a broken image
 * URL — a fetch that fails or takes more than 5 seconds is drawn around, so a
 * slow CDN costs a placeholder rather than a member's welcome message.
 *
 * Drawing happens on the main thread, because the canvas API leaves no choice.
 * The PNG encode does not: it goes through `canvasEncode`, which hands it to
 * libuv's thread pool. The synchronous encode it replaced cost ~10 ms per card
 * of event-loop time (#592) — which is time the gateway cannot read a
 * heartbeat in, whatever drew the card. `createWelcomeCard` is the sharpest
 * case, because it runs off `guildMemberAdd` with no interaction waiting on
 * it, but a slash-command card like `/rank` blocks the same loop.
 *
 * @module utils/cardGenerator
 */

const { createCanvas, loadImage } = require('canvas');
const { ensureFontsRegistered } = require('./registerFonts');
// The encode must not be the synchronous one (#592). See canvasEncode.js and
// the note at the top of this file.
const { encodeCanvas } = require('./canvasEncode');

ensureFontsRegistered();

const EMOJI_FONT = '"DejaVu Sans", "Noto Color Emoji"';

/**
 * Shorten text with an ellipsis until it fits a pixel width, measured in the
 * font currently set on the context.
 *
 * @param {import('canvas').CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth in pixels
 * @returns {string} the text unchanged when it already fits
 */
function truncateText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    while (text.length > 0 && ctx.measureText(text + '…').width > maxWidth) {
        text = text.slice(0, -1);
    }
    return text + '…';
}

/**
 * `loadImage` with a deadline, so a slow or hanging avatar CDN cannot hold a
 * card open. Callers draw a placeholder on rejection.
 *
 * @param {string} url
 * @param {number} [ms] deadline in milliseconds
 * @returns {Promise<import('canvas').Image>} rejects on timeout or fetch failure
 */
function loadImageWithTimeout(url, ms = 5000) {
    let timer;
    const image = loadImage(url).then(
        img => { clearTimeout(timer); return img; },
        err => { clearTimeout(timer); return Promise.reject(err); }
    );
    return Promise.race([
        image,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Avatar load timed out')), ms);
        })
    ]);
}

/**
 * The frame/accent colour, corner glyph and label the rank card uses for a
 * level band: Bronze, Silver, Gold, Diamond, Mythic.
 *
 * @param {number} level
 * @returns {{color: string, glyph: string, label: string}}
 */
function getTierStyle(level) {
    if (level >= 100) return { color: '#ff6200', glyph: '✦', label: 'Mythic' };
    if (level >= 50)  return { color: '#b9f2ff', glyph: '◇', label: 'Diamond' };
    if (level >= 25)  return { color: '#ffd700', glyph: '◆', label: 'Gold' };
    if (level >= 10)  return { color: '#c0c0c0', glyph: '◈', label: 'Silver' };
    return                  { color: '#cd7f32', glyph: '⬡', label: 'Bronze' };
}

/**
 * The 800×300 card posted when a member joins: their avatar, name, and the
 * server's member count.
 *
 * Drawn off `guildMemberAdd`, so it is the card most sensitive to blocking —
 * see the note at the top of this file.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<Buffer>} PNG
 */
async function createWelcomeCard(member) {
    const canvas = createCanvas(800, 300);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#23272A';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#7289DA';
    ctx.fillRect(0, 0, canvas.width, 10);

    const textMaxWidth = canvas.width - 250 - 20;

    ctx.font = 'bold 40px "DejaVu Sans"';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('Welcome!', 250, 80);

    const displayName = member.user.globalName ?? member.user.username;

    ctx.font = '30px "DejaVu Sans"';
    ctx.fillStyle = '#AAAAAA';
    ctx.fillText(truncateText(ctx, displayName, textMaxWidth), 250, 130);

    ctx.font = '20px "DejaVu Sans"';
    ctx.fillStyle = '#AAAAAA';
    ctx.fillText(`Member #${member.guild.memberCount}`, 250, 170);

    try {
        const avatar = await loadImageWithTimeout(
            member.user.displayAvatarURL({ extension: 'png', size: 256 })
        );
        ctx.save();
        ctx.beginPath();
        ctx.arc(100, 150, 80, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatar, 20, 70, 160, 160);
        ctx.restore();
    } catch (error) {
        console.error('Error loading avatar:', error);
    }

    return encodeCanvas(canvas);
}

/**
 * The 900×300 `/rank` card: avatar, level, XP bar, position on the
 * leaderboard, and a tier-coloured accent for the level band.
 *
 * @param {import('discord.js').User} user whose avatar and name are drawn
 * @param {{level: number, xp: number}} userData their stored progress
 * @param {number} rank position on the guild leaderboard
 * @param {number} requiredXp XP needed for the next level, for the bar
 * @param {object} [opts]
 * @param {number} [opts.streakCurrent] daily streak, drawn when non-zero
 * @param {boolean} [opts.hasActiveBoost] draws the XP boost marker
 * @param {?object} [opts.rarestCatch] their best catch, drawn when present
 * @returns {Promise<Buffer>} PNG
 */
async function createRankCard(user, userData, rank, requiredXp, opts = {}) {
    const { streakCurrent = 0, hasActiveBoost = false, rarestCatch = null } = opts;

    const canvas = createCanvas(900, 300);
    const ctx = canvas.getContext('2d');
    const tier = getTierStyle(userData.level);

    // Background
    ctx.fillStyle = '#23272A';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Tier-colored top accent bar
    ctx.fillStyle = tier.color;
    ctx.fillRect(0, 0, canvas.width, 10);

    // Tier frame border (4px inset rectangle)
    ctx.strokeStyle = tier.color;
    ctx.lineWidth   = 4;
    ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);

    // Corner glyphs
    ctx.font      = 'bold 20px "DejaVu Sans"';
    ctx.fillStyle = tier.color;
    ctx.textBaseline = 'top';
    ctx.fillText(tier.glyph, 8,                    14);
    ctx.fillText(tier.glyph, canvas.width - 30,    14);
    ctx.textBaseline = 'bottom';
    ctx.fillText(tier.glyph, 8,                    canvas.height - 8);
    ctx.fillText(tier.glyph, canvas.width - 30,    canvas.height - 8);
    ctx.textBaseline = 'alphabetic';

    // Username
    ctx.font      = 'bold 35px "DejaVu Sans"';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(truncateText(ctx, user.username, canvas.width - 250 - 20), 250, 80);

    // Tier label
    ctx.font      = '16px "DejaVu Sans"';
    ctx.fillStyle = tier.color;
    ctx.fillText(tier.label, 250, 100);

    // Level & rank
    ctx.font      = '25px "DejaVu Sans"';
    ctx.fillStyle = '#AAAAAA';
    ctx.fillText(`Level ${userData.level}`, 250, 130);
    ctx.fillText(`Rank #${rank}`,           250, 160);

    // XP progress bar
    const barX = 250, barY = 180, barW = 600, barH = 30;
    const progress = Math.min((userData.xp / requiredXp) * barW, barW);
    ctx.fillStyle = '#2C2F33';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = tier.color;
    ctx.fillRect(barX, barY, progress, barH);

    ctx.font      = '18px "DejaVu Sans"';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(`${userData.xp} / ${requiredXp} XP`, barX, barY + 50);

    // Rarest catch footer line
    if (rarestCatch) {
        ctx.font      = '14px "DejaVu Sans"';
        ctx.fillStyle = '#9b59b6';
        ctx.fillText(`★ Rarest catch: ${rarestCatch}`, barX, barY + 68);
    }

    // Avatar
    const avatarX = 100, avatarY = 150, avatarR = 80;
    try {
        const avatar = await loadImageWithTimeout(
            user.displayAvatarURL({ extension: 'png', size: 256 })
        );

        // Boost halo: glowing ring around avatar when a booster is active
        if (hasActiveBoost) {
            const haloGrad = ctx.createRadialGradient(avatarX, avatarY, avatarR - 4, avatarX, avatarY, avatarR + 14);
            haloGrad.addColorStop(0,   'rgba(255, 200, 0, 0.85)');
            haloGrad.addColorStop(0.5, 'rgba(255, 140, 0, 0.50)');
            haloGrad.addColorStop(1,   'rgba(255, 100, 0, 0)');
            ctx.beginPath();
            ctx.arc(avatarX, avatarY, avatarR + 14, 0, Math.PI * 2);
            ctx.fillStyle = haloGrad;
            ctx.fill();
        }

        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX, avatarY, avatarR, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatar, avatarX - avatarR, avatarY - avatarR, avatarR * 2, avatarR * 2);
        ctx.restore();
    } catch (error) {
        console.error('Error loading avatar:', error);
    }

    // Streak flame badge in avatar corner (bottom-right) if streak >= 7
    if (streakCurrent >= 7) {
        const bx = avatarX + avatarR - 14;
        const by = avatarY + avatarR - 14;
        // Badge background circle
        ctx.beginPath();
        ctx.arc(bx, by, 16, 0, Math.PI * 2);
        ctx.fillStyle = '#1e1e1e';
        ctx.fill();
        ctx.strokeStyle = '#ff6200';
        ctx.lineWidth   = 2;
        ctx.stroke();
        // Flame emoji (Noto Color Emoji provides the glyph when available)
        ctx.font         = `18px ${EMOJI_FONT}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign    = 'center';
        ctx.fillStyle    = '#ff6200';
        ctx.fillText('🔥', bx, by);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign    = 'left';
    }

    return encodeCanvas(canvas);
}

const WAR_VICTORY_LINES = [
    'Victory belongs to the bold!',
    'The battlefield remembers the brave.',
    'Strength, unity, conquest.',
    'They fought — and they prevailed.',
    'No mercy. No retreat. All glory.',
];

/**
 * The 900×260 banner posted to both servers when a guild war resolves.
 *
 * @param {string} winnerName
 * @param {number} winnerScore
 * @param {string} loserName
 * @param {number} loserScore
 * @param {string} mvpName the winning side's top contributor
 * @returns {Promise<Buffer>} PNG
 */
async function createWarVictoryBanner(winnerName, winnerScore, loserName, loserScore, mvpName) {
    const canvas = createCanvas(900, 260);
    const ctx = canvas.getContext('2d');
    const gold = '#FFD700';

    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Gold accent bar
    ctx.fillStyle = gold;
    ctx.fillRect(0, 0, canvas.width, 8);
    ctx.fillRect(0, canvas.height - 8, canvas.width, 8);

    // Trophy icon area
    ctx.font = `bold 64px ${EMOJI_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText('🏆', 80, 90);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    // Winner title
    ctx.font = 'bold 36px "DejaVu Sans"';
    ctx.fillStyle = gold;
    const titleText = truncateText(ctx, `${winnerName} WINS THE WAR`, canvas.width - 160 - 20);
    ctx.fillText(titleText, 150, 70);

    // Score bar
    const total = (winnerScore + loserScore) || 1;
    const barX = 150, barY = 85, barW = 680, barH = 22;
    const winFrac = Math.min(winnerScore / total, 1);
    ctx.fillStyle = '#2e2e4a';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = gold;
    ctx.fillRect(barX, barY, Math.floor(winFrac * barW), barH);
    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(barX + Math.floor(winFrac * barW), barY, barW - Math.floor(winFrac * barW), barH);

    ctx.font = '16px "DejaVu Sans"';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${winnerScore.toLocaleString()} pts`, barX, barY + barH + 20);
    ctx.textAlign = 'right';
    ctx.fillText(`${loserScore.toLocaleString()} pts`, barX + barW, barY + barH + 20);
    ctx.textAlign = 'left';

    // Flavor line
    const flavor = WAR_VICTORY_LINES[Math.floor(Math.random() * WAR_VICTORY_LINES.length)];
    ctx.font = 'italic 17px "DejaVu Sans"';
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(`"${flavor}"`, 150, 150);

    // MVP line
    if (mvpName) {
        ctx.font = 'bold 20px "DejaVu Sans"';
        ctx.fillStyle = '#ffd700';
        ctx.fillText(`🏅 MVP: ${truncateText(ctx, mvpName, 400)}`, 150, 185);
    }

    // Spoils
    ctx.font = '16px "DejaVu Sans"';
    ctx.fillStyle = '#98FB98';
    ctx.fillText('Spoils: 2× coin booster (24h) + 🎖️ War Victor badge (30d)', 150, 215);

    return encodeCanvas(canvas);
}

/**
 * The 900×200 banner posted when a member crosses into a new wealth tier.
 *
 * @param {string} username
 * @param {string} tierLabel the tier's display name
 * @param {string} tierColor a CSS colour, used for the accent bars
 * @returns {Promise<Buffer>} PNG
 */
async function createWealthTierBanner(username, tierLabel, tierColor) {
    const canvas = createCanvas(900, 200);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#111122';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = tierColor;
    ctx.fillRect(0, 0, canvas.width, 8);
    ctx.fillRect(0, canvas.height - 8, canvas.width, 8);

    ctx.font = `bold 64px ${EMOJI_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText('💰', 80, 100);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    ctx.font = 'bold 42px "DejaVu Sans"';
    ctx.fillStyle = tierColor;
    ctx.fillText(tierLabel, 140, 80);

    ctx.font = '22px "DejaVu Sans"';
    ctx.fillStyle = '#dddddd';
    ctx.fillText(truncateText(ctx, username, 700), 140, 120);

    ctx.font = 'italic 16px "DejaVu Sans"';
    ctx.fillStyle = '#888888';
    ctx.fillText('has reached a legendary wealth milestone!', 140, 155);

    return encodeCanvas(canvas);
}

// ── Pet sprite generator ──────────────────────────────────────────────────────

const PET_SPRITE_COLORS = {
    dog:         { bg: '#c8a96e', ring: '#8b6914' },
    cat:         { bg: '#b0b0b0', ring: '#555555' },
    bird:        { bg: '#4fc3f7', ring: '#0277bd' },
    fish:        { bg: '#ff7043', ring: '#bf360c' },
    fox:         { bg: '#ef6c00', ring: '#bf360c' },
    wolf:        { bg: '#546e7a', ring: '#263238' },
    eagle:       { bg: '#795548', ring: '#4e342e' },
    shark:       { bg: '#607d8b', ring: '#37474f' },
    crystal_fox: { bg: '#7c4dff', ring: '#311b92' },
};

// Mirrors EVOLUTION_STAGE emoji in petService so a showcased Apex pet is
// visibly different from a stage 1 of the same species.
const EVOLVED_PET_EMOJIS = {
    dog:         { 2: '🐕', 3: '🐺' },
    cat:         { 2: '🐈', 3: '🐅' },
    bird:        { 2: '🦜', 3: '🦅' },
    fish:        { 2: '🐟', 3: '🦈' },
    fox:         { 2: '🦊', 3: '🌟' },
    wolf:        { 2: '🐺', 3: '🌑' },
    eagle:       { 2: '🦅', 3: '⚡' },
    shark:       { 2: '🦈', 3: '🌊' },
    crystal_fox: { 2: '💎', 3: '🔮' },
};

const PET_SPRITE_EMOJIS = {
    dog: '🐶', cat: '🐱', bird: '🐦', fish: '🐠',
    fox: '🦊', wolf: '🐺', eagle: '🦅', shark: '🦈', crystal_fox: '💎',
};

// An evolved pet should not look identical to a hatchling: stage 2 and 3 swap in
// the evolved emoji and gain ring pips so the tier reads at a glance.
/**
 * A pet's sprite, drawn from its palette rather than loaded from a file.
 *
 * @param {string} petId a key of the sprite palette; an unknown id draws grey
 *   rather than failing
 * @param {number} [size] square, in pixels
 * @param {number} [stage] growth stage, clamped to 1–3
 * @returns {Promise<Buffer>} PNG
 */
async function generatePetSprite(petId, size = 80, stage = 1) {
    const canvas = createCanvas(size, size);
    const ctx    = canvas.getContext('2d');
    const colors = PET_SPRITE_COLORS[petId] ?? { bg: '#9e9e9e', ring: '#616161' };
    const r      = size / 2;
    const tier   = Math.min(3, Math.max(1, Number(stage) || 1));

    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.fillStyle = colors.bg;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(r, r, r - 3, 0, Math.PI * 2);
    ctx.strokeStyle = colors.ring;
    ctx.lineWidth   = 4;
    ctx.stroke();

    // Ring pips: one per evolution stage beyond the first.
    if (tier > 1) {
        ctx.fillStyle = '#ffd700';
        for (let i = 0; i < tier - 1; i++) {
            const angle = -Math.PI / 2 + (i - (tier - 2) / 2) * 0.45;
            ctx.beginPath();
            ctx.arc(r + Math.cos(angle) * (r - 3), r + Math.sin(angle) * (r - 3), Math.max(2, size * 0.045), 0, Math.PI * 2);
            ctx.fill();
        }
    }

    const emoji    = EVOLVED_PET_EMOJIS[petId]?.[tier] ?? PET_SPRITE_EMOJIS[petId] ?? '🐾';
    const fontSize = Math.floor(size * 0.48);
    ctx.font         = `${fontSize}px ${EMOJI_FONT}`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, r, r + fontSize * 0.05);
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';

    return encodeCanvas(canvas);
}

// ── Minecraft-style achievement card ─────────────────────────────────────────

function _shadeHex(hex, percent) {
    const n = parseInt(hex.slice(1), 16);
    const clamp = v => Math.max(0, Math.min(255, v));
    const r = clamp(((n >> 16) & 0xff) + Math.round(255 * percent));
    const g = clamp(((n >> 8) & 0xff) + Math.round(255 * percent));
    const b = clamp((n & 0xff) + Math.round(255 * percent));
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function _drawAchievementIcon(ctx, x, y, size, tierColor) {
    const s = size / 18;
    const px = (cells, color) => {
        ctx.fillStyle = color;
        for (const [cx, cy] of cells) ctx.fillRect(x + cx * s, y + cy * s, s, s);
    };

    const gold      = tierColor || '#ffd700';
    const goldDark  = _shadeHex(gold, -0.45);
    const goldLight = _shadeHex(gold, 0.45);
    const stem      = _shadeHex(gold, -0.15);
    const base      = _shadeHex(gold, -0.5);

    // Trophy cup body
    px([
        [6,2],[7,2],[8,2],[9,2],[10,2],[11,2],
        [6,3],[11,3],
        [6,4],[11,4],
        [6,5],[11,5],
        [7,6],[10,6],
        [8,7],[9,7],
    ], gold);

    // Cup interior highlight
    px([[7,2],[8,2]], goldLight);

    // Handles
    px([[4,3],[4,4],[5,5],[12,3],[12,4],[13,5]], goldDark);

    // Stem
    px([[8,8],[9,8],[8,9],[9,9]], stem);

    // Base
    px([
        [6,10],[7,10],[8,10],[9,10],[10,10],[11,10],
        [5,11],[6,11],[7,11],[8,11],[9,11],[10,11],[11,11],[12,11],
    ], base);

    // Star sparkle accent
    px([[13,1],[14,2],[13,3],[12,2]], goldLight);
}

function _achTier(xpReward) {
    if (!xpReward || xpReward <= 50)  return { label: 'Bronze',   color: '#cd7f32' };
    if (xpReward <= 200)              return { label: 'Silver',   color: '#c0c0c0' };
    if (xpReward <= 500)              return { label: 'Gold',     color: '#ffd700' };
    return                                   { label: 'Platinum', color: '#e5e4e2' };
}

/**
 * The 520×110 achievement toast. The XP reward picks the tier, which picks the
 * icon and its colour.
 *
 * @param {string} text the achievement's name
 * @param {string} description
 * @param {number} xpReward
 * @returns {Promise<Buffer>} PNG
 */
async function createAchievementCard(text, description, xpReward) {
    const W = 520, H = 110, ICON_SIZE = 58, PAD = 16;
    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');
    const tier   = _achTier(xpReward);

    ctx.fillStyle = '#3c3c3c';
    ctx.fillRect(0, 0, W, H);

    // Tier colour strip at top
    ctx.fillStyle = tier.color;
    ctx.fillRect(0, 0, W, 5);

    // Bevel border
    ctx.fillStyle = '#5a5a5a';
    ctx.fillRect(0, 5, W, 3);
    ctx.fillRect(0, 5, 3, H - 5);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, H - 3, W, 3);
    ctx.fillRect(W - 3, 5, 3, H - 5);

    // Icon slot
    const iconX = PAD, iconY = (H - ICON_SIZE) / 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(iconX, iconY, ICON_SIZE, ICON_SIZE);
    ctx.strokeStyle = '#111111'; ctx.lineWidth = 2; ctx.strokeRect(iconX, iconY, ICON_SIZE, ICON_SIZE);
    ctx.strokeStyle = '#555555'; ctx.lineWidth = 1; ctx.strokeRect(iconX + 2, iconY + 2, ICON_SIZE - 4, ICON_SIZE - 4);
    _drawAchievementIcon(ctx, iconX + 2, iconY + 2, ICON_SIZE - 4, tier.color);

    // Text
    const textX      = iconX + ICON_SIZE + 14;
    const maxTextW   = W - textX - PAD;
    ctx.textBaseline = 'top';

    ctx.font      = 'bold 13px Arial, sans-serif';
    ctx.fillStyle = '#ffdf00';
    ctx.fillText('Achievement Unlocked!', textX, 14);

    ctx.font      = 'bold 11px Arial, sans-serif';
    ctx.fillStyle = tier.color;
    ctx.textAlign = 'right';
    ctx.fillText(`[${tier.label}]`, W - PAD, 14);
    ctx.textAlign = 'left';

    let fontSize = 21;
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    while (ctx.measureText(text).width > maxTextW && fontSize > 10) {
        fontSize--;
        ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, textX, 36);

    if (description) {
        ctx.font      = 'italic 12px Arial, sans-serif';
        ctx.fillStyle = '#aaaaaa';
        ctx.fillText(truncateText(ctx, description, maxTextW), textX, 62);
    }

    return encodeCanvas(canvas);
}

// ── End-of-season recap card ──────────────────────────────────────────────────

/**
 * The 700×420 card posted to a member when an economy season ends.
 *
 * @param {import('discord.js').User} user
 * @param {string} seasonName
 * @param {number} leaderboardRank where they finished
 * @param {number} totalPlayers out of how many
 * @returns {Promise<Buffer>} PNG
 */
async function createSeasonRecapCard(user, seasonName, leaderboardRank, totalPlayers) {
    const W = 700, H = 420;
    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');
    const gold   = '#FFD700';

    // Background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, W, H);

    // Gold accent bars
    ctx.fillStyle = gold;
    ctx.fillRect(0, 0, W, 8);
    ctx.fillRect(0, H - 8, W, 8);

    // Header
    ctx.font = 'bold 30px "DejaVu Sans"';
    ctx.fillStyle = gold;
    ctx.fillText('YOUR SEASON', 30, 52);

    ctx.font      = 'italic 17px "DejaVu Sans"';
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(truncateText(ctx, seasonName ?? 'Season Recap', W - 60), 30, 76);

    // Divider
    ctx.strokeStyle = '#333366'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(30, 90); ctx.lineTo(W - 30, 90); ctx.stroke();

    // Stats grid (2 columns × 3 rows)
    const biggestWin = Math.max(user.hunt?.bestPayout ?? 0, user.fishing?.bestPayout ?? 0, user.mining?.bestPayout ?? 0);
    const stats = [
        { label: 'Season Tier',    value: `Tier ${user.season?.tier ?? 0}`                    },
        { label: 'Season XP',      value: `${(user.season?.xp ?? 0).toLocaleString()} XP`     },
        { label: 'Best Win',       value: `${biggestWin.toLocaleString()} coins`               },
        { label: 'Leaderboard',    value: leaderboardRank ? `#${leaderboardRank} / ${totalPlayers}` : 'Unranked' },
        { label: 'Duel Record',    value: `${user.duelWins ?? 0}W / ${user.duelLosses ?? 0}L`  },
        { label: 'Quests Done',    value: `${user.questsCompleted ?? 0}`                       },
    ];

    const colW = (W - 60) / 2;
    const rowH = 65;
    const startY = 110;

    for (let i = 0; i < stats.length; i++) {
        const col = i % 2, row = Math.floor(i / 2);
        const x = 30 + col * colW, y = startY + row * rowH;

        ctx.fillStyle = '#16213e';
        ctx.fillRect(x, y, colW - 10, rowH - 8);

        ctx.font = '13px "DejaVu Sans"'; ctx.fillStyle = '#888888';
        ctx.fillText(stats[i].label, x + 10, y + 20);

        ctx.font = 'bold 20px "DejaVu Sans"'; ctx.fillStyle = '#ffffff';
        ctx.fillText(truncateText(ctx, stats[i].value, colW - 30), x + 10, y + 48);
    }

    // Tier progress ribbon bar
    const tier      = user.season?.tier ?? 0;
    const maxTiers  = 50;
    const barX = 30, barY = startY + 3 * rowH + 10, barW = W - 60, barH = 20;
    const topQuartile   = Math.max(1, Math.floor((totalPlayers ?? 1) * 0.25));
    const inTopQuartile = leaderboardRank && leaderboardRank <= topQuartile;

    ctx.fillStyle = '#222244';
    ctx.fillRect(barX, barY, barW, barH);
    const progress = Math.min((tier / maxTiers) * barW, barW);
    ctx.fillStyle  = inTopQuartile ? gold : '#5865F2';
    ctx.fillRect(barX, barY, progress, barH);

    ctx.font = '13px "DejaVu Sans"'; ctx.fillStyle = '#dddddd';
    ctx.fillText(`Tier ${tier} / ${maxTiers}${inTopQuartile ? ' — 🏆 Top 25%!' : ''}`, barX, barY + barH + 18);

    // Next-season teaser
    ctx.font = 'italic 14px "DejaVu Sans"'; ctx.fillStyle = '#555588';
    ctx.fillText('New season coming soon — your next adventure awaits!', 30, H - 18);

    return encodeCanvas(canvas);
}

module.exports = { createWelcomeCard, createRankCard, createWarVictoryBanner, createWealthTierBanner, generatePetSprite, createAchievementCard, createSeasonRecapCard };
