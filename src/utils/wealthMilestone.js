const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createWealthTierBanner } = require('./cardGenerator');

const WEALTH_MILESTONES = [
    { tier: 1, threshold: 1_000_000,     label: '💎 MILLIONAIRE',       color: '#5865f2' },
    { tier: 2, threshold: 10_000_000,    label: '💫 DECAMILLIONAIRE',   color: '#ffd700' },
    { tier: 3, threshold: 100_000_000,   label: '🌟 CENTIMILLIONAIRE',  color: '#ff6200' },
    { tier: 4, threshold: 1_000_000_000, label: '👑 BILLIONAIRE',       color: '#b9f2ff' },
];

// Returns the milestone tier number for the given total, or 0 if none.
function computeWealthTierNumber(total) {
    let tier = 0;
    for (const m of WEALTH_MILESTONES) {
        if (total >= m.threshold) tier = m.tier;
    }
    return tier;
}

/**
 * Check whether the user has crossed a new wealth milestone and broadcast if so.
 * Mutates user.wealthTier and calls user.save() when a new milestone is reached.
 * Never throws — a failure must never break the caller.
 *
 * @param {import('discord.js').Client} client
 * @param {object} guildSettings  - Mongoose Guild document
 * @param {object} user           - Mongoose User document (balance + bank must be current)
 * @param {import('discord.js').TextChannel|null} channel - channel to post in
 */
async function checkAndBroadcastWealthMilestone(client, guildSettings, user, channel) {
    try {
        const total = (user.balance ?? 0) + (user.bank ?? 0);
        const newTier = computeWealthTierNumber(total);
        if (newTier <= (user.wealthTier ?? 0)) return;

        const milestone = WEALTH_MILESTONES.find(m => m.tier === newTier);
        if (!milestone) return;

        user.wealthTier = newTier;
        try {
            await user.save();
        } catch (err) {
            console.error('[wealthMilestone] user.save failed:', err.message);
            return;
        }

        if (!channel) return;

        let attachment = null;
        try {
            const memberName = (await channel.guild.members.fetch(user.userId).catch(() => null))
                ?.user?.username ?? 'Someone';
            const bannerBuf = await createWealthTierBanner(memberName, milestone.label, milestone.color);
            attachment = new AttachmentBuilder(bannerBuf, { name: 'wealth_banner.png' });
        } catch {}

        const embed = new EmbedBuilder()
            .setColor(milestone.color)
            .setTitle(`${milestone.label}`)
            .setDescription(`<@${user.userId}> has crossed a legendary wealth milestone!`)
            .setTimestamp();

        if (attachment) embed.setImage('attachment://wealth_banner.png');

        await channel.send({
            embeds: [embed],
            ...(attachment ? { files: [attachment] } : {})
        }).catch(() => {});
    } catch (err) {
        console.error('[wealthMilestone] check failed:', err.message);
    }
}

module.exports = { checkAndBroadcastWealthMilestone, WEALTH_MILESTONES };
