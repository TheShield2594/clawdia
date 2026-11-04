'use strict';

// /pet ascend — start a level 30 pet over at level 1 for a permanent star.
// The rules (what is kept, what a star is worth) live in the Ascension
// section of services/petService.js; this file is the confirmation and the
// write.

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const {
    PET_DEFINITIONS, PET_MAX_LEVEL, ASCENSION_MAX, ASCENSION_BONUS_PER_STAR, ASCENSION_STAR, MAX_STACKED_BONUS_PCT,
    getPetDisplay, resolvePetRef, petAscensions, canAscend, ascendPet,
    getEffectiveBonusPct, formatPetBonus, stageForLevel,
} = require('../../../services/petService');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { isVersionError, withVersionRetry } = require('../../../utils/versionRetry');
const COLORS = require('../../../utils/embedColors');
const { ownedBy } = require('../../../utils/collectorOwner');
const {
    NO_SUCH_PET, resolveUser, readSlotOption, collectPetAchievements, announcePetAchievements,
} = require('./shared');

/** Why a pet cannot ascend, as the player reads it. */
function refusal(reason, name, pet) {
    if (reason === 'maxed')    return `**${name}** already has all ${ASCENSION_MAX} ${ASCENSION_STAR} stars — there is nowhere higher to go.`;
    if (reason === 'vacation') return `**${name}** is on vacation. End it with \`/pet vacation\` first.`;
    return `**${name}** needs to reach level ${PET_MAX_LEVEL} to ascend (it is level ${pet.level ?? 1}).`;
}

/**
 * A passive as it pays out: getTotalBonus caps any one bonus type at
 * MAX_STACKED_BONUS_PCT, so a rare pet's starred passive can read higher than
 * it pays. Every figure shown here goes through this.
 */
function paidPct(pct) {
    return Math.min(MAX_STACKED_BONUS_PCT, pct);
}

/** The passive at level 30 with one more star, as paid, without changing `pet`. */
function nextMaxPct(pet) {
    const plain = pet.toObject ? pet.toObject() : { ...pet };
    return paidPct(getEffectiveBonusPct({
        ...plain,
        ascensions: petAscensions(pet) + 1,
        level: PET_MAX_LEVEL,
        evolutionStage: stageForLevel(PET_MAX_LEVEL),
    }));
}

async function executeAscend(interaction) {
    const user   = await resolveUser(interaction);
    const target = resolvePetRef(user?.pets, readSlotOption(interaction));
    if (!target) return interaction.reply({ content: NO_SUCH_PET, flags: MessageFlags.Ephemeral });

    const { pet } = target;
    const def     = PET_DEFINITIONS[pet.petId];
    const name    = pet.name || def?.name || pet.petId;
    const petId   = String(pet._id);

    const check = canAscend(pet);
    if (!check.ok) return interaction.reply({ content: refusal(check.reason, name, pet), flags: MessageFlags.Ephemeral });

    const stars   = petAscensions(pet) + 1;
    const nowPct  = paidPct(getEffectiveBonusPct(pet));
    const thenPct = nextMaxPct(pet);
    const passive = def
        ? `Its passive drops while it re-levels, then comes back stronger: ` +
          `**${formatPetBonus(def.bonusType, nowPct)}** now → **${formatPetBonus(def.bonusType, thenPct)}** back at Lv.${PET_MAX_LEVEL}.`
        : '';

    // Ascending throws away 30 levels of XP, so it gets the same confirmation
    // a release does.
    const confirmId = `pet_ascend_yes:${interaction.id}`;
    const cancelId  = `pet_ascend_no:${interaction.id}`;
    const confirm = await interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(COLORS.PRIZE)
            .setTitle(`Ascend ${name}?`)
            .setDescription(
                `${getPetDisplay(pet).emoji} **${getPetDisplay(pet).titledName}** goes back to **level 1** and earns ` +
                `star ${stars} of ${ASCENSION_MAX} ${ASCENSION_STAR.repeat(stars)}.\n\n` +
                `Each star adds ${Math.round(ASCENSION_BONUS_PER_STAR * 100)}% to its passive for good. ` +
                `${passive}\n\n` +
                `Kept: name, personality, bond, training, battle record and titles. ` +
                `Lost: its level, XP and evolution stage, which it earns again.`
            )],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(confirmId).setLabel('Ascend').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(cancelId).setLabel('Not yet').setStyle(ButtonStyle.Secondary),
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
        return interaction.editReply({ content: `Ascension cancelled — **${name}** stays at level ${pet.level ?? 1}.`, embeds: [], components: [] }).catch(() => {});
    }

    if (choice.customId === cancelId) {
        return choice.update({ content: `**${name}** stays as it is.`, embeds: [], components: [] }).catch(() => {});
    }

    // Acknowledge the press before the reads and writes below, which could
    // otherwise run past Discord's three seconds; the answers that follow go
    // through editReply.
    await choice.deferUpdate().catch(() => {});

    // Re-read and re-check by id: the pet may have changed while the prompt
    // was open. Ascending is a pure function of the fresh document (no dice,
    // no coins), so a lost version race replays safely, achievements included.
    const guildSettings = await getGuildSettings(interaction.guild.id);
    let saved    = null;
    let conflict = false;
    let result   = null;
    let stopped  = null;
    let earned   = [];
    try {
        saved = await withVersionRetry(
            () => resolveUser(interaction),
            async (fresh) => {
                const still = resolvePetRef(fresh?.pets, petId);
                if (!still) { stopped = 'gone'; return false; }
                const again = canAscend(still.pet);
                if (!again.ok) { stopped = again.reason; return false; }
                result = ascendPet(fresh.pets[still.index]);
                fresh.markModified('pets');
                earned = await collectPetAchievements(fresh, guildSettings);
            },
            { label: 'pet ascend' }
        );
    } catch (err) {
        if (!isVersionError(err)) throw err;
        conflict = true;
    }

    if (conflict) {
        return choice.editReply({ content: 'Edit conflict — try again.', embeds: [], components: [] }).catch(() => {});
    }
    if (!saved) {
        const content = stopped === 'gone' || !stopped
            ? `**${name}** is no longer in your roster.`
            : refusal(stopped, name, pet);
        return choice.editReply({ content, embeds: [], components: [] }).catch(() => {});
    }
    announcePetAchievements(interaction, saved, guildSettings, earned);

    const fresh   = resolvePetRef(saved.pets, petId)?.pet;
    const shown   = fresh ? getPetDisplay(fresh) : { emoji: def?.emoji ?? '🐾', titledName: name };
    const passiveLine = def
        ? `\nPassive now **${formatPetBonus(def.bonusType, paidPct(result.toPct))}**, rising to **${formatPetBonus(def.bonusType, paidPct(result.maxPct))}** at Lv.${PET_MAX_LEVEL}.`
        : '';
    return choice.editReply({
        content: null,
        embeds: [new EmbedBuilder()
            .setColor(COLORS.PRIZE)
            .setTitle(`${ASCENSION_STAR} ${name} ascended!`)
            .setDescription(
                `${shown.emoji} **${shown.titledName}** starts again at level 1, ` +
                `with ${result.ascensions} of ${ASCENSION_MAX} stars.${passiveLine}`
            )],
        components: [],
    }).catch(() => {});
}

module.exports = { executeAscend, __test__: { refusal, nextMaxPct, paidPct } };
