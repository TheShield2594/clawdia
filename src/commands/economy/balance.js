const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const { pruneEffects, EFFECT_CONFIGS, timeRemaining } = require('../../services/effectsService');

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
            let user = await User.findOne({ userId: targetUser.id, guildId: interaction.guild.id });

            if (!user) {
                user = await User.create({ userId: targetUser.id, guildId: interaction.guild.id });
            }

            // Prune expired effects before displaying
            pruneEffects(user);

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle(`${targetUser.username}'s Balance`)
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: '💰 Wallet', value: `${user.balance.toLocaleString()} coins`, inline: true },
                    { name: '🏦 Bank',   value: `${user.bank.toLocaleString()} coins`,    inline: true },
                    { name: '💎 Total',  value: `${(user.balance + user.bank).toLocaleString()} coins`, inline: true }
                )
                .setTimestamp();

            // Show active protective effects as indicators
            if (user.activeEffects?.length) {
                const indicators = user.activeEffects.map(e => {
                    const cfg = EFFECT_CONFIGS[e.type];
                    if (!cfg) return null;
                    const duration = e.expiresAt ? timeRemaining(e.expiresAt) : (e.charges === 1 ? '1 use left' : 'permanent');
                    return `${cfg.emoji} **${cfg.label}** — ${duration}`;
                }).filter(Boolean);

                if (indicators.length) {
                    embed.addFields({ name: '🔮 Active Effects', value: indicators.join('\n'), inline: false });
                }
            }

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Balance error:', error);
            await interaction.reply({ content: 'Failed to fetch balance.', ephemeral: true });
        }
    }
};
