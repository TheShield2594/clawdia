const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const DEFAULT_THRESHOLD = 10_000;

/**
 * Returns { shouldProceed: boolean, alreadyReplied: boolean }.
 * alreadyReplied is true when a confirmation prompt was sent (so callers must
 * NOT call interaction.deferReply() afterwards — the interaction is already
 * acknowledged by the ephemeral prompt).
 */
async function confirmBet(interaction, amount, walletBalance, gameName, guildSettings = null) {
    const economy = guildSettings?.economy || {};
    const configured = economy.betConfirmThreshold;
    if (configured === 0) return { shouldProceed: true, alreadyReplied: false };

    const threshold = typeof configured === 'number' && configured > 0
        ? configured
        : Math.min(DEFAULT_THRESHOLD, Math.floor(walletBalance * 0.5));

    if (amount <= threshold) return { shouldProceed: true, alreadyReplied: false };

    const currency = economy.currency || '💰';
    const pct = walletBalance > 0 ? Math.round((amount / walletBalance) * 100) : 100;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_large_bet').setLabel('Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cancel_large_bet').setLabel('Cancel').setStyle(ButtonStyle.Danger),
    );

    const embed = new EmbedBuilder()
        .setColor('#f1c40f')
        .setTitle('⚠️ Large Bet Confirmation')
        .setDescription([
            `You're about to bet **${currency}${amount.toLocaleString()}** on **${gameName}**.`,
            `Your current wallet: **${currency}${walletBalance.toLocaleString()}**`,
            '',
            `This is **${pct}%** of your wallet. Are you sure?`,
        ].join('\n'))
        .setFooter({ text: 'This prompt expires in 15 seconds.' });

    const reply = await interaction.reply({ embeds: [embed], components: [row], ephemeral: true, fetchReply: true });

    try {
        const response = await reply.awaitMessageComponent({
            time: 15_000,
            filter: i => i.user.id === interaction.user.id,
        });

        if (response.customId === 'confirm_large_bet') {
            await response.update({ content: '✅ Bet confirmed.', embeds: [], components: [] });
            return { shouldProceed: true, alreadyReplied: true };
        }

        await response.update({ content: '❌ Bet cancelled. Your coins are safe.', embeds: [], components: [] });
        return { shouldProceed: false, alreadyReplied: true };
    } catch {
        await interaction.editReply({ content: '⏱️ Bet cancelled. Your coins are safe.', embeds: [], components: [] }).catch(() => {});
        return { shouldProceed: false, alreadyReplied: true };
    }
}

module.exports = { confirmBet };
