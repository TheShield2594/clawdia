const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { logTransaction } = require('../../utils/logTransaction');
const {
    hasActiveEvent,
    getEventCurrencyId,
    addEventCurrency,
} = require('../../services/seasonalEventService');

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

        const [attacker, defender] = await Promise.all([
            User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
            User.findOne({ userId: target.id,           guildId: interaction.guild.id }),
        ]);

        // Cooldown check
        if (attacker?.lastSnowball) {
            const elapsed = Date.now() - new Date(attacker.lastSnowball).getTime();
            if (elapsed < COOLDOWN_MS) {
                const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
                return interaction.editReply({
                    content: `❄️ You need to restock your snowballs! Try again in **${remaining}s**.`
                });
            }
        }

        // Check attacker has snowballs in inventory
        const snowballSlot = attacker?.inventory?.find(i => i.itemId === 'snowball');
        if (!snowballSlot || snowballSlot.quantity < 1) {
            return interaction.editReply({
                content: `❄️ You don't have any **Snowballs** in your inventory! Buy some from \`/eventshop\`.`
            });
        }

        const hit = Math.random() < HIT_CHANCE;

        // Deduct snowball
        snowballSlot.quantity -= 1;
        if (snowballSlot.quantity <= 0) {
            attacker.inventory = attacker.inventory.filter(i => i.itemId !== 'snowball');
        }

        attacker.lastSnowball = new Date();

        let coinsGained = 0;
        let description = '';

        if (hit) {
            const targetWallet = defender?.balance ?? 0;
            const stolen = Math.floor(targetWallet * COIN_STEAL_RATE);
            coinsGained = BASE_COIN_REWARD + stolen;

            attacker.balance = (attacker.balance ?? 0) + coinsGained;
            if (defender) {
                defender.balance = Math.max(0, (defender.balance ?? 0) - stolen);
            }

            const currencyId = getEventCurrencyId(guildSettings);
            if (currencyId) addEventCurrency(attacker, currencyId, SNOWFLAKE_REWARD);

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

        await Promise.all([
            attacker.save(),
            defender && hit ? defender.save() : Promise.resolve(),
        ]);

        const embed = new EmbedBuilder()
            .setColor(hit ? '#a8d8f0' : '#888888')
            .setTitle(hit ? '❄️ Snowball Hit!' : '❄️ Snowball Miss!')
            .setDescription(description)
            .setFooter({ text: 'Cooldown: 5m • Use /eventshop to restock snowballs' })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }
};
