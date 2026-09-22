'use strict';

// /explore travel — open the way to a region (paying the toll if needed) and
// make it the player's active region.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const { REGIONS } = require('../../../data/exploreData');
const { isRegionInSeason, isRegionEnabled } = require('../../../services/exploreService');
const { logTransaction } = require('../../../utils/logTransaction');
const { exploreRegionItemId } = require('../../../data/activityItems');
const { attachItemThumbnail } = require('../../../utils/itemImageHelper');
const { loadContext } = require('./shared');

async function handleTravel(interaction) {
    const ctx = await loadContext(interaction);
    if (!ctx) return;
    const { guildSettings, user, currency } = ctx;
    const e = user.exploration;

    const region = REGIONS[interaction.options.getString('region')];
    if (!region) {
        return interaction.reply({ content: 'I don\'t have that place on any map, and I have several maps.', flags: MessageFlags.Ephemeral });
    }
    if (!isRegionEnabled(region, guildSettings)) {
        return interaction.reply({ content: `**${region.name}** is closed by decree of the server staff.`, flags: MessageFlags.Ephemeral });
    }
    if (region.seasonalEventId && !isRegionInSeason(region, guildSettings)) {
        return interaction.reply({ content: `**${region.emoji} ${region.name}** is out of season. It will return when the calendar does its part.`, flags: MessageFlags.Ephemeral });
    }

    let unlockLine = '';
    let unlockCharged = 0;
    if (!region.seasonalEventId && !e.unlockedRegions.includes(region.id)) {
        if (e.level < region.unlockLevel) {
            return interaction.reply({
                content: `The way to **${region.emoji} ${region.name}** needs Explorer Level **${region.unlockLevel}**. You're Level **${e.level}**. The road respects experience; go collect some.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        if (user.balance < region.unlockCost) {
            return interaction.reply({
                content: `Opening the route to **${region.emoji} ${region.name}** costs **${currency}${region.unlockCost.toLocaleString()}** — guides, bribes, one very specific key. You have ${currency}${user.balance.toLocaleString()}.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        // The toll is a conditional update, not `balance -= cost` followed by a
        // save: the balance read above goes stale the moment anything else pays
        // this player, and saving it back would erase that payout.
        const charged = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: region.unlockCost } },
            { $inc: { balance: -region.unlockCost } },
            { new: true, projection: { balance: 1 } },
        );
        if (!charged) {
            return interaction.reply({
                content: `Opening the route to **${region.emoji} ${region.name}** costs **${currency}${region.unlockCost.toLocaleString()}** — you no longer have enough. Check \`/balance\` and try again.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        // Take the authoritative balance and keep the save off that path.
        user.balance = charged.balance;
        user.unmarkModified('balance');
        unlockCharged = region.unlockCost;
        e.unlockedRegions.push(region.id);
        unlockLine = `\n\n🔓 Route opened for **${currency}${region.unlockCost.toLocaleString()}**. Money well buried.`;
    }

    e.activeRegion = region.id;
    user.markModified('exploration');
    try {
        await user.save();
    } catch (err) {
        console.error('[explore travel] save error:', err);
        let refunded = false;
        if (unlockCharged) {
            // The toll is already gone; hand it back rather than charging for a
            // route that was never opened.
            // A resolved promise is not proof the coins went back — an update
            // that matched nothing resolves just as happily. Only a matched
            // document means the toll actually returned.
            refunded = await User.updateOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: unlockCharged } },
            ).then(res => (res?.matchedCount ?? 0) > 0).catch(refundErr => {
                console.error('[explore travel] refund after failed save:', refundErr);
                return false;
            });
        }
        return interaction.reply({
            // Only promise the refund that actually landed. Saying "refunded"
            // when the refund itself threw sends the player away satisfied while
            // their coins are still gone.
            content: unlockCharged && !refunded
                ? `Something went wrong opening the route, and the **${currency}${unlockCharged.toLocaleString()}** taken could not be returned automatically. Tell an admin — it is recoverable.`
                : 'Something went wrong opening the route — any coins taken were refunded. Please try again.',
            flags: MessageFlags.Ephemeral,
        });
    }

    // Logged after the save, not before: the failure path above hands the toll
    // back, and a ledger entry written first would leave a debit the balance
    // never made. `user.balance` is already the authoritative post-charge value.
    if (unlockCharged) {
        logTransaction({ userId: user.userId, guildId: user.guildId, type: 'explore_unlock', amount: -unlockCharged, balance: user.balance, note: region.name });
    }

    const embed = new EmbedBuilder()
        .setColor(region.color)
        .setTitle(`${region.emoji} Now Exploring: ${region.name}`)
        .setDescription(`*${region.description}*${unlockLine}`)
        .setFooter({ text: region.tagline });
    const files = await attachItemThumbnail(embed, exploreRegionItemId(region.id), interaction.guild.id, region.name);

    return interaction.reply({ embeds: [embed], files });
}

module.exports = {
    handleTravel,
};
