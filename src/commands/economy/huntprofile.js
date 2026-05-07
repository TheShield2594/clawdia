'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { ZONES, HUNTER_LEVELS, PRESTIGE_BONUSES, LIMITS } = require('../../data/huntData');
const {
    ensureHuntData,
    applyStaminaRegen,
    getMaxStamina,
    msUntilNextStamina,
    getLevelData,
    xpToNextLevel,
    formatMs
} = require('../../services/huntService');

const PRESTIGE_BADGES = ['', '🥉', '🥈', '🥇', '🏆', '💎'];

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('huntprofile')
        .setDescription("View your or another player's hunter profile")
        .addUserOption(o =>
            o.setName('user')
                .setDescription('Player to inspect')
                .setRequired(false)),

    async execute(interaction) {
        const target = interaction.options.getUser('user') ?? interaction.user;
        const isSelf = target.id === interaction.user.id;

        const [userData, guildSettings] = await Promise.all([
            User.findOne({ userId: target.id, guildId: interaction.guild.id }),
            Guild.findOne({ guildId: interaction.guild.id })
        ]);

        const currency = guildSettings?.economy?.currency ?? '💰';

        if (!userData) {
            return interaction.reply({
                content: isSelf
                    ? "You haven't started hunting yet! Buy a weapon with `/huntbuygun` and use `/hunt` to begin."
                    : `${target.username} hasn't started hunting yet.`,
                ephemeral: true
            });
        }

        ensureHuntData(userData);
        if (isSelf) applyStaminaRegen(userData);

        const h        = userData.hunt;
        const levelData = getLevelData(h.level);
        const toNext   = xpToNextLevel(h.level, h.xp);
        const maxStam  = getMaxStamina(userData);
        const regenMs  = msUntilNextStamina(userData);
        const zone     = ZONES[h.activeZone];
        const prestige = h.prestige ?? 0;
        const badge    = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';

        const successRate = h.totalHunts > 0
            ? `${Math.round((h.successfulHunts / h.totalHunts) * 100)}%`
            : 'N/A';

        // XP progress bar
        const xpProgressBar = buildXpBar(h, toNext);

        // Stamina bar
        const stamBar = '⚡'.repeat(h.stamina) + '▪️'.repeat(Math.max(0, maxStam - h.stamina));

        // Active buffs
        const buffs = [];
        if (h.activeBait)    buffs.push(`Bait (${h.activeBaitHuntsLeft} hunts)`);
        if (h.activeCharm)   buffs.push(`Charm (${h.activeCharmHuntsLeft} hunts)`);
        if (h.activeFocus)   buffs.push('Focus (queued)');
        if (h.activeXpScroll) buffs.push('XP Scroll (queued)');

        // Prestige bonuses summary
        const pBonus = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)];

        const embed = new EmbedBuilder()
            .setColor(prestige >= 4 ? '#f39c12' : prestige >= 2 ? '#95a5a6' : '#3498db')
            .setTitle(`${badge} ${target.username}'s Hunter Profile`)
            .setThumbnail(target.displayAvatarURL({ dynamic: true }))
            .addFields(
                {
                    name: '🏆 Rank',
                    value: `**${levelData.title}** (Level ${h.level})${prestige > 0 ? `\nPrestige ${badge} P${prestige}` : ''}`,
                    inline: true
                },
                {
                    name: '⭐ Hunter XP',
                    value: toNext !== null
                        ? `${h.xp.toLocaleString()} / ${HUNTER_LEVELS[h.level]?.xpRequired?.toLocaleString() ?? '?'} XP\n${xpProgressBar}\n${toNext.toLocaleString()} to Level ${h.level + 1}`
                        : `${h.xp.toLocaleString()} XP — **MAX LEVEL**`,
                    inline: true
                },
                {
                    name: '🗺️ Active Zone',
                    value: zone ? `${zone.emoji} ${zone.name}` : 'Unknown',
                    inline: true
                },
                {
                    name: '⚡ Stamina',
                    value: `${stamBar}\n${h.stamina}/${maxStam}${h.stamina < maxStam ? `\nNext regen: ${formatMs(regenMs)}` : '\nFull!'}`,
                    inline: true
                },
                {
                    name: '💰 Balance',
                    value: `${currency}${userData.balance.toLocaleString()}`,
                    inline: true
                },
                {
                    name: '🔋 Active Buffs',
                    value: buffs.length ? buffs.join('\n') : 'None',
                    inline: true
                },
                {
                    name: '📊 Hunt Stats',
                    value: [
                        `Total Hunts:    **${h.totalHunts.toLocaleString()}**`,
                        `Success Rate:   **${successRate}**`,
                        `Total Earned:   **${currency}${h.totalEarned.toLocaleString()}**`,
                        `Best Payout:    **${currency}${h.bestPayout.toLocaleString()}**`,
                        `Legendary Kills: **${h.legendaryKills}**`,
                        `Event Kills:    **${h.eventKills}**`
                    ].join('\n'),
                    inline: false
                }
            );

        if (prestige > 0) {
            embed.addFields({
                name: `${badge} Prestige Bonuses`,
                value: [
                    pBonus.critBonus     > 0 ? `+${Math.round(pBonus.critBonus     * 100)}% crit chance`     : null,
                    pBonus.staminaBonus  > 0 ? `+${pBonus.staminaBonus} max stamina`                         : null,
                    pBonus.payoutBonus   > 0 ? `+${Math.round(pBonus.payoutBonus   * 100)}% all payouts`      : null,
                    pBonus.rarityBonus   > 0 ? `+${Math.round(pBonus.rarityBonus   * 100)}% rarity boost`     : null
                ].filter(Boolean).join('\n') || 'None yet',
                inline: true
            });
        }

        // Unlocked zones
        const zoneList = h.unlockedZones.map(id => {
            const z = ZONES[id];
            return z ? `${z.emoji} ${z.name}` : id;
        }).join('\n');
        embed.addFields({ name: '🗺️ Unlocked Zones', value: zoneList || 'Beginner Forest only', inline: true });

        // Trophies
        if (h.trophies?.length) {
            embed.addFields({ name: '🏆 Trophies', value: h.trophies.join(', '), inline: true });
        }

        if (prestige === 0 && h.level >= 50) {
            embed.setFooter({ text: 'Max level reached! Use /huntprestige to reset and unlock new bonuses.' });
        } else if (isSelf) {
            embed.setFooter({ text: `Daily: ${h.dailyHunts} hunts · ${currency}${h.dailyCoins.toLocaleString()} earned (cap: ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()})` });
        }

        embed.setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }
};

function buildXpBar(h, toNext) {
    if (toNext === null) return '████████████████████ MAX';
    const currentLevelXp = HUNTER_LEVELS[h.level - 1]?.xpRequired ?? 0;
    const nextLevelXp    = HUNTER_LEVELS[h.level]?.xpRequired ?? 1;
    const denominator    = nextLevelXp - currentLevelXp;
    const progress       = denominator > 0 ? (h.xp - currentLevelXp) / denominator : 0;
    const filled         = Math.min(20, Math.max(0, Math.round(progress * 20)));
    const pct            = Math.min(100, Math.max(0, Math.round(progress * 100)));
    return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}%`;
}
