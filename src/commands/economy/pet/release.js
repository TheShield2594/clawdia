'use strict';

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const { PET_DEFINITIONS, getPetDisplay, resolvePetRef } = require('../../../services/petService');
const { isVersionError, withVersionRetry } = require('../../../utils/versionRetry');
const COLORS = require('../../../utils/embedColors');
const { ownedBy } = require('../../../utils/collectorOwner');
const { NO_SUCH_PET, resolveUser, readSlotOption } = require('./shared');

async function executeRelease(interaction) {
    const user   = await resolveUser(interaction);
    const target = resolvePetRef(user?.pets, readSlotOption(interaction));
    if (!target) return interaction.reply({ content: NO_SUCH_PET, flags: MessageFlags.Ephemeral });

    const { pet } = target;
    const def     = PET_DEFINITIONS[pet.petId];
    const name    = pet.name || def?.name || pet.petId;
    const petId   = String(pet._id);
    const level   = pet.level ?? 1;
    const bondDays = Math.floor((Date.now() - new Date(pet.adoptedAt).getTime()) / 86400000);

    // Releasing is permanent and unrevivable — a Revive Scroll only brings back
    // pets lost to starvation — so a level 30 pet was one mistyped slot away
    // from being gone with no confirmation at all.
    const confirmId = `pet_release_yes:${interaction.id}`;
    const cancelId  = `pet_release_no:${interaction.id}`;
    const confirm = await interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(COLORS.ERROR)
            .setTitle(`Release ${name}?`)
            .setDescription(
                `${getPetDisplay(pet).emoji} **${getPetDisplay(pet).titledName}** — Lv.${level}, ` +
                `${bondDays} day${bondDays === 1 ? '' : 's'} of bond, ${pet.battleWins ?? 0}W / ${pet.battleLosses ?? 0}L.\n\n` +
                `**This cannot be undone.** A Revive Scroll only restores pets lost to starvation, not released ones.`
            )],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(confirmId).setLabel('Release').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(cancelId).setLabel('Keep them').setStyle(ButtonStyle.Secondary),
        )],
        flags: MessageFlags.Ephemeral,
        withResponse: true,
    }).catch(() => null);

    const message = confirm?.resource?.message ?? await interaction.fetchReply().catch(() => null);
    if (!message) return;

    let choice;
    try {
        choice = await message.awaitMessageComponent({
            filter: ownedBy(interaction.user.id, i => [confirmId, cancelId].includes(i.customId), "This isn't your pet."),
            time: 30_000,
        });
    } catch {
        return interaction.editReply({ content: `Release cancelled — **${name}** stays with you.`, embeds: [], components: [] }).catch(() => {});
    }

    if (choice.customId === cancelId) {
        return choice.update({ content: `**${name}** stays with you.`, embeds: [], components: [] }).catch(() => {});
    }

    // Re-resolve by id: the roster may have changed while the prompt was open.
    // Dropping a pet by id is a pure function of the freshly read roster, so a
    // lost version race can simply replay instead of bouncing back to the user.
    let saved = null;
    let conflict = false;
    try {
        saved = await withVersionRetry(
            () => resolveUser(interaction),
            (fresh) => {
                const still = resolvePetRef(fresh?.pets, petId);
                if (!still) return false;
                fresh.pets.splice(still.index, 1);
                fresh.markModified('pets');
            },
            { label: 'pet release' }
        );
    } catch (err) {
        if (!isVersionError(err)) throw err;
        conflict = true;
    }

    if (conflict) {
        return choice.update({ content: 'Edit conflict — try again.', embeds: [], components: [] }).catch(() => {});
    }
    if (!saved) {
        return choice.update({ content: `**${name}** is no longer in your roster.`, embeds: [], components: [] }).catch(() => {});
    }

    return choice.update({
        content: `${def?.emoji ?? '🐾'} **${name}** has been released. Goodbye, friend!`,
        embeds: [], components: [],
    }).catch(() => {});
}

module.exports = { executeRelease };
