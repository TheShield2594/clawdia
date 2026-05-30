const { createCanvas, loadImage, registerFont } = require('canvas');

try {
    registerFont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', { family: 'DejaVu Sans' });
    registerFont('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', { family: 'DejaVu Sans', weight: 'bold' });
} catch {
    // DejaVu not present; canvas falls back to its built-in default
}
try {
    registerFont('/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', { family: 'Noto Color Emoji' });
} catch {
    // Emoji font unavailable; emoji characters will fall back to replacement glyphs
}

const EMOJI_FONT = '"DejaVu Sans", "Noto Color Emoji"';

function truncateText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    while (text.length > 0 && ctx.measureText(text + '…').width > maxWidth) {
        text = text.slice(0, -1);
    }
    return text + '…';
}

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

// Returns frame/accent color and a corner glyph for each level band
function getTierStyle(level) {
    if (level >= 100) return { color: '#ff6200', glyph: '✦', label: 'Mythic' };
    if (level >= 50)  return { color: '#b9f2ff', glyph: '◇', label: 'Diamond' };
    if (level >= 25)  return { color: '#ffd700', glyph: '◆', label: 'Gold' };
    if (level >= 10)  return { color: '#c0c0c0', glyph: '◈', label: 'Silver' };
    return                  { color: '#cd7f32', glyph: '⬡', label: 'Bronze' };
}

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

    return canvas.toBuffer();
}

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

    return canvas.toBuffer();
}

const WAR_VICTORY_LINES = [
    'Victory belongs to the bold!',
    'The battlefield remembers the brave.',
    'Strength, unity, conquest.',
    'They fought — and they prevailed.',
    'No mercy. No retreat. All glory.',
];

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

    return canvas.toBuffer();
}

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

    ctx.font = 'bold 42px "DejaVu Sans"';
    ctx.fillStyle = tierColor;
    ctx.textAlign = 'left';
    ctx.fillText(tierLabel, 140, 80);

    ctx.font = '22px "DejaVu Sans"';
    ctx.fillStyle = '#dddddd';
    ctx.fillText(truncateText(ctx, username, 700), 140, 120);

    ctx.font = 'italic 16px "DejaVu Sans"';
    ctx.fillStyle = '#888888';
    ctx.fillText('has reached a legendary wealth milestone!', 140, 155);

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    return canvas.toBuffer();
}

module.exports = { createWelcomeCard, createRankCard, createWarVictoryBanner, createWealthTierBanner };
