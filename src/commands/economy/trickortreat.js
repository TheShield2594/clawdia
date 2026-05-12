const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { logTransaction } = require('../../utils/logTransaction');
const {
    hasActiveEvent,
    getEventCurrencyId,
    addEventCurrency,
} = require('../../services/seasonalEventService');

const COOLDOWN_MS    = 60 * 60 * 1000; // 1 hour
const CANDY_REWARD   = 5;              // event currency
const TRICK_CHANCE   = 0.35;           // 35% chance of a trick (penalty)
const TREATS = [
    { name: 'Candy Corn',      emoji: '🍬', rarity: 'common',    coins: 25 },
    { name: 'Lollipop',        emoji: '🍭', rarity: 'common',    coins: 30 },
    { name: 'Chocolate Bar',   emoji: '🍫', rarity: 'uncommon',  coins: 50 },
    { name: 'Caramel Apple',   emoji: '🍎', rarity: 'uncommon',  coins: 60 },
    { name: 'Pumpkin Cookie',  emoji: '🎃', rarity: 'rare',      coins: 100 },
    { name: 'Golden Candy',    emoji: '✨', rarity: 'legendary', coins: 200 },
];

const TRICK_OUTCOMES = [
    { name: 'Rotten Egg',      emoji: '🥚', description: 'Someone threw a rotten egg at you! You lost coins cleaning up.',  coinLoss: 20 },
    { name: 'Spider Scare',    emoji: '🕷️', description: 'A spider jumped out and you dropped your wallet!',                coinLoss: 40 },
    { name: 'Haunted House',   emoji: '👻', description: 'You ran from a ghost and lost some coins!',                        coinLoss: 75 },
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('trickortreat')
        .setDescription('Knock on a spooky door for candy or consequences! Spooky Season only.'),

    cooldown: 0, // managed with lastTrickOrTreat

    async execute(interaction) {
        await interaction.deferReply();

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (!hasActiveEvent(guildSettings) || guildSettings.activeEvent.type !== 'spooky_season') {
            return interaction.editReply({
                content: '🎃 Trick-or-treating is only available during the **Spooky Season** event!'
            });
        }

        // Fast pre-check for a user-friendly remaining-time message
        const existingUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (existingUser?.lastTrickOrTreat) {
            const elapsed = Date.now() - new Date(existingUser.lastTrickOrTreat).getTime();
            if (elapsed < COOLDOWN_MS) {
                const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 60_000);
                return interaction.editReply({
                    content: `🎃 You already went trick-or-treating! Come back in **${remaining} min**.`
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
                        { lastTrickOrTreat: null },
                        { lastTrickOrTreat: { $lt: cooldownThreshold } }
                    ]
                },
                { $set: { lastTrickOrTreat: new Date() } },
                { new: true }
            );
            if (!claimed) {
                return interaction.editReply({ content: '🎃 You already went trick-or-treating! Try again later.' });
            }
            user = claimed;
        } else {
            user = new User({ userId: interaction.user.id, guildId: interaction.guild.id, lastTrickOrTreat: new Date() });
        }

        const isTrick = Math.random() < TRICK_CHANCE;
        let embed;

        if (isTrick) {
            const trick = TRICK_OUTCOMES[Math.floor(Math.random() * TRICK_OUTCOMES.length)];
            const loss = Math.min(trick.coinLoss, user.balance ?? 0);
            user.balance = Math.max(0, (user.balance ?? 0) - loss);

            logTransaction({
                userId:   interaction.user.id,
                guildId:  interaction.guild.id,
                type:     'trickortreat_trick',
                amount:   -loss,
                balance:  user.balance,
            });

            embed = new EmbedBuilder()
                .setColor('#ff4500')
                .setTitle(`${trick.emoji} TRICK!`)
                .setDescription(
                    `**${trick.name}**\n${trick.description}\n\n` +
                    `💸 You lost **${loss.toLocaleString()} coins**.`
                )
                .setFooter({ text: 'Cooldown: 1 hour • Better luck next time!' })
                .setTimestamp();
        } else {
            // Weighted treat roll
            const pool = [];
            const weights = [60, 25, 10, 5, 3, 1];
            TREATS.forEach((t, i) => {
                for (let j = 0; j < weights[i]; j++) pool.push(t);
            });
            const treat = pool[Math.floor(Math.random() * pool.length)];

            const currencyId = getEventCurrencyId(guildSettings);
            if (currencyId) addEventCurrency(user, currencyId, CANDY_REWARD);

            user.balance = (user.balance ?? 0) + treat.coins;

            // Add candy item to inventory
            const invSlot = user.inventory?.find(i => i.itemId === 'candy_bag');
            if (invSlot) {
                invSlot.quantity += 1;
            } else {
                if (!user.inventory) user.inventory = [];
                user.inventory.push({ itemId: 'candy_bag', quantity: 1 });
            }

            logTransaction({
                userId:   interaction.user.id,
                guildId:  interaction.guild.id,
                type:     'trickortreat_treat',
                amount:   treat.coins,
                balance:  user.balance,
            });

            embed = new EmbedBuilder()
                .setColor('#ff6b00')
                .setTitle(`${treat.emoji} TREAT! — ${treat.name}`)
                .setDescription(
                    `You knocked on the door and received a **${treat.name}**!\n\n` +
                    `💰 **+${treat.coins.toLocaleString()} coins**\n` +
                    `🍬 **+${CANDY_REWARD} Candy** (event currency)\n` +
                    `🎃 A **Candy Bag** was added to your inventory!`
                )
                .addFields({ name: 'Rarity', value: `\`${treat.rarity.toUpperCase()}\``, inline: true })
                .setFooter({ text: 'Cooldown: 1 hour • Use /eventshop to spend your Candy' })
                .setTimestamp();
        }

        await user.save();
        return interaction.editReply({ embeds: [embed] });
    }
};
