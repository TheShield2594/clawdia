const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { logTransaction } = require('../../utils/logTransaction');
const {
    hasActiveEvent,
    getEventCurrencyId,
} = require('../../services/seasonalEventService');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');

const COOLDOWN_MS      = 5 * 60 * 1000; // 5 minutes
const HIT_CHANCE       = 0.65;          // 65% to hit
const BASE_COIN_REWARD = 20;
const SNOWFLAKE_REWARD = 3;             // event currency reward
const COIN_STEAL_RATE  = 0.05;          // steal 5% of target's wallet on hit

module.exports = {
    data: new SlashCommandBuilder()
        .setName('snowball')
        .setDescription('Throw a snowball at another user! Only available during Winter Wonderland.')
        .addUserOption(o =>
            o.setName('target')
                .setDescription('Who to throw a snowball at')
                .setRequired(true)),

    cooldown: 0, // managed manually with lastSnowball

    async execute(interaction) {
        await interaction.deferReply();

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (!hasActiveEvent(guildSettings) || guildSettings.activeEvent.type !== 'winter_wonderland') {
            return interaction.editReply({
                content: '❄️ Snowball fights are only available during the **Winter Wonderland** event!'
            });
        }

        const target = interaction.options.getUser('target');

        if (target.id === interaction.user.id) {
            return interaction.editReply({ content: "You can't throw a snowball at yourself!" });
        }
        if (target.bot) {
            return interaction.editReply({ content: "You can't throw snowballs at bots!" });
        }

        // Atomically claim the cooldown + spend one snowball in a single update — the
        // cooldown guard and inventory-availability guard both live in the filter, so two
        // concurrent /snowball calls can't both pass before either one's write commits.
        const claimNow = new Date();
        const cooldownFloor = new Date(claimNow.getTime() - COOLDOWN_MS);
        let attacker = await User.findOneAndUpdate(
            {
                userId: interaction.user.id,
                guildId: interaction.guild.id,
                $or: [{ lastSnowball: null }, { lastSnowball: { $lte: cooldownFloor } }],
                inventory: { $elemMatch: { itemId: 'snowball', quantity: { $gte: 1 } } },
            },
            {
                $set: { lastSnowball: claimNow },
                $inc: { 'inventory.$[slot].quantity': -1 },
            },
            {
                arrayFilters: [{ 'slot.itemId': 'snowball' }],
                new: true,
            },
        );

        if (!attacker) {
            const fresh = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });

            if (fresh?.lastSnowball && Date.now() - new Date(fresh.lastSnowball).getTime() < COOLDOWN_MS) {
                const nextAt = new Date(new Date(fresh.lastSnowball).getTime() + COOLDOWN_MS);
                return interaction.editReply({
                    embeds: [buildCooldownEmbed({
                        title: '❄️ Restocking Snowballs',
                        description: "You're scooping fresh snow for the next volley.\nPick your next target while you wait.",
                        color: '#a8d8f0',
                        nextAt,
                        nextRewardPreview: 'Hit: steal 5% of target\'s wallet + 20 coins + ❄️ Snowflakes',
                    })],
                });
            }

            return interaction.editReply({
                content: `❄️ You don't have any **Snowballs** in your inventory! Buy some from \`/eventshop\`.`
            });
        }

        // Best-effort cleanup of the now-empty snowball slot; doesn't affect correctness.
        User.updateOne(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $pull: { inventory: { itemId: 'snowball', quantity: { $lte: 0 } } } },
        ).catch(() => {});

        const hit = Math.random() < HIT_CHANCE;

        let coinsGained = 0;
        let stolen = 0;
        let defender = null;
        let description = '';

        if (hit) {
            const defenderSnap = await User.findOne({ userId: target.id, guildId: interaction.guild.id });
            const targetWallet = defenderSnap?.balance ?? 0;
            stolen = Math.floor(targetWallet * COIN_STEAL_RATE);
            coinsGained = BASE_COIN_REWARD + stolen;

            attacker = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: coinsGained } },
                { new: true },
            );

            if (defenderSnap && stolen > 0) {
                const decrement = Math.min(stolen, defenderSnap.balance ?? 0);
                defender = await User.findOneAndUpdate(
                    { userId: target.id, guildId: interaction.guild.id },
                    { $inc: { balance: -decrement } },
                    { new: true },
                );
            } else {
                defender = defenderSnap;
            }

            const currencyId = getEventCurrencyId(guildSettings);
            if (currencyId) {
                attacker = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, 'eventCurrency.currencyId': currencyId },
                    { $inc: { 'eventCurrency.$.amount': SNOWFLAKE_REWARD } },
                    { new: true },
                );
                if (!attacker) {
                    attacker = await User.findOneAndUpdate(
                        { userId: interaction.user.id, guildId: interaction.guild.id },
                        { $push: { eventCurrency: { currencyId, amount: SNOWFLAKE_REWARD } } },
                        { new: true },
                    );
                }
            }

            description = [
                `💥 **DIRECT HIT!** You nailed <@${target.id}> with a snowball!`,
                ``,
                `🪙 You swiped **${stolen.toLocaleString()}** coins off them!`,
                `💰 Total gained: **+${coinsGained.toLocaleString()} coins**`,
                `❄️ +**${SNOWFLAKE_REWARD} Snowflakes** earned!`,
            ].join('\n');

            logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'snowball_win', amount: coinsGained, balance: attacker.balance, relatedUserId: target.id });
            if (defender) logTransaction({ userId: target.id, guildId: interaction.guild.id, type: 'snowball_loss', amount: -stolen, balance: defender.balance, relatedUserId: interaction.user.id });
        } else {
            description = [
                `💨 **MISS!** Your snowball sailed right past <@${target.id}>!`,
                ``,
                `Better luck next time — you still used one snowball.`,
            ].join('\n');
        }

        const embed = new EmbedBuilder()
            .setColor(hit ? '#a8d8f0' : '#888888')
            .setTitle(hit ? '❄️ Snowball Hit!' : '❄️ Snowball Miss!')
            .setDescription(description)
            .setFooter({ text: 'Cooldown: 5m • Use /eventshop to restock snowballs' })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }
};
