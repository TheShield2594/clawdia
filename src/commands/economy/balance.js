const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { pruneEffects, EFFECT_CONFIGS, timeRemaining, getServerCoinMultiplier, getServerXpMultiplier } = require('../../services/effectsService');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('balance')
        .setDescription('Check your wallet and bank balance, or look up another member\'s balance.')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User whose balance to check (defaults to yourself).')
                .setRequired(false)),
    async execute(interaction) {
        const targetUser = interaction.options.getUser('user') || interaction.user;

        try {
            const [user_raw, guildSettings] = await Promise.all([
                User.findOne({ userId: targetUser.id, guildId: interaction.guild.id }),
                Guild.findOne({ guildId: interaction.guild.id })
            ]);

            let user = user_raw;
            if (!user) {
                user = await User.create({ userId: targetUser.id, guildId: interaction.guild.id });
            }

            // Prune expired effects before displaying
            pruneEffects(user);

            const streakMult = getStreakMultiplier(user.streak?.current ?? 0);
            const streakDays = user.streak?.current ?? 0;
            const streakInfo = streakMult > 1.0
                ? `🔥 ${streakDays}-day streak · **${streakMult}x** coins & XP`
                : `❄️ ${streakDays}-day streak · 1.0x (7 days for bonus)`;

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle(`${targetUser.username}'s Balance`)
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: '💰 Wallet', value: `${user.balance.toLocaleString()} coins`, inline: true },
                    { name: '🏦 Bank',   value: `${user.bank.toLocaleString()} coins`,    inline: true },
                    { name: '💎 Total',  value: `${(user.balance + user.bank).toLocaleString()} coins`, inline: true },
                    { name: '⚡ Streak Bonus', value: streakInfo, inline: false }
                )
                .setTimestamp();

            // Show server boost banner if active
            const serverCoinMult = getServerCoinMultiplier(guildSettings);
            const serverXpMult   = getServerXpMultiplier(guildSettings);
            const sb = guildSettings?.serverBoost;
            if ((serverCoinMult > 1.0 || serverXpMult > 1.0) && sb?.expiresAt) {
                const boostType  = sb.type === 'coin' ? `💰 ${serverCoinMult}x Coins` : `⭐ ${serverXpMult}x XP`;
                const remaining  = timeRemaining(sb.expiresAt);
                embed.addFields({
                    name:   '🌐 Server Boost Active!',
                    value:  `${boostType} — **${remaining}** remaining`,
                    inline: false
                });
            }

            // Show active effects as indicators
            if (user.activeEffects?.length) {
                const BOOSTER_TYPES = new Set(['coin_booster_2x', 'xp_booster_2x', 'lucky_streak', 'salary_raise']);
                const boosters   = [];
                const protectors = [];

                for (const e of user.activeEffects) {
                    const cfg = EFFECT_CONFIGS[e.type];
                    if (!cfg) continue;
                    const duration = e.expiresAt ? timeRemaining(e.expiresAt) : (e.charges === 1 ? '1 use left' : 'permanent');
                    const line = `${cfg.emoji} **${cfg.label}** — ${duration}`;
                    if (BOOSTER_TYPES.has(e.type)) boosters.push(line);
                    else protectors.push(line);
                }

                if (boosters.length) {
                    embed.addFields({ name: '🚀 Active Boosters', value: boosters.join('\n'), inline: false });
                }
                if (protectors.length) {
                    embed.addFields({ name: '🔮 Active Effects', value: protectors.join('\n'), inline: false });
                }
            }

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Balance error:', error);
            await interaction.reply({ content: 'Failed to fetch balance.', ephemeral: true });
        }
    }
};
