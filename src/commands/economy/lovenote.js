const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { logTransaction } = require('../../utils/logTransaction');
const {
    hasActiveEvent,
    getEventCurrencyId,
    addEventCurrency,
} = require('../../services/seasonalEventService');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');

const COOLDOWN_MS    = 60 * 60 * 1000; // 1 hour
const HEART_REWARD   = 5;              // event currency
const REJECT_CHANCE  = 0.35;           // 35% chance of an awkward reply
const REPLIES = [
    { name: 'A Shy Smile',          emoji: '😊', rarity: 'common',    coins: 25 },
    { name: 'A Returned Note',      emoji: '💌', rarity: 'common',    coins: 30 },
    { name: 'A Box of Chocolates',  emoji: '🍫', rarity: 'uncommon',  coins: 50 },
    { name: 'A Bouquet in Return',  emoji: '💐', rarity: 'uncommon',  coins: 60 },
    { name: "Cupid's Approval",     emoji: '🏹', rarity: 'rare',      coins: 100 },
    { name: 'The Golden Rose',      emoji: '✨', rarity: 'legendary', coins: 200 },
];

const REJECTION_OUTCOMES = [
    { name: 'Wrong Mailbox',     emoji: '📭', description: 'Your note went to the Dead Letter Office by mistake. The filing fee comes out of your pocket.', coinLoss: 20 },
    { name: 'Friend-Zoned',      emoji: '🤝', description: 'A very kind, very firm handshake. You buy the consolation coffee.',                              coinLoss: 40 },
    { name: 'Spilled the Wine',  emoji: '🍷', description: 'You knock over the table making your move. The Arcade bills you for the tablecloth.',            coinLoss: 75 },
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('lovenote')
        .setDescription('Send a love note into the Arcade and see what comes back! Valentine\'s Day only.'),

    cooldown: 0, // managed with lastLoveNote

    async execute(interaction) {
        await interaction.deferReply();

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (!hasActiveEvent(guildSettings) || guildSettings.activeEvent.type !== 'valentines_day') {
            return interaction.editReply({
                content: "💝 Love notes are only available during the **Valentine's Day** event!"
            });
        }

        // Fast pre-check for a user-friendly remaining-time message
        const existingUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (existingUser?.lastLoveNote) {
            const elapsed = Date.now() - new Date(existingUser.lastLoveNote).getTime();
            if (elapsed < COOLDOWN_MS) {
                const nextAt = new Date(new Date(existingUser.lastLoveNote).getTime() + COOLDOWN_MS);
                return interaction.editReply({
                    embeds: [buildCooldownEmbed({
                        title: '💌 The Ink Is Still Wet',
                        description: "Give the Arcade a little time before sending another note.\nThere's a whole promenade of shops to wander in the meantime.",
                        color: '#ff69b4',
                        nextAt,
                        nextRewardPreview: 'Next note: 65% sweet reply · chance at ✨ The Golden Rose (200 coins) + 💝 Hearts event currency',
                    })],
                });
            }
        }

        // Atomic cooldown claim — guards against concurrent duplicate submissions
        let user;
        const cooldownThreshold = new Date(Date.now() - COOLDOWN_MS);
        if (existingUser) {
            const claimed = await User.findOneAndUpdate(
                {
                    userId: interaction.user.id,
                    guildId: interaction.guild.id,
                    $or: [
                        { lastLoveNote: null },
                        { lastLoveNote: { $lt: cooldownThreshold } }
                    ]
                },
                { $set: { lastLoveNote: new Date() } },
                { new: true }
            );
            if (!claimed) {
                return interaction.editReply({
                    embeds: [buildCooldownEmbed({
                        title: '💌 The Ink Is Still Wet',
                        description: "You already sent a note this hour! Give the Arcade a moment to reply.",
                        color: '#ff69b4',
                    })],
                });
            }
            user = claimed;
        } else {
            user = new User({ userId: interaction.user.id, guildId: interaction.guild.id, lastLoveNote: new Date() });
        }

        const isRejected = Math.random() < REJECT_CHANCE;
        let embed;
        let logPayload;

        if (isRejected) {
            const rejection = REJECTION_OUTCOMES[Math.floor(Math.random() * REJECTION_OUTCOMES.length)];
            const loss = Math.min(rejection.coinLoss, user.balance ?? 0);
            user.balance = Math.max(0, (user.balance ?? 0) - loss);

            logPayload = {
                userId:   interaction.user.id,
                guildId:  interaction.guild.id,
                type:     'lovenote_rejection',
                amount:   -loss,
                balance:  user.balance,
            };

            embed = new EmbedBuilder()
                .setColor('#888888')
                .setTitle(`${rejection.emoji} AWKWARD!`)
                .setDescription(
                    `**${rejection.name}**\n${rejection.description}\n\n` +
                    `💸 You lost **${loss.toLocaleString()} coins**.`
                )
                .setFooter({ text: 'Cooldown: 1h • Better luck next time!' })
                .setTimestamp();
        } else {
            // Weighted reply roll
            const pool = [];
            const weights = [60, 25, 10, 5, 3, 1];
            REPLIES.forEach((r, i) => {
                for (let j = 0; j < weights[i]; j++) pool.push(r);
            });
            const reply = pool[Math.floor(Math.random() * pool.length)];

            const currencyId = getEventCurrencyId(guildSettings);
            if (currencyId) addEventCurrency(user, currencyId, HEART_REWARD);

            user.balance = (user.balance ?? 0) + reply.coins;

            // Add a chocolate box to inventory
            const invSlot = user.inventory?.find(i => i.itemId === 'chocolate_box');
            if (invSlot) {
                invSlot.quantity += 1;
            } else {
                if (!user.inventory) user.inventory = [];
                user.inventory.push({ itemId: 'chocolate_box', quantity: 1 });
            }

            logPayload = {
                userId:   interaction.user.id,
                guildId:  interaction.guild.id,
                type:     'lovenote_reply',
                amount:   reply.coins,
                balance:  user.balance,
            };

            embed = new EmbedBuilder()
                .setColor('#ff69b4')
                .setTitle(`${reply.emoji} A REPLY! — ${reply.name}`)
                .setDescription(
                    `Your note found someone, and they wrote back: **${reply.name}**!\n\n` +
                    `💰 **+${reply.coins.toLocaleString()} coins**\n` +
                    `💝 **+${HEART_REWARD} Hearts** (event currency)\n` +
                    `🍫 A **Chocolate Box** was added to your inventory!`
                )
                .addFields({ name: 'Rarity', value: `\`${reply.rarity.toUpperCase()}\``, inline: true })
                .setFooter({ text: 'Cooldown: 1h • Use /eventshop to spend your Hearts' })
                .setTimestamp();
        }

        await user.save();
        logTransaction(logPayload);
        return interaction.editReply({ embeds: [embed] });
    }
};
