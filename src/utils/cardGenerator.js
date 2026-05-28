const { createCanvas, loadImage, registerFont } = require('canvas');

// Register a bundled sans-serif font so rendering is consistent across environments
// instead of relying on whatever Arial happens to be installed (fix #9).
try {
    registerFont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', { family: 'DejaVu Sans' });
    registerFont('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', { family: 'DejaVu Sans', weight: 'bold' });
} catch {
    // DejaVu not present; canvas falls back to its built-in default
}

// Truncate text with an ellipsis so it never overflows maxWidth pixels (fix #1).
function truncateText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    while (text.length > 0 && ctx.measureText(text + '…').width > maxWidth) {
        text = text.slice(0, -1);
    }
    return text + '…';
}

// Wraps loadImage with a hard timeout so a slow/unreachable CDN can't stall the
// whole event handler indefinitely (fix #6). The timer is always cleared so no
// handle leaks after the race settles either way.
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

async function createWelcomeCard(member) {
    const canvas = createCanvas(800, 300);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#23272A';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#7289DA';
    ctx.fillRect(0, 0, canvas.width, 10);

    // Available width for text starts after the avatar area (x=250) with 20px right margin
    const textMaxWidth = canvas.width - 250 - 20;

    ctx.font = 'bold 40px "DejaVu Sans"';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('Welcome!', 250, 80);

    // Use globalName (display name) instead of the deprecated .tag (fix #5)
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

        // save/restore so the circle clip doesn't affect anything drawn after this
        // block (fix #3)
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

async function createRankCard(user, userData, rank, requiredXp) {
    const canvas = createCanvas(900, 300);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#23272A';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#7289DA';
    ctx.fillRect(0, 0, canvas.width, 10);

    ctx.font = 'bold 35px "DejaVu Sans"';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(user.username, 250, 80);

    ctx.font = '25px "DejaVu Sans"';
    ctx.fillStyle = '#AAAAAA';
    ctx.fillText(`Level ${userData.level}`, 250, 120);
    ctx.fillText(`Rank #${rank}`, 250, 160);

    const progressBarWidth = 600;
    const progressBarHeight = 30;
    const progressBarX = 250;
    const progressBarY = 180;
    const progress = Math.min((userData.xp / requiredXp) * progressBarWidth, progressBarWidth);

    ctx.fillStyle = '#2C2F33';
    ctx.fillRect(progressBarX, progressBarY, progressBarWidth, progressBarHeight);

    ctx.fillStyle = '#7289DA';
    ctx.fillRect(progressBarX, progressBarY, progress, progressBarHeight);

    ctx.font = '18px "DejaVu Sans"';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(`${userData.xp} / ${requiredXp} XP`, progressBarX, progressBarY + 50);

    try {
        const avatar = await loadImageWithTimeout(
            user.displayAvatarURL({ extension: 'png', size: 256 })
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

module.exports = { createWelcomeCard, createRankCard };
