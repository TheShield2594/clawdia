const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { pruneEffects, EFFECT_CONFIGS, timeRemaining, getServerCoinMultiplier, getServerXpMultiplier } = require('../../services/effectsService');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');
const { claimStarterKit } = require('../../utils/starterKit');

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

            // Grant starter kit to new users on first economy command use (self only)
            const isSelfCheck = targetUser.id === interaction.user.id;
            let starterKitResult = null;
            if (isSelfCheck && !user.onboarding?.starterKitClaimed) {
                starterKitResult = await claimStarterKit(interaction.user.id, interaction.guild.id);
                if (starterKitResult) {
                    user.balance = (user.balance || 0) + starterKitResult.coins;
                }
            }

            // Prune expired effects before displaying
            pruneEffects(user);

            const streakMult = getStreakMultiplier(user.streak?.current ?? 0);
            const streakDays = user.streak?.current ?? 0;
            const freezeCount = user.streak?.freezes ?? 0;
            const freezeTag = freezeCount > 0 ? ` · ❄️ ${freezeCount} freeze${freezeCount !== 1 ? 's' : ''} banked` : '';
            const streakInfo = streakMult > 1.0
                ? `🔥 ${streakDays}-day streak · **${streakMult}x** coins & XP${freezeTag}`
                : `❄️ ${streakDays}-day streak · 1.0x (7 days for bonus)${freezeTag}`;

            const total = user.balance + user.bank;
            const isSelf = targetUser.id === interaction.user.id;
            const titleName = isSelf ? 'Your' : `${targetUser.username}'s`;

            const embed = new EmbedBuilder()
                .setColor('#FFD700')
                .setAuthor({ name: `${titleName} Dashboard`, iconURL: targetUser.displayAvatarURL({ dynamic: true }) })
                .setDescription(
                    `**💰 Wallet** · ${user.balance.toLocaleString()} coins\n` +
                    `**🏦 Bank** · ${user.bank.toLocaleString()} coins\n` +
                    `**💎 Net Worth** · ${total.toLocaleString()} coins`
                )
                .addFields({ name: '⚡ Streak', value: streakInfo, inline: false })
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

            // Economy reference benchmarks for context
            const walletCoins = user.balance || 0;
            if (isSelf && walletCoins < 10000) {
                const padlockCost = 5000;
                const avgHuntEarn = 350;
                const avgWorkEarn = 200;
                const coinsNeeded = Math.max(0, padlockCost - walletCoins);
                const workRunsNeeded = coinsNeeded > 0 ? Math.ceil(coinsNeeded / avgWorkEarn) : 0;
                const referenceLines = [
                    `🔒 Padlock costs **5,000** — you're **${walletCoins >= padlockCost ? 'there!' : `${coinsNeeded.toLocaleString()} away`}**${workRunsNeeded > 0 ? ` (~${workRunsNeeded} work runs)` : ''}`,
                    `⛏️ Average \`/hunt\` earns ~**${avgHuntEarn}**/run`,
                    `💼 Average \`/work\` earns ~**${avgWorkEarn}**/shift`,
                ];
                embed.addFields({ name: '📊 Economy Reference', value: referenceLines.join('\n'), inline: false });
            }

            if (starterKitResult) {
                embed.addFields({
                    name: '🎁 Welcome to Clawdia!',
                    value: `You received a starter kit: **+${starterKitResult.coins.toLocaleString()} coins** · 🛟 Lifesaver · 🍀 Lucky Charm\nUse \`/daily\` every day to build your streak and multiply earnings!`,
                    inline: false,
                });
            }

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Balance error:', error);
            await interaction.reply({ content: 'Failed to fetch balance.', ephemeral: true });
        }
    }
};
