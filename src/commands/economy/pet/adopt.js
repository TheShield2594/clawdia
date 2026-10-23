'use strict';

const { EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const {
    PET_DEFINITIONS, PERSONALITY_TRAITS, STARVING_THRESHOLD,
    createPet, joinVacation, noteCodex, hasFreePetSlot, petCapacity, countSlotPets, sanitizePetName, formatPetBonus,
} = require('../../../services/petService');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { isVersionError } = require('../../../utils/versionRetry');
const { petArt } = require('../../../services/petStatusView');
const COLORS = require('../../../utils/embedColors');
const { refundAdoptFee, adoptRefundNote } = require('../../../utils/petEconomy');
const { resolveUser, collectPetAchievements, announcePetAchievements } = require('./shared');

async function executeAdopt(interaction) {
    const petId = interaction.options.getString('type');
    const rawName = interaction.options.getString('name');
    const petName = rawName == null ? null : sanitizePetName(rawName);
    const def   = PET_DEFINITIONS[petId];

    if (rawName != null && !petName) {
        return interaction.reply({ content: 'That name has nothing left once mentions and formatting characters are taken out — try letters, numbers or emoji.', flags: MessageFlags.Ephemeral });
    }

    if (!def) return interaction.reply({ content: 'Unknown pet type.', flags: MessageFlags.Ephemeral });
    if (!def.purchasable) {
        return interaction.reply({
            content: `${def.emoji} **${def.name}** can only be obtained as a legendary drop — it's not sold in any shop!`,
            flags: MessageFlags.Ephemeral
        });
    }

    const [user, guildSettings] = await Promise.all([resolveUser(interaction), getGuildSettings(interaction.guild.id)]);

    if (guildSettings?.economy?.enabled === false) return interaction.reply({ content: 'The economy is disabled in this server.', flags: MessageFlags.Ephemeral });
    if ((user.pets ?? []).some(p => p.petId === petId)) return interaction.reply({ content: `You already own a ${def.emoji} **${def.name}**!`, flags: MessageFlags.Ephemeral });
    if (!hasFreePetSlot(user)) {
        return interaction.reply({
            content: `🐾 You're caring for **${countSlotPets(user.pets)}** pets and have room for **${petCapacity(user)}**. `
                   + `Release one with \`/pet release\`, or buy a **Pet Slot Expansion** from \`/shop\` for another slot.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const currency = guildSettings?.economy?.currency ?? '💰';
    if (user.balance < def.cost) {
        return interaction.reply({
            content: `You need **${def.cost.toLocaleString()}** ${currency} to adopt this pet but only have **${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // The adoption fee is a conditional update, not `balance -= cost` followed by
    // a save: the balance read above goes stale the moment anything else pays or
    // charges this player, and saving it back would erase that write.
    const charged = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: def.cost } },
        { $inc: { balance: -def.cost } },
        { new: true, projection: { balance: 1 } },
    );
    if (!charged) {
        return interaction.reply({
            content: `Adopting this pet costs **${def.cost.toLocaleString()}** ${currency} — you no longer have enough. Check \`/balance\` and try again.`,
            flags: MessageFlags.Ephemeral,
        });
    }
    // Take the authoritative balance and keep the save off that path.
    user.balance = charged.balance;
    user.unmarkModified('balance');

    // A pet adopted mid-vacation joins it, so the pause covers every pet (#1181).
    const newPet = joinVacation(user, createPet(petId, { name: petName }));
    user.pets.push(newPet);
    noteCodex(user, petId);
    user.markModified('pets');
    const personality = newPet.personality;

    const earned = await collectPetAchievements(user, guildSettings);

    try {
        await user.save();
    } catch (err) {
        // The fee is already gone; hand it back rather than charging for a pet
        // that was never adopted. The refund is keyed and its result read: a bare
        // `$inc` that read nothing back told the player their coins came back
        // whether or not the write matched a document (#873, pass 10), so the
        // reply is worded from what the refund actually did. The non-version
        // failure is answered here rather than rethrown, because the generic
        // handler cannot say what became of the coins.
        const back = await refundAdoptFee(interaction.user.id, interaction.guild.id, def.cost, interaction.id);
        const note = adoptRefundNote(back);
        if (isVersionError(err)) return interaction.reply({ content: `Edit conflict — ${note}. Please try again.`, flags: MessageFlags.Ephemeral });
        console.error('[pet adopt] save error:', err);
        return interaction.reply({ content: `Something went wrong adopting **${petName || def.name}** — ${note}.`, flags: MessageFlags.Ephemeral });
    }
    announcePetAchievements(interaction, user, guildSettings, earned);

    const personalityDef = PERSONALITY_TRAITS[personality];
    const displayName = petName || def.name;
    const embed = new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle(`${def.emoji} New Pet Adopted!`)
        .setDescription(
            `Welcome **${displayName}** to your family! Take good care of them.\n\n` +
            `${personalityDef.emoji} **Personality: ${personalityDef.label}** — *${personalityDef.desc}*`
        )
        .addFields(
            { name: 'Passive Bonus',  value: `${formatPetBonus(def.bonusType, def.bonusPct)} (active when hunger ≥ ${STARVING_THRESHOLD}%)`, inline: true },
            { name: 'Favorite Food',  value: `\`${def.favoriteMaterial}\` (restores 25 hunger)`,                                  inline: true },
            { name: 'Cost',           value: `${def.cost.toLocaleString()} ${currency}`,                                           inline: true },
        )
        .setFooter({ text: 'Use /pet status to see your pet\'s mood, or /pet feed to keep it happy!' })
        .setTimestamp();

    const art = await petArt(petId, interaction.guild.id, displayName);
    if (art) embed.setThumbnail(art.url);
    return interaction.reply({ embeds: [embed], files: art ? [art.attachment] : [] });
}

module.exports = { executeAdopt };
