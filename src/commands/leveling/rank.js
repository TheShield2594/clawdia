const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { createRankCard } = require('../../utils/cardGenerator');
const { pruneEffects, EFFECT_CONFIGS, timeRemaining, getServerCoinMultiplier, getServerXpMultiplier } = require('../../services/effectsService');
const { badgeFor, titleForExactRank: prestigeTitle } = require('../../utils/prestige');
const { tierFor: eloTierFor, START_ELO } = require('../../utils/duelElo');

const BOOSTER_TYPES  = new Set(['coin_booster_2x', 'xp_booster_2x', 'lucky_streak', 'salary_raise']);
const BOOST_TYPES    = new Set(['coin_booster_2x', 'xp_booster_2x']);

// Best rarity rank for Epic+ materials pulled from hunt/fish/mine (simplified)
const MATERIAL_RARITY_RANK = { epic: 3, legendary: 4, mythic: 5 };
function getRarestCatch(userData) {
    const candidates = [];
    const checkMaterials = mats => {
        if (!Array.isArray(mats)) return;
        for (const m of mats) {
            if (!m.itemId && !m.id) continue;
            const rank = MATERIAL_RARITY_RANK[m.rarity?.toLowerCase()];
            if (rank) candidates.push({ rank, name: m.name || m.itemId || m.id });
        }
    };
    checkMaterials(userData.hunting?.materials);
    checkMaterials(userData.fishing?.materials);
    checkMaterials(userData.mining?.materials);
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.rank - a.rank);
    return candidates[0].name;
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('rank')
        .setDescription('View your rank card showing level, XP, and server position.')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User whose rank to display (defaults to yourself).')
                .setRequired(false)),
    async execute(interaction) {
        const targetUser = interaction.options.getUser('user') || interaction.user;

        try {
            const [user, guildSettings, allUsers] = await Promise.all([
                User.findOne({ userId: targetUser.id, guildId: interaction.guild.id }),
                Guild.findOne({ guildId: interaction.guild.id }),
                User.find({ guildId: interaction.guild.id }).sort({ level: -1, xp: -1 })
            ]);

            if (!user) {
                return interaction.reply({ content: `${targetUser.username} hasn't earned any XP yet!`, ephemeral: true });
            }

            pruneEffects(user);

            const rank       = allUsers.findIndex(u => u.userId === targetUser.id) + 1;
            const requiredXp = user.level * 100 + 100;

            const activeBoosters  = (user.activeEffects || []).filter(e => BOOSTER_TYPES.has(e.type));
            const hasActiveBoost  = activeBoosters.some(e => BOOST_TYPES.has(e.type));
            const streakCurrent   = user.streak?.current ?? 0;
            const rarestCatch     = getRarestCatch(user);

            const card       = await createRankCard(targetUser, user, rank, requiredXp, { streakCurrent, hasActiveBoost, rarestCatch });
            const attachment = new AttachmentBuilder(card, { name: 'rank.png' });

            const serverCoinMult = getServerCoinMultiplier(guildSettings);
            const serverXpMult   = getServerXpMultiplier(guildSettings);
            const sb = guildSettings?.serverBoost;
            const hasServerBoost = (serverCoinMult > 1.0 || serverXpMult > 1.0) && sb?.expiresAt;

            const hasExclusions = (guildSettings?.leveling?.noXpChannelIds?.length > 0) ||
                                  (guildSettings?.leveling?.noXpRoleIds?.length > 0);
            const xpHint = hasExclusions
                ? '💡 Some channels or roles may not earn XP. Use /xpinfo to see details.'
                : null;

            // Prestige + ranked summary lines (appended to whichever embed we send)
            const prestigeRank = user.accountPrestige?.rank ?? 0;
            const eloVal       = user.ranked?.elo ?? START_ELO;
            const eloTier      = eloTierFor(eloVal);
            const showRanked   = (user.ranked?.rankedWins ?? 0) + (user.ranked?.rankedLosses ?? 0) > 0;
            const identityField = (() => {
                const parts = [];
                if (prestigeRank > 0) {
                    parts.push(`${badgeFor(prestigeRank)} **${prestigeTitle(prestigeRank)}**`);
                }
                if (showRanked) {
                    parts.push(`${eloTier.icon} **${eloTier.label}** (${eloVal} ELO)`);
                }
                if (!parts.length) return null;
                return { name: '🪪 Identity', value: parts.join('\n'), inline: false };
            })();

            if (activeBoosters.length || hasServerBoost) {
                const lines = [];
                if (hasServerBoost) {
                    const boostType = sb.type === 'coin' ? `💰 ${serverCoinMult}x Coins` : `⭐ ${serverXpMult}x XP`;
                    lines.push(`🌐 **Server Boost** — ${boostType} (${timeRemaining(sb.expiresAt)} remaining)`);
                }
                for (const e of activeBoosters) {
                    const cfg = EFFECT_CONFIGS[e.type];
                    if (!cfg) continue;
                    lines.push(`${cfg.emoji} **${cfg.label}** — ${timeRemaining(e.expiresAt)}`);
                }
                const boosterEmbed = new EmbedBuilder()
                    .setColor('#f39c12')
                    .addFields({ name: '🚀 Active Boosters', value: lines.join('\n'), inline: false });
                if (identityField) boosterEmbed.addFields(identityField);
                if (xpHint) boosterEmbed.setFooter({ text: xpHint });
                await interaction.reply({ files: [attachment], embeds: [boosterEmbed] });
            } else if (identityField) {
                const idEmbed = new EmbedBuilder().setColor('#9b59b6').addFields(identityField);
                if (xpHint) idEmbed.setFooter({ text: xpHint });
                await interaction.reply({ files: [attachment], embeds: [idEmbed] });
            } else if (xpHint) {
                const hintEmbed = new EmbedBuilder()
                    .setColor('#95a5a6')
                    .setFooter({ text: xpHint });
                await interaction.reply({ files: [attachment], embeds: [hintEmbed] });
            } else {
                await interaction.reply({ files: [attachment] });
            }
        } catch (error) {
            console.error('Rank error:', error);
            await interaction.reply({ content: 'Failed to fetch rank.', ephemeral: true });
        }
    }
};
