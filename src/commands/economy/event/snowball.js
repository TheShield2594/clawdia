const { EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { logTransaction } = require('../../../utils/logTransaction');
const { debitUpTo } = require('../../../utils/balanceDebit');
const { creditCoinsOrOwe, creditEventCurrencyOrOwe } = require('../../../utils/creditOrOwe');
const { eventActivityPayoutKey } = require('../../../utils/payoutKey');
const {
    hasActiveEvent,
    getEventCurrencyId,
} = require('../../../services/seasonalEventService');
const { buildCooldownEmbed } = require('../../../utils/cooldownEmbed');

const COOLDOWN_MS      = 5 * 60 * 1000; // 5 minutes
const HIT_CHANCE       = 0.65;          // 65% to hit
const BASE_COIN_REWARD = 20;
const SNOWFLAKE_REWARD = 3;             // event currency reward
const COIN_STEAL_RATE  = 0.05;          // steal 5% of target's wallet on hit

async function handleSnowball(interaction) {
    await interaction.deferReply();

    const guildSettings = await getGuildSettings(interaction.guild.id);

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
            $inc: { 'inventory.$.quantity': -1 },
        },
        {
            // Plain positional $ touches only the first matched array element —
            // unlike arrayFilters' $[slot], which would decrement every inventory
            // entry with itemId 'snowball' if duplicate slots ever exist.
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

    let coinsGained, stolen, defender, description;
    let coinsOwed = false, currencyOwed = false;

    if (hit) {
        // Debit the defender first, atomically guarded against their balance
        // having changed since the snapshot — only then credit the attacker
        // with what was *actually* taken, so a stale snapshot can't mint coins
        // for the attacker beyond what the defender truly lost.
        const defenderSnap = await User.findOne({ userId: target.id, guildId: interaction.guild.id });
        const targetWallet = defenderSnap?.balance ?? 0;
        stolen = Math.floor(targetWallet * COIN_STEAL_RATE);

        if (defenderSnap && stolen > 0) {
            defender = await User.findOneAndUpdate(
                { userId: target.id, guildId: interaction.guild.id, balance: { $gte: stolen } },
                { $inc: { balance: -stolen } },
                { new: true },
            );
            if (!defender) {
                // The guarded debit missed because the wallet shrank. Take
                // what is left with the clamp inside the update — reading the
                // balance again and clamping against that is the same race one
                // round deeper, and its $inc would still overshoot.
                const defenderFilter = { userId: target.id, guildId: interaction.guild.id };
                const { taken } = await debitUpTo(User, defenderFilter, stolen);
                stolen = taken;
                defender = await User.findOne(defenderFilter);
            }
        } else {
            stolen = 0;
            defender = defenderSnap;
        }

        coinsGained = BASE_COIN_REWARD + stolen;

        // The stake — a snowball and the 5-minute cooldown — is already spent, so
        // a credit that fails costs the attacker both with nothing to show for it.
        // Both the coins and the snowflakes are keyed (#873, pass 8): the bare
        // `$inc` they replace read nothing back, so a write against a pruned
        // document announced coins that never moved, and a lost response left no
        // replayable record. The event currency also no longer needs the
        // increment-then-push dance — `creditEventCurrencyOnce` appends the entry
        // when the player holds none in the same guarded write.
        const attackerFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
        const coinCredit = await creditCoinsOrOwe(attackerFilter, coinsGained, {
            payoutKey: eventActivityPayoutKey('snowball', interaction.id, 'coins'),
            service: 'snowball', jobName: 'snowballHit',
        });
        coinsOwed = !coinCredit.credited;
        if (coinCredit.doc) attacker = coinCredit.doc;

        const currencyId = getEventCurrencyId(guildSettings);
        if (currencyId) {
            const currencyCredit = await creditEventCurrencyOrOwe(attackerFilter, currencyId, SNOWFLAKE_REWARD, {
                payoutKey: eventActivityPayoutKey('snowball', interaction.id, 'currency'),
                service: 'snowball', jobName: 'snowflakeReward',
            });
            currencyOwed = !currencyCredit.credited;
            if (currencyCredit.doc) attacker = currencyCredit.doc;
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

    // A credit that could not land is recorded as owed, not lost — say so rather
    // than let the description above stand as if it had paid.
    if (coinsOwed || currencyOwed) {
        const parts = [coinsOwed && 'your coins', currencyOwed && 'your Snowflakes'].filter(Boolean);
        embed.addFields({
            name: '⚠️ Not Yet Delivered',
            value: `We couldn't credit ${parts.join(' and ')} just now — it's been recorded as owed and will arrive once the problem clears. Tell an admin if it doesn't.`,
        });
    }

    return interaction.editReply({ embeds: [embed] });
}

module.exports = { handleSnowball };
