'use strict';

const { EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const {
    PET_DEFINITIONS,
    STARVING_THRESHOLD,
    feedPet,
    isPetFull,
    recordPetInteraction,
    getPetDisplay,
    applyPetXp,
    resolvePetRef,
    XP_FEED_FAVORITE,
    XP_FEED_OTHER,
} = require('../../../services/petService');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { isVersionError } = require('../../../utils/versionRetry');
const { saveWithBalanceDelta } = require('../../../utils/balanceDelta');
const { questRewardPayoutKey } = require('../../../utils/payoutKey');
const { hungerBar, petArt } = require('../../../services/petStatusView');
const {
    NO_SUCH_PET, resolveUser, syncHungerAndRunaway, readSlotOption,
    isEdible, getMaterialSource, decrementMaterial,
    creditPetCare, collectPetAchievements, announcePetAchievements,
} = require('./shared');

async function executeFeed(interaction) {
    const materialId = interaction.options.getString('material');
    const petRef     = readSlotOption(interaction);

    await interaction.deferReply();

    const [user, guildSettings] = await Promise.all([resolveUser(interaction), getGuildSettings(interaction.guild.id)]);
    const sync = await syncHungerAndRunaway(user, interaction);
    if (sync?.saveError) {
        if (isVersionError(sync.saveError)) return interaction.editReply('Edit conflict — please try again.');
        throw sync.saveError;
    }

    if (!user.pets || user.pets.length === 0) return interaction.editReply('You have no pets to feed!');
    const target = resolvePetRef(user?.pets, petRef);
    if (!target) return interaction.editReply(NO_SUCH_PET);
    const petIndex = target.index;

    // Only grind materials and shop pet food are edible. Without this any
    // inventory item counted, so `/pet feed material:tier_skip_token` would
    // destroy a 50,000-coin item for 10 hunger.
    if (!isEdible(materialId)) {
        return interaction.editReply(
            `\`${materialId}\` isn't something a pet will eat. Feed a hunt/fish/mine material or \`pet_food\` — ` +
            `start typing in the **material** option to see what you have.`
        );
    }

    const { total } = getMaterialSource(user, materialId);
    if (total < 1) return interaction.editReply(`You don't have any \`${materialId}\` to feed your pet with.`);

    const pet    = user.pets[petIndex];
    const def    = PET_DEFINITIONS[pet.petId];

    // Refuse rather than consume the material for nothing. Rounded the way the
    // hunger bar rounds, so a pet shown at 100% is full here too.
    if (isPetFull(pet)) {
        const fullName = pet.name || def?.name || pet.petId;
        return interaction.editReply(`${getPetDisplay(pet).emoji} **${fullName}** is completely full — save that \`${materialId}\` for later.`);
    }

    const result = feedPet(pet, materialId);
    if (!result) return interaction.editReply('Could not feed that pet.');

    decrementMaterial(user, materialId);
    user.pets[petIndex].hunger          = result.hunger;
    user.pets[petIndex].lastFed         = new Date();
    // Decay was brought up to date by syncHungerAndRunaway above; re-anchor the
    // cursor so the restored hunger isn't immediately docked again.
    user.pets[petIndex].lastDecayAt     = new Date();
    user.pets[petIndex].starving        = result.hunger < STARVING_THRESHOLD;
    recordPetInteraction(user.pets[petIndex]);
    if (result.hunger > 0) user.pets[petIndex].starvingStartAt = null;
    const feedXp = applyPetXp(user.pets[petIndex], result.isFavorite ? XP_FEED_FAVORITE : XP_FEED_OTHER);
    user.markModified('pets');

    // A completed pet-care quest pays coins. `save()` writes `balance` as an
    // absolute `$set`, so the credit is folded out of the save and applied as its
    // own `$inc` — otherwise this write erases anything the player spent between
    // loading the document and here.
    const balanceBeforeCare = user.balance ?? 0;
    await creditPetCare(interaction, user, guildSettings);
    const earned = await collectPetAchievements(user, guildSettings);

    try {
        await saveWithBalanceDelta(User, user, balanceBeforeCare, {
            service: 'pet',
            jobName: 'feedQuestReward',
            guildId: interaction.guild.id,
            // Keyed (#873, pass 11): a pet-care quest completing here pays coins
            // exactly once and records a replayable owed payload on failure.
            payoutKey: questRewardPayoutKey('pet', interaction.id),
        });
    } catch (err) {
        if (isVersionError(err)) return interaction.editReply('Edit conflict — please try again.');
        throw err;
    }
    announcePetAchievements(interaction, user, guildSettings, earned);

    const displayName  = pet.name || def?.name || pet.petId;
    // Say what actually landed: a favourite fed at 95% restores 5, not 25.
    const favoriteNote = result.isFavorite
        ? ` *(favorite food — +${result.gained} hunger!)*`
        : ` *(not favorite — +${result.gained} hunger)*`;
    const progressNote = feedXp.evolved
        ? `\n🌟 **${displayName} evolved!** Say hello to **${getPetDisplay(user.pets[petIndex]).titledName}** (Stage ${feedXp.toStage})!`
        : feedXp.leveledUp
        ? `\n🎉 **${displayName} reached Level ${feedXp.toLevel}!**`
        : '';

    const embed = new EmbedBuilder()
        .setColor(result.hunger >= STARVING_THRESHOLD ? '#4caf50' : '#ff5722')
        .setTitle(`${getPetDisplay(user.pets[petIndex]).emoji} ${displayName} fed!`)
        .setDescription(`✨ **+${feedXp.gained} pet XP**${progressNote}`)
        .addFields(
            { name: 'Food',   value: `\`${materialId}\`${favoriteNote}`,   inline: true  },
            { name: 'Hunger', value: hungerBar(result.hunger),              inline: false },
            { name: 'Bonus',  value: result.hunger >= STARVING_THRESHOLD ? '✅ Active' : `❌ Still inactive (need ≥ ${STARVING_THRESHOLD}%)`, inline: true },
        )
        .setTimestamp();

    const art = await petArt(pet.petId, interaction.guild.id, displayName);
    if (art) embed.setThumbnail(art.url);
    return interaction.editReply({ embeds: [embed], files: art ? [art.attachment] : [] });
}

module.exports = { executeFeed };
