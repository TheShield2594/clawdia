'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { LOCATIONS, FISHER_LEVELS, PRESTIGE_BONUSES, LIMITS } = require('../../data/fishData');
const {
    ensureFishingData,
    applyStaminaRegen,
    getMaxStamina,
    msUntilNextStamina,
    getLevelData,
    xpToNextLevel,
    formatMs
} = require('../../services/fishService');

const PRESTIGE_BADGES = ['', '🥉', '🥈', '🥇', '🏆', '💎'];

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('fishprofile')
        .setDescription("View your or another player's fishing profile")
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
                    ? "You haven't started fishing yet! Buy a rod with `/fishbuyrod` and use `/fish` to begin."
                    : `${target.username} hasn't started fishing yet.`,
                ephemeral: true
            });
        }

        ensureFishingData(userData);
        if (isSelf) applyStaminaRegen(userData);

        const f         = userData.fishing;
        const levelData = getLevelData(f.level);
        const toNext    = xpToNextLevel(f.level, f.xp);
        const maxStam   = getMaxStamina(userData);
        const regenMs   = msUntilNextStamina(userData);
        const location  = LOCATIONS[f.activeLocation];
        const prestige  = f.prestige ?? 0;
        const badge     = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';

        const successRate = f.totalCasts > 0
            ? `${Math.round((f.successfulCasts / f.totalCasts) * 100)}%`
            : 'N/A';

        const xpBar   = buildXpBar(f, toNext);
        const stamBar = '⚡'.repeat(f.stamina) + '▪️'.repeat(Math.max(0, maxStam - f.stamina));

        const buffs = [];
        if (f.activeBait)    buffs.push(`Bait (${f.activeBaitCastsLeft} casts)`);
        if (f.activeLuck)    buffs.push('Luck (queued)');
        if (f.activeXpScroll) buffs.push('XP Scroll (queued)');

        const pBonus = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)];

        const embed = new EmbedBuilder()
            .setColor(prestige >= 4 ? '#f39c12' : prestige >= 2 ? '#95a5a6' : '#3498db')
            .setTitle(`${badge} ${target.username}'s Fishing Profile`)
            .setThumbnail(target.displayAvatarURL({ dynamic: true }))
            .addFields(
                {
                    name: '🏆 Rank',
                    value: `**${levelData.title}** (Level ${f.level})${prestige > 0 ? `\nPrestige ${badge} P${prestige}` : ''}`,
                    inline: true
                },
                {
                    name: '⭐ Fisher XP',
                    value: toNext !== null
                        ? `${f.xp.toLocaleString()} / ${FISHER_LEVELS[f.level]?.xpRequired?.toLocaleString() ?? '?'} XP\n${xpBar}\n${toNext.toLocaleString()} to Level ${f.level + 1}`
                        : `${f.xp.toLocaleString()} XP — **MAX LEVEL**`,
                    inline: true
                },
                {
                    name: '📍 Active Location',
                    value: location ? `${location.emoji} ${location.name}` : 'Unknown',
                    inline: true
                },
                {
                    name: '⚡ Stamina',
                    value: `${stamBar}\n${f.stamina}/${maxStam}${f.stamina < maxStam ? `\nNext regen: ${formatMs(regenMs)}` : '\nFull!'}`,
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
                    name: '📊 Fishing Stats',
                    value: [
                        `Total Casts:       **${f.totalCasts.toLocaleString()}**`,
                        `Success Rate:      **${successRate}**`,
                        `Total Earned:      **${currency}${f.totalEarned.toLocaleString()}**`,
                        `Best Payout:       **${currency}${f.bestPayout.toLocaleString()}**`,
                        `Legendary Catches: **${f.legendaryCatches}**`,
                        `Event Catches:     **${f.eventCatches}**`
                    ].join('\n'),
                    inline: false
                }
            );

        if (prestige > 0) {
            embed.addFields({
                name: `${badge} Prestige Bonuses`,
                value: [
                    pBonus.critBonus    > 0 ? `+${Math.round(pBonus.critBonus    * 100)}% crit chance`  : null,
                    pBonus.staminaBonus > 0 ? `+${pBonus.staminaBonus} max stamina`                      : null,
                    pBonus.payoutBonus  > 0 ? `+${Math.round(pBonus.payoutBonus  * 100)}% all payouts`   : null,
                    pBonus.rarityBonus  > 0 ? `+${Math.round(pBonus.rarityBonus  * 100)}% rarity boost`  : null
                ].filter(Boolean).join('\n') || 'None yet',
                inline: true
            });
        }

        const locationList = f.unlockedLocations.map(id => {
            const loc = LOCATIONS[id];
            return loc ? `${loc.emoji} ${loc.name}` : id;
        }).join('\n');
        embed.addFields({ name: '🗺️ Unlocked Locations', value: locationList || 'Quiet Pond only', inline: true });

        if (f.trophies?.length) {
            embed.addFields({ name: '🏆 Trophies', value: f.trophies.join(', '), inline: true });
        }

        if (prestige === 0 && f.level >= 50) {
            embed.setFooter({ text: 'Max level reached! Use /fishprestige to reset and unlock new bonuses.' });
        } else if (isSelf) {
            embed.setFooter({ text: `Daily: ${f.dailyCasts} casts · ${currency}${f.dailyCoins.toLocaleString()} earned (cap: ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()})` });
        }

        embed.setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }
};

function buildXpBar(f, toNext) {
    if (toNext === null) return '████████████████████ MAX';
    // Use absolute progress (f.xp / next-level threshold) to match the "X / Y XP" display text
    const nextLevelXp = FISHER_LEVELS[f.level]?.xpRequired ?? 1;
    const progress    = nextLevelXp > 0 ? Math.min(1, f.xp / nextLevelXp) : 0;
    const filled      = Math.min(20, Math.max(0, Math.round(progress * 20)));
    const pct         = Math.min(100, Math.max(0, Math.round(progress * 100)));
    return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}%`;
}
