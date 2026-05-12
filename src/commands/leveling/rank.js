const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { createRankCard } = require('../../utils/cardGenerator');
const { pruneEffects, EFFECT_CONFIGS, timeRemaining, getServerCoinMultiplier, getServerXpMultiplier } = require('../../services/effectsService');

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

            const card       = await createRankCard(targetUser, user, rank, requiredXp);
            const attachment = new AttachmentBuilder(card, { name: 'rank.png' });

            const BOOSTER_TYPES = new Set(['coin_booster_2x', 'xp_booster_2x', 'lucky_streak', 'salary_raise']);
            const activeBoosters = (user.activeEffects || []).filter(e => BOOSTER_TYPES.has(e.type));

            const serverCoinMult = getServerCoinMultiplier(guildSettings);
            const serverXpMult   = getServerXpMultiplier(guildSettings);
            const sb = guildSettings?.serverBoost;
            const hasServerBoost = (serverCoinMult > 1.0 || serverXpMult > 1.0) && sb?.expiresAt;

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
                await interaction.reply({ files: [attachment], embeds: [boosterEmbed] });
            } else {
                await interaction.reply({ files: [attachment] });
            }
        } catch (error) {
            console.error('Rank error:', error);
            await interaction.reply({ content: 'Failed to fetch rank.', ephemeral: true });
        }
    }
};