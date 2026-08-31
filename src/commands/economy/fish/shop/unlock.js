'use strict';

// `/fish shop unlock` — buying access to a location.

const { MessageFlags, EmbedBuilder } = require('discord.js');
const User = require('../../../../models/User');
const { persistGrindIfNew } = require('../../../../utils/grindProfile');
const { LOCATIONS } = require('../../../../data/fishData');
const GrindProfile = require('../../../../models/GrindProfile');
const COLORS = require('../../../../utils/embedColors');

async function handleUnlock(interaction, user, currency) {
    const f          = user.fishing;
    const locationId = interaction.options.getString('location');
    const location   = LOCATIONS[locationId];

    if (!location) {
        return interaction.reply({ content: 'Unknown location.', flags: MessageFlags.Ephemeral });
    }
    if (f.unlockedLocations.includes(locationId)) {
        return interaction.reply({ content: `**${location.name}** is already unlocked.`, flags: MessageFlags.Ephemeral });
    }
    if (f.level < location.unlockLevel) {
        return interaction.reply({
            content: `You need Fisher Level **${location.unlockLevel}** to unlock **${location.name}**. You are Level **${f.level}**.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (user.balance < location.unlockCost) {
        return interaction.reply({
            content: `Unlocking **${location.name}** costs **${currency}${location.unlockCost.toLocaleString()}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Phase 1: claim the unlock on the fishing profile (level gate + not-yet-unlocked)
    await persistGrindIfNew(user, 'fishing');
    const profUpdated = await GrindProfile.findOneAndUpdate(
        {
            userId:  interaction.user.id,
            guildId: interaction.guild.id,
            system:  'fishing',
            'data.level': { $gte: location.unlockLevel },
            'data.unlockedLocations': { $ne: locationId }
        },
        {
            $addToSet: { 'data.unlockedLocations': locationId },
            $set:      { 'data.activeLocation': locationId }
        },
        { new: true }
    ).catch(() => null);

    if (!profUpdated) {
        return interaction.reply({ content: 'Purchase failed. Conditions may have changed — please try again.', flags: MessageFlags.Ephemeral });
    }

    // Phase 2: charge the unlock cost; roll the unlock back if the debit fails
    const updated = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: location.unlockCost } },
        { $inc: { balance: -location.unlockCost } },
        { new: true }
    );

    if (!updated) {
        await GrindProfile.updateOne(
            { userId: interaction.user.id, guildId: interaction.guild.id, system: 'fishing' },
            { $pull: { 'data.unlockedLocations': locationId }, $set: { 'data.activeLocation': user.fishing.activeLocation } }
        ).catch(() => {});
        return interaction.reply({ content: 'Purchase failed. Conditions may have changed — please try again.', flags: MessageFlags.Ephemeral });
    }

    // Sync the in-memory profile so a later save doesn't clobber the unlock
    user.fishing.unlockedLocations = profUpdated.data.unlockedLocations;
    user.fishing.activeLocation    = locationId;

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.WARN)
                .setTitle(`🗺️ ${location.emoji} ${location.name} Unlocked!`)
                .setDescription(location.description)
                .addFields(
                    { name: 'Cost Paid', value: location.unlockCost > 0 ? `${currency}${location.unlockCost.toLocaleString()}` : 'Free', inline: true },
                    { name: 'Balance',   value: `${currency}${updated.balance.toLocaleString()}`,                                          inline: true },
                    { name: 'Status',    value: 'Now your active location!',                                                              inline: true }
                )
                .setFooter({ text: 'Use /fish cast to start catching from this location • Switch anytime with /fish location set' })
                .setTimestamp()
        ]
    });
}

module.exports = { handleUnlock };
