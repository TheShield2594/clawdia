'use strict';

// Shared helpers for the /pet command tree — the reads, mutations and
// quest/achievement plumbing more than one subcommand needs. Everything about a
// single subcommand's buttons and embeds lives in that subcommand's file; this
// is only what they have in common.

const { MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const { DECEASED_PET_LIMIT } = User;
const { attachGrind } = require('../../../utils/grindProfile');
const {
    PET_DEFINITIONS,
    STARVING_THRESHOLD,
    applyHungerDecay,
    effectiveHunger,
    checkRunaway,
    bondAfterRunaway,
} = require('../../../services/petService');
const { MATERIAL_RARITY } = require('../../../data/materialRarity');
const { onPetCare, notifyQuestComplete } = require('../../../services/questService');
const { checkAndAward, announceAchievements } = require('../../../services/achievementService');

const NO_SUCH_PET = "Couldn't find that pet — pick one from the list `/pet status` shows, or start typing to choose from your pets.";

// Every grind system that keeps a material pile, in the order feeding draws
// from them. `exploration` joined the list with the fieldcraft materials the
// Lantern Owl eats (#753) — a favourite food nothing could hold is the reason
// exploration had no companion for so long.
const MATERIAL_SYSTEMS = ['hunt', 'fishing', 'mining', 'exploration'];

// What a pet will actually eat: any known grind material, plus shop pet food.
function isEdible(materialId) {
    return Boolean(MATERIAL_RARITY[materialId]) || materialId === 'pet_food';
}

function getInventoryQuantity(user, itemId) {
    return user.inventory?.find(i => i.itemId === itemId)?.quantity ?? 0;
}

/** How much of one material the player holds, per pile and in total. */
function getMaterialSource(user, materialId) {
    const bySystem = Object.fromEntries(
        MATERIAL_SYSTEMS.map(system => [system, user[system]?.materials?.[materialId] ?? 0])
    );
    const invMat = getInventoryQuantity(user, materialId);
    return {
        ...bySystem,
        invMat,
        total: Object.values(bySystem).reduce((sum, qty) => sum + qty, 0) + invMat,
    };
}

function decrementMaterial(user, materialId) {
    for (const system of MATERIAL_SYSTEMS) {
        if ((user[system]?.materials?.[materialId] ?? 0) > 0) {
            user[system].materials[materialId]--;
            user.markModified(`${system}.materials`);
            return true;
        }
    }
    const slot = user.inventory?.find(i => i.itemId === materialId);
    if (slot && slot.quantity > 0) {
        slot.quantity--;
        if (slot.quantity <= 0) user.inventory = user.inventory.filter(i => i !== slot);
        user.markModified('inventory');
        return true;
    }
    return false;
}

/**
 * Read the `slot` option without asserting its type.
 *
 * It changed from an integer to an autocompleted string; global command updates
 * take a while to reach every client, so during that window a stale client can
 * still send an integer — which getString() would throw on. resolvePetRef()
 * accepts both forms, so normalise to a string here and let it decide.
 */
function readSlotOption(interaction) {
    const raw = interaction.options.get('slot');
    return raw?.value == null ? null : String(raw.value);
}

/** Short label for a pet in an autocomplete list. Discord caps choice names at 100. */
function petChoiceLabel(pet) {
    const def    = PET_DEFINITIONS[pet.petId];
    const name   = pet.name || def?.name || pet.petId;
    const hunger = Math.round(effectiveHunger(pet));
    const fed    = hunger >= STARVING_THRESHOLD ? '' : ' · hungry!';
    return `${name} — ${def?.name ?? pet.petId} Lv${pet.level ?? 1} · ${hunger}% fed${fed}`.slice(0, 100);
}

/** Advance pet-care quest progress and surface any completions. */
async function creditPetCare(interaction, user, guildSettings) {
    const { completed } = await onPetCare(user, guildSettings).catch(err => {
        console.error('[pet] quest progress failed:', err);
        return { completed: [] };
    });
    if (completed.length) {
        notifyQuestComplete(guildSettings, interaction.member, completed, interaction.channel, user).catch(() => {});
    }
}

/**
 * Evaluate achievements against the freshly mutated user. Pet achievements would
 * otherwise only fire the next time the player happened to hunt, fish or mine,
 * since those were the only commands running this check.
 *
 * Call before saving so one write persists the pet change and the unlock.
 */
function collectPetAchievements(user, guildSettings) {
    return checkAndAward(user, guildSettings).catch(err => {
        console.error('[pet] achievement check failed:', err);
        return [];
    });
}

function announcePetAchievements(interaction, user, guildSettings, earned) {
    if (!earned?.length) return;
    announceAchievements(interaction.client, guildSettings, user, interaction.member, earned).catch(() => {});
}

async function resolveUser(interaction) {
    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    // Feeding consumes hunt/fish/mine materials, which live on GrindProfile now
    return attachGrind(user);
}

/**
 * Applies hunger decay and moves any pet that starved to the memorial, saving
 * and announcing the deaths.
 * @returns {Promise<{saveError: Error}|undefined>} `saveError` when a death could
 *   not be saved — nothing was announced, and the caller answers the error.
 */
async function syncHungerAndRunaway(user, interaction) {
    if (!user.pets || user.pets.length === 0) return;

    // Write the accrued decay back onto the live subdocuments, then evaluate
    // runaways against those updated values.
    const decayed = applyHungerDecay(user.pets);
    for (let i = 0; i < user.pets.length; i++) {
        const d = decayed[i];
        if (!d || d === user.pets[i]) continue; // no time elapsed for this pet
        user.pets[i].hunger          = d.hunger;
        user.pets[i].lastDecayAt     = d.lastDecayAt;
        user.pets[i].starving        = d.starving;
        user.pets[i].starvingStartAt = d.starvingStartAt ?? null;
        user.pets[i].bond            = d.bond;
    }

    const { ranAwayPets } = checkRunaway(user.pets);
    for (const gone of ranAwayPets) {
        // Keep a record so a Revive Scroll can bring the pet back with its
        // level and battle record intact.
        const snapshot = gone.toObject ? gone.toObject() : { ...gone };
        delete snapshot._id;
        // Running off costs trust the scroll does not give back (#1186).
        snapshot.bond = bondAfterRunaway(gone);
        user.deceasedPets.unshift({ ...snapshot, diedAt: new Date() });
        if (gone._id) user.pets.pull(gone._id);
    }
    if (ranAwayPets.length > 0) {
        user.deceasedPets = user.deceasedPets.slice(0, DECEASED_PET_LIMIT);
        user.markModified('deceasedPets');
    }
    user.markModified('pets');

    if (ranAwayPets.length > 0) {
        // Store the death before announcing it. Callers used to save after
        // their own checks, and every early return skipped that save — so
        // `/pet feed` on a starved pet announced it, returned "You have no pets
        // to feed!", and announced it again on every run after (#873). A save
        // that fails announces nothing: the death is found again and announced
        // once on the next command. The error goes back to the caller, which
        // answers it the way it answers its own save failures (an edit
        // conflict, or a generic apology).
        try {
            await user.save();
        } catch (err) {
            return { saveError: err };
        }

        const names = ranAwayPets.map(p => {
            const def = PET_DEFINITIONS[p.petId];
            return `${def?.emoji ?? '🐾'} **${p.name || def?.name || p.petId}**`;
        });
        // Worded as running away, which is what the code has always modelled
        // (checkRunaway, RUNAWAY_DAYS) and what a Revive Scroll can undo. The
        // player-facing text used to say the pet died, which was both harsher
        // than the bot's tone and at odds with the scroll that brings it back.
        const deathMsg = ranAwayPets.length === 1
            ? `💨 **${interaction.user.username}**'s pet ${names[0]} got too hungry and ran off in search of food...`
            : `💨 **${interaction.user.username}**'s pets ${names.join(', ')} got too hungry and ran off in search of food...`;
        // No pings: pet names are player-chosen, and ones saved before names
        // were sanitised can still hold a mention.
        interaction.channel?.send({ content: deathMsg, allowedMentions: { parse: [] } }).catch(() => {});
        // followUp only works once the interaction has been answered. /pet battle
        // syncs before it replies, so on that path the public channel message
        // above is the only notice the owner gets — which is why it names them.
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
                content: `💔 After days without food, ${names.join(', ')} ran away.\n*A Revive Scroll from \`/shop\` calls ${ranAwayPets.length > 1 ? 'one of them' : 'them'} home with level and record intact — or \`/pet adopt\` a new companion.*`,
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }
    }
}

module.exports = {
    NO_SUCH_PET,
    MATERIAL_SYSTEMS,
    isEdible,
    getInventoryQuantity,
    getMaterialSource,
    decrementMaterial,
    readSlotOption,
    petChoiceLabel,
    creditPetCare,
    collectPetAchievements,
    announcePetAchievements,
    resolveUser,
    syncHungerAndRunaway,
};
