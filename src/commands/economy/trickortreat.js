const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { logTransaction } = require('../../utils/logTransaction');
const { saveWithBalanceDelta } = require('../../utils/balanceDelta');
const { grantInventoryItem } = require('../../utils/inventoryGrant');
const {
    hasActiveEvent,
    getEventCurrencyId,
    addEventCurrency,
} = require('../../services/seasonalEventService');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');

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
                const nextAt = new Date(new Date(existingUser.lastTrickOrTreat).getTime() + COOLDOWN_MS);
                return interaction.editReply({
                    embeds: [buildCooldownEmbed({
                        title: '🎃 The Doors Are Closed',
                        description: "The neighbors need a moment before they answer again.\nThere are still plenty of houses on the street.",
                        color: '#ff6b00',
                        nextAt,
                        nextRewardPreview: 'Next knock: 65% treat · chance at ✨ Golden Candy (200 coins) + 🍬 Candy event currency',
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
                        { lastTrickOrTreat: null },
                        { lastTrickOrTreat: { $lt: cooldownThreshold } }
                    ]
                },
                { $set: { lastTrickOrTreat: new Date() } },
                { new: true }
            );
            if (!claimed) {
                return interaction.editReply({
                    embeds: [buildCooldownEmbed({
                        title: '🎃 The Doors Are Closed',
                        description: "You already went trick-or-treating! The street will open up again soon.",
                        color: '#ff6b00',
                    })],
                });
            }
            user = claimed;
        } else {
            user = new User({ userId: interaction.user.id, guildId: interaction.guild.id, lastTrickOrTreat: new Date() });
        }

        // Coins move as a delta, not as a snapshot: `save()` writes `balance` as an
        // absolute `$set`, so a casino bet or a gift landing between the read above
        // and this write would simply be erased. See src/utils/balanceDelta.js.
        const balanceAtLoad = user.balance ?? 0;

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
                .setFooter({ text: 'Cooldown: 1h • Better luck next time!' })
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
                .setFooter({ text: 'Cooldown: 1h • Use /eventshop to spend your Candy' })
                .setTimestamp();
        }

        await saveWithBalanceDelta(User, user, balanceAtLoad, {
            service: 'trickortreat',
            jobName: 'knockPayout',
            guildId: interaction.guild.id,
        });
        if (!isTrick) {
            // The candy bag lands as its own atomic upsert rather than riding the
            // save: a slot pushed in memory can duplicate one a concurrent credit
            // is creating (src/utils/inventoryGrant.js). The save above inserted
            // the document for a first-time player, so the grant always has a doc
            // to hit.
            await grantInventoryItem(interaction.user.id, interaction.guild.id, 'candy_bag', 1);
        }
        return interaction.editReply({ embeds: [embed] });
    }
};
