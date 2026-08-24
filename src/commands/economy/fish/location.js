'use strict';

// /fish location — where the player fishes, and switching between the spots
// they have unlocked.

const Guild = require('../../../models/Guild');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { ensureFishingData } = require('../../../services/fishService');
const { LOCATION_LIST, LOCATIONS } = require('../../../data/fishData');
const { formatTierWeights } = require('./embeds');
const COLORS = require('../../../utils/embedColors');

// ═══════════════════════════════════════════════════════════════════════════════
// LOCATION
// ═══════════════════════════════════════════════════════════════════════════════

async function handleLocation(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureFishingData(user);

    switch (sub) {
        case 'list': return showLocationList(interaction, user, currency);
        case 'set':  return setLocation(interaction, user, currency);
    }
}

async function showLocationList(interaction, user, currency) {
    const f = user.fishing;

    const locationLines = LOCATION_LIST.map(loc => {
        const isUnlocked = f.unlockedLocations.includes(loc.id);
        const isActive   = f.activeLocation === loc.id;
        const tierStr    = formatTierWeights(loc.tierWeights);
        const status     = isActive ? ' **[ACTIVE]**' : isUnlocked ? ' ✅' : ` 🔒 Lv.${loc.unlockLevel}${loc.unlockCost > 0 ? ` / ${currency}${loc.unlockCost.toLocaleString()}` : ''}`;

        return [
            `${loc.emoji} **${loc.name}**${status}`,
            `   ${loc.description}`,
            `   Tiers: ${tierStr}`,
            `   Junk: ${Math.round(loc.junkChance * 100)}% | Treasure: ${Math.round(loc.treasureChance * 100)}%${loc.payoutBonus > 0 ? ` | Payout +${Math.round(loc.payoutBonus * 100)}%` : ''}`
        ].join('\n');
    });

    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle('🗺️ Fishing Locations')
        .setDescription(locationLines.join('\n\n'))
        .setFooter({ text: 'Unlock new locations with /fish shop unlock • Switch with /fish location set' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function setLocation(interaction, user, _currency) {
    const f          = user.fishing;
    const locationId = interaction.options.getString('location');
    const location   = LOCATIONS[locationId];

    if (!location) {
        return interaction.reply({ content: 'Unknown location.', flags: MessageFlags.Ephemeral });
    }
    if (!f.unlockedLocations.includes(locationId)) {
        return interaction.reply({
            content: `**${location.name}** is locked. Unlock it with \`/fish shop unlock\`.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (f.level < location.unlockLevel) {
        return interaction.reply({
            content: `You need Fisher Level **${location.unlockLevel}** to fish at **${location.name}**. You are Level **${f.level}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    f.activeLocation = locationId;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[location set] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle(`📍 Location Changed`)
                .setDescription(`You are now fishing at **${location.emoji} ${location.name}**.`)
                .addFields({ name: 'About', value: location.description, inline: false })
                .setTimestamp()
        ]
    });
}

module.exports = {
    handleLocation,
    setLocation,
    showLocationList,
};
