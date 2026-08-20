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

const COOLDOWN_MS   = 60 * 60 * 1000; // 1 hour
const SHELL_REWARD  = 5;              // event currency
const WAVE_CHANCE    = 0.35;          // 35% chance the tide ruins it
const PRIZES = [
    { name: 'Sturdy Sandcastle',     emoji: '🏰', rarity: 'common',    coins: 25 },
    { name: 'Shell-Studded Tower',   emoji: '🐚', rarity: 'common',    coins: 30 },
    { name: 'Moat & Drawbridge',     emoji: '🌊', rarity: 'uncommon',  coins: 50 },
    { name: 'Driftwood Fortress',    emoji: '🪵', rarity: 'uncommon',  coins: 60 },
    { name: "Judges' Favorite",      emoji: '🏆', rarity: 'rare',      coins: 100 },
    { name: 'The Glassworks Castle', emoji: '✨', rarity: 'legendary', coins: 200 },
];

const WAVE_OUTCOMES = [
    { name: 'Rogue Wave',    emoji: '🌊', description: 'A wave swallows your castle whole. You lose coins fishing your tools out of the surf.', coinLoss: 20 },
    { name: 'Seagull Raid',  emoji: '🐦', description: 'A gull steals your snack AND your shovel. The shovel was rented.',                       coinLoss: 40 },
    { name: 'Stepped On',    emoji: '🦶', description: 'A jogger flattens your masterpiece without slowing down. You pay for the "art consultation" you never asked for.', coinLoss: 75 },
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('sandcastle')
        .setDescription('Build a sandcastle on the shore! Summer Festival only.'),

    cooldown: 0, // managed with lastSandcastle

    async execute(interaction) {
        await interaction.deferReply();

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (!hasActiveEvent(guildSettings) || guildSettings.activeEvent.type !== 'summer_festival') {
            return interaction.editReply({
                content: '☀️ Sandcastle building is only available during the **Summer Festival** event!'
            });
        }

        // Fast pre-check for a user-friendly remaining-time message
        const existingUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (existingUser?.lastSandcastle) {
            const elapsed = Date.now() - new Date(existingUser.lastSandcastle).getTime();
            if (elapsed < COOLDOWN_MS) {
                const nextAt = new Date(new Date(existingUser.lastSandcastle).getTime() + COOLDOWN_MS);
                return interaction.editReply({
                    embeds: [buildCooldownEmbed({
                        title: '🏰 The Sand Needs Time',
                        description: "The tide hasn't reset the beach yet.\nThere's still a whole shoreline to explore.",
                        color: '#ffd700',
                        nextAt,
                        nextRewardPreview: 'Next build: 65% great castle · chance at ✨ The Glassworks Castle (200 coins) + 🐚 Shells event currency',
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
                        { lastSandcastle: null },
                        { lastSandcastle: { $lt: cooldownThreshold } }
                    ]
                },
                { $set: { lastSandcastle: new Date() } },
                { new: true }
            );
            if (!claimed) {
                return interaction.editReply({
                    embeds: [buildCooldownEmbed({
                        title: '🏰 The Sand Needs Time',
                        description: "You already built a castle this hour! The shoreline will reset soon.",
                        color: '#ffd700',
                    })],
                });
            }
            user = claimed;
        } else {
            user = new User({ userId: interaction.user.id, guildId: interaction.guild.id, lastSandcastle: new Date() });
        }

        // Coins move as a delta, not as a snapshot: `save()` writes `balance` as an
        // absolute `$set`, so a casino bet or a gift landing between the read above
        // and this write would simply be erased. See src/utils/balanceDelta.js.
        const balanceAtLoad = user.balance ?? 0;

        const isWave = Math.random() < WAVE_CHANCE;
        let embed;
        let logPayload;

        if (isWave) {
            const wave = WAVE_OUTCOMES[Math.floor(Math.random() * WAVE_OUTCOMES.length)];
            const loss = Math.min(wave.coinLoss, user.balance ?? 0);
            user.balance = Math.max(0, (user.balance ?? 0) - loss);

            logPayload = {
                userId:   interaction.user.id,
                guildId:  interaction.guild.id,
                type:     'sandcastle_wave',
                amount:   -loss,
                balance:  user.balance,
            };

            embed = new EmbedBuilder()
                .setColor('#1565c0')
                .setTitle(`${wave.emoji} WIPED OUT!`)
                .setDescription(
                    `**${wave.name}**\n${wave.description}\n\n` +
                    `💸 You lost **${loss.toLocaleString()} coins**.`
                )
                .setFooter({ text: 'Cooldown: 1h • Better luck next time!' })
                .setTimestamp();
        } else {
            // Weighted prize roll
            const pool = [];
            const weights = [60, 25, 10, 5, 3, 1];
            PRIZES.forEach((p, i) => {
                for (let j = 0; j < weights[i]; j++) pool.push(p);
            });
            const prize = pool[Math.floor(Math.random() * pool.length)];

            const currencyId = getEventCurrencyId(guildSettings);
            if (currencyId) addEventCurrency(user, currencyId, SHELL_REWARD);

            user.balance = (user.balance ?? 0) + prize.coins;

            logPayload = {
                userId:   interaction.user.id,
                guildId:  interaction.guild.id,
                type:     'sandcastle_prize',
                amount:   prize.coins,
                balance:  user.balance,
            };

            embed = new EmbedBuilder()
                .setColor('#ffd700')
                .setTitle(`${prize.emoji} BUILT! — ${prize.name}`)
                .setDescription(
                    `Your sandcastle drew a crowd and won a **${prize.name}**!\n\n` +
                    `💰 **+${prize.coins.toLocaleString()} coins**\n` +
                    `🐚 **+${SHELL_REWARD} Shells** (event currency)\n` +
                    `☀️ A **Seashell** was added to your inventory!`
                )
                .addFields({ name: 'Rarity', value: `\`${prize.rarity.toUpperCase()}\``, inline: true })
                .setFooter({ text: 'Cooldown: 1h • Use /eventshop to spend your Shells' })
                .setTimestamp();
        }

        await saveWithBalanceDelta(User, user, balanceAtLoad, {
            service: 'sandcastle',
            jobName: 'buildPayout',
            guildId: interaction.guild.id,
        });
        if (!isWave) {
            // The seashell lands as its own atomic upsert rather than riding the
            // save: a slot pushed in memory can duplicate one a concurrent credit
            // is creating (src/utils/inventoryGrant.js). The save above inserted
            // the document for a first-time player, so the grant always has a doc
            // to hit.
            await grantInventoryItem(interaction.user.id, interaction.guild.id, 'seashell', 1);
        }
        logTransaction(logPayload);
        return interaction.editReply({ embeds: [embed] });
    }
};
