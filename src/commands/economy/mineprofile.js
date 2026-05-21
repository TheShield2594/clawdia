'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { DEPTHS, MINER_LEVELS, PRESTIGE_BONUSES, LIMITS } = require('../../data/mineData');
const {
    ensureMineData,
    applyStaminaRegen,
    getMaxStamina,
    msUntilNextStamina,
    getLevelData,
    xpToNextLevel,
    formatMs
} = require('../../services/mineService');

const PRESTIGE_BADGES = ['', '🥉', '🥈', '🥇', '🏆', '💎'];

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('mineprofile')
        .setDescription("View your or another player's miner profile")
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
                    ? "You haven't started mining yet! Buy a pickaxe with `/mineshop pickaxe` and use `/mine` to begin."
                    : `${target.username} hasn't started mining yet.`,
                ephemeral: true
            });
        }

        ensureMineData(userData);
        if (isSelf) applyStaminaRegen(userData);

        const m         = userData.mining;
        const levelData = getLevelData(m.level);
        const toNext    = xpToNextLevel(m.level, m.xp);
        const maxStam   = getMaxStamina(userData);
        const regenMs   = msUntilNextStamina(userData);
        const depth     = DEPTHS[m.activeDepth];
        const prestige  = m.prestige ?? 0;
        const badge     = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';

        const successRate = m.totalMines > 0
            ? `${Math.round((m.successfulMines / m.totalMines) * 100)}%`
            : 'N/A';

        const xpProgressBar = buildXpBar(m, toNext);
        const stamBar = '⚡'.repeat(m.stamina) + '▪️'.repeat(Math.max(0, maxStam - m.stamina));

        const buffs = [];
        if (m.activeMagnet)   buffs.push(`Magnet (${m.activeMagnetMinesLeft} mines)`);
        if (m.activeLamp)     buffs.push(`Lamp (${m.activeLampMinesLeft} mines)`);
        if (m.activeInstinct) buffs.push('Instinct (queued)');
        if (m.activeXpScroll) buffs.push('XP Scroll (queued)');

        const pBonus = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)];

        const embed = new EmbedBuilder()
            .setColor(prestige >= 4 ? '#f39c12' : prestige >= 2 ? '#95a5a6' : '#b5651d')
            .setTitle(`${badge} ${target.username}'s Miner Profile`)
            .setThumbnail(target.displayAvatarURL({ dynamic: true }))
            .addFields(
                {
                    name: '⛏️ Rank',
                    value: `**${levelData.title}** (Level ${m.level})${prestige > 0 ? `\nPrestige ${badge} P${prestige}` : ''}`,
                    inline: true
                },
                {
                    name: '⭐ Miner XP',
                    value: toNext !== null
                        ? `${m.xp.toLocaleString()} / ${MINER_LEVELS[m.level]?.xpRequired?.toLocaleString() ?? '?'} XP\n${xpProgressBar}\n${toNext.toLocaleString()} to Level ${m.level + 1}`
                        : `${m.xp.toLocaleString()} XP — **MAX LEVEL**`,
                    inline: true
                },
                {
                    name: '🗺️ Active Depth',
                    value: depth ? `${depth.emoji} ${depth.name}` : 'Unknown',
                    inline: true
                },
                {
                    name: '⚡ Stamina',
                    value: `${stamBar}\n${m.stamina}/${maxStam}${m.stamina < maxStam ? `\nNext regen: ${formatMs(regenMs)}` : '\nFull!'}`,
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
                    name: '📊 Mining Stats',
                    value: [
                        `Total Mines:     **${m.totalMines.toLocaleString()}**`,
                        `Success Rate:    **${successRate}**`,
                        `Total Earned:    **${currency}${m.totalEarned.toLocaleString()}**`,
                        `Best Payout:     **${currency}${m.bestPayout.toLocaleString()}**`,
                        `Legendary Finds: **${m.legendaryFinds}**`,
                        `Event Finds:     **${m.eventFinds}**`
                    ].join('\n'),
                    inline: false
                }
            );

        if (prestige > 0) {
            embed.addFields({
                name: `${badge} Prestige Bonuses`,
                value: [
                    pBonus.critBonus    > 0 ? `+${Math.round(pBonus.critBonus    * 100)}% crit chance`  : null,
                    pBonus.staminaBonus > 0 ? `+${pBonus.staminaBonus} max stamina`                     : null,
                    pBonus.payoutBonus  > 0 ? `+${Math.round(pBonus.payoutBonus  * 100)}% all payouts`   : null,
                    pBonus.rarityBonus  > 0 ? `+${Math.round(pBonus.rarityBonus  * 100)}% rarity boost`  : null
                ].filter(Boolean).join('\n') || 'None yet',
                inline: true
            });
        }

        const depthList = m.unlockedDepths.map(id => {
            const d = DEPTHS[id];
            return d ? `${d.emoji} ${d.name}` : id;
        }).join('\n');
        embed.addFields({ name: '🗺️ Unlocked Depths', value: depthList || 'Surface Quarry only', inline: true });

        if (prestige === 0 && m.level >= 50) {
            embed.setFooter({ text: 'Max level reached!' });
        } else if (isSelf) {
            embed.setFooter({ text: `Daily: ${m.dailyMines} mines · ${currency}${m.dailyCoins.toLocaleString()} earned (cap: ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()})` });
        }

        embed.setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }
};

function buildXpBar(m, toNext) {
    if (toNext === null) return '████████████████████ MAX';
    const currentLevelXp = MINER_LEVELS[m.level - 1]?.xpRequired ?? 0;
    const nextLevelXp    = MINER_LEVELS[m.level]?.xpRequired ?? 1;
    const denominator    = nextLevelXp - currentLevelXp;
    const progress       = denominator > 0 ? (m.xp - currentLevelXp) / denominator : 0;
    const filled         = Math.min(20, Math.max(0, Math.round(progress * 20)));
    const pct            = Math.min(100, Math.max(0, Math.round(progress * 100)));
    return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}%`;
}
