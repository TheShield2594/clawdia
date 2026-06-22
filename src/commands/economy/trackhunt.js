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
const FROST_REWARD   = 5;              // event currency
const LOST_CHANCE    = 0.35;           // 35% chance you lose the trail
const FINDS = [
    { name: 'Fresh Tracks',       emoji: '🐾', rarity: 'common',    coins: 25 },
    { name: 'Frozen Trail Marker', emoji: '🚩', rarity: 'common',    coins: 30 },
    { name: 'Arctic Hare Pelt',   emoji: '🐇', rarity: 'uncommon',  coins: 50 },
    { name: 'Frost-Touched Antler', emoji: '🦌', rarity: 'uncommon', coins: 60 },
    { name: 'A Hunting Cache',    emoji: '📦', rarity: 'rare',      coins: 100 },
    { name: 'The White Stag\'s Sliver', emoji: '✨', rarity: 'legendary', coins: 200 },
];

const LOST_OUTCOMES = [
    { name: 'Frostbite',        emoji: '🥶', description: 'You stayed out too long chasing a cold trail. The medicine isn\'t cheap.',     coinLoss: 20 },
    { name: 'Broken Gear',      emoji: '🔧', description: 'Your snowshoe strap snaps mid-track. You pay for a rush repair.',              coinLoss: 40 },
    { name: 'Lost in a Whiteout', emoji: '🌫️', description: 'A whiteout swallows the trail and your sense of direction. The walk back is expensive.', coinLoss: 75 },
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('trackhunt')
        .setDescription('Track game across the Arctic Tundra! The Winter Hunt only.'),

    cooldown: 0, // managed with lastTrackHunt

    async execute(interaction) {
        await interaction.deferReply();

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (!hasActiveEvent(guildSettings) || guildSettings.activeEvent.type !== 'winter_hunt') {
            return interaction.editReply({
                content: '🏔️ Tracking is only available during **The Winter Hunt** event!'
            });
        }

        // Fast pre-check for a user-friendly remaining-time message
        const existingUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (existingUser?.lastTrackHunt) {
            const elapsed = Date.now() - new Date(existingUser.lastTrackHunt).getTime();
            if (elapsed < COOLDOWN_MS) {
                const nextAt = new Date(new Date(existingUser.lastTrackHunt).getTime() + COOLDOWN_MS);
                return interaction.editReply({
                    embeds: [buildCooldownEmbed({
                        title: '🐾 The Trail Has Gone Cold',
                        description: "Give the tundra a little time to lay down a fresh trail.\nThere's plenty of ice left to cover.",
                        color: '#6ab4f5',
                        nextAt,
                        nextRewardPreview: "Next track: 65% find · chance at ✨ The White Stag's Sliver (200 coins) + 🧊 Frost Tokens event currency",
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
                        { lastTrackHunt: null },
                        { lastTrackHunt: { $lt: cooldownThreshold } }
                    ]
                },
                { $set: { lastTrackHunt: new Date() } },
                { new: true }
            );
            if (!claimed) {
                return interaction.editReply({
                    embeds: [buildCooldownEmbed({
                        title: '🐾 The Trail Has Gone Cold',
                        description: "You already tracked something this hour! The tundra needs a moment to lay down fresh trail.",
                        color: '#6ab4f5',
                    })],
                });
            }
            user = claimed;
        } else {
            user = new User({ userId: interaction.user.id, guildId: interaction.guild.id, lastTrackHunt: new Date() });
        }

        const isLost = Math.random() < LOST_CHANCE;
        let embed;
        let logPayload;

        if (isLost) {
            const lost = LOST_OUTCOMES[Math.floor(Math.random() * LOST_OUTCOMES.length)];
            const loss = Math.min(lost.coinLoss, user.balance ?? 0);
            user.balance = Math.max(0, (user.balance ?? 0) - loss);

            logPayload = {
                userId:   interaction.user.id,
                guildId:  interaction.guild.id,
                type:     'trackhunt_lost',
                amount:   -loss,
                balance:  user.balance,
            };

            embed = new EmbedBuilder()
                .setColor('#888888')
                .setTitle(`${lost.emoji} TRAIL LOST!`)
                .setDescription(
                    `**${lost.name}**\n${lost.description}\n\n` +
                    `💸 You lost **${loss.toLocaleString()} coins**.`
                )
                .setFooter({ text: 'Cooldown: 1h • Better luck next time!' })
                .setTimestamp();
        } else {
            // Weighted find roll
            const pool = [];
            const weights = [60, 25, 10, 5, 3, 1];
            FINDS.forEach((f, i) => {
                for (let j = 0; j < weights[i]; j++) pool.push(f);
            });
            const find = pool[Math.floor(Math.random() * pool.length)];

            const currencyId = getEventCurrencyId(guildSettings);
            if (currencyId) addEventCurrency(user, currencyId, FROST_REWARD);

            user.balance = (user.balance ?? 0) + find.coins;

            // Add a snowflake lure to inventory
            const invSlot = user.inventory?.find(i => i.itemId === 'snowflake_lure');
            if (invSlot) {
                invSlot.quantity += 1;
            } else {
                if (!user.inventory) user.inventory = [];
                user.inventory.push({ itemId: 'snowflake_lure', quantity: 1 });
            }

            logPayload = {
                userId:   interaction.user.id,
                guildId:  interaction.guild.id,
                type:     'trackhunt_find',
                amount:   find.coins,
                balance:  user.balance,
            };

            embed = new EmbedBuilder()
                .setColor('#6ab4f5')
                .setTitle(`${find.emoji} FOUND! — ${find.name}`)
                .setDescription(
                    `You followed the trail and turned up a **${find.name}**!\n\n` +
                    `💰 **+${find.coins.toLocaleString()} coins**\n` +
                    `🧊 **+${FROST_REWARD} Frost Tokens** (event currency)\n` +
                    `❄️ A **Snowflake Lure** was added to your inventory!`
                )
                .addFields({ name: 'Rarity', value: `\`${find.rarity.toUpperCase()}\``, inline: true })
                .setFooter({ text: 'Cooldown: 1h • Use /eventshop to spend your Frost Tokens' })
                .setTimestamp();
        }

        await user.save();
        logTransaction(logPayload);
        return interaction.editReply({ embeds: [embed] });
    }
};
