const { EmbedBuilder } = require('discord.js');
const { DROP_MILESTONES } = require('../data/dailyDropTable');

const MILESTONE_LABELS = {
    7:   '🎁 Streak Drop',
    30:  '💎 Milestone Crate',
    100: '🏆 Century Reward',
};

function getNextStreakMilestone(streak) {
    const next = DROP_MILESTONES.find(m => streak < m);
    if (!next) return null;
    const left = next - streak;
    return `${streak}/${next} → ${MILESTONE_LABELS[next] ?? '🎁 Milestone'}  *(${left} day${left !== 1 ? 's' : ''} away)*`;
}

/**
 * Build a forward-looking cooldown embed that teases the next opportunity
 * instead of just rejecting the player.
 *
 * @param {object} opts
 * @param {string}   opts.title
 * @param {string}   opts.description          - First paragraph (what's happening)
 * @param {string}   opts.color                - Activity-tinted hex, never grey
 * @param {Date}    [opts.nextAt]              - When the cooldown expires (renders as <t:unix:R>)
 * @param {string}  [opts.pityStat]            - e.g. "🎯 23 hunts since last Epic+ • guaranteed at ~50"
 * @param {string}  [opts.nextRewardPreview]   - e.g. "Next reward: coins + possible Coin Booster"
 * @param {string}  [opts.milestoneTeaser]     - e.g. "5/7 → 🎁 Streak Drop (2 days away)"
 * @param {string}  [opts.footerText]          - Optional footer override
 * @returns {EmbedBuilder}
 */
function buildCooldownEmbed({
    title,
    description,
    color,
    nextAt,
    pityStat,
    nextRewardPreview,
    milestoneTeaser,
    footerText,
}) {
    const lines = [description];

    if (nextAt) {
        lines.push(`\n⏱️ Ready <t:${Math.floor(nextAt.getTime() / 1000)}:R>`);
    }

    if (milestoneTeaser) {
        lines.push(`\n📊 ${milestoneTeaser}`);
    }

    if (nextRewardPreview) {
        lines.push(`\n> ${nextRewardPreview}`);
    }

    if (pityStat) {
        lines.push(`\n${pityStat}`);
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(lines.join('\n'))
        .setTimestamp();

    if (footerText) embed.setFooter({ text: footerText });

    return embed;
}

module.exports = { buildCooldownEmbed, getNextStreakMilestone };
