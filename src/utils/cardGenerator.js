const { createCanvas, loadImage } = require('canvas');

async function createWelcomeCard(member) {
    const canvas = createCanvas(800, 300);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#23272A';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#7289DA';
    ctx.fillRect(0, 0, canvas.width, 10);

    ctx.font = 'bold 40px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('Welcome!', 250, 80);

    ctx.font = '30px Arial';
    ctx.fillStyle = '#AAAAAA';
    ctx.fillText(member.user.tag, 250, 130);

    ctx.font = '20px Arial';
    ctx.fillText(`Member #${member.guild.memberCount}`, 250, 170);

    try {
        const avatar = await loadImage(member.user.displayAvatarURL({ extension: 'png', size: 256 }));
        
        ctx.beginPath();
        ctx.arc(100, 150, 80, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.clip();
        
        ctx.drawImage(avatar, 20, 70, 160, 160);
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

    ctx.font = 'bold 35px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(user.username, 250, 80);

    ctx.font = '25px Arial';
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

    ctx.font = '18px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(`${userData.xp} / ${requiredXp} XP`, progressBarX, progressBarY + 50);

    try {
        const avatar = await loadImage(user.displayAvatarURL({ extension: 'png', size: 256 }));
        
        ctx.beginPath();
        ctx.arc(100, 150, 80, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.clip();
        
        ctx.drawImage(avatar, 20, 70, 160, 160);
    } catch (error) {
        console.error('Error loading avatar:', error);
    }

    return canvas.toBuffer();
}

module.exports = { createWelcomeCard, createRankCard };