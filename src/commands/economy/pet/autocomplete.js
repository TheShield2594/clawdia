'use strict';

// /pet autocomplete: the pet-slot picker and the food picker.

const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { PET_DEFINITIONS, resolvePetRef } = require('../../../services/petService');
const { MATERIAL_RARITY } = require('../../../data/materialRarity');
const { MATERIAL_SYSTEMS, isEdible, readSlotOption, petChoiceLabel } = require('./shared');

/** Pets the player currently owns, keyed by their stable _id. */
async function slotAutocomplete(interaction, focused) {
    const user = await User.findOne(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        'pets'
    );
    const pets  = user?.pets ?? [];
    const query = focused.toLowerCase();

    const choices = pets
        .map(pet => ({ name: petChoiceLabel(pet), value: String(pet._id) }))
        .filter(c => !query || c.name.toLowerCase().includes(query));

    return interaction.respond(choices.slice(0, 25));
}

/**
 * Materials the player actually holds and could plausibly feed a pet, with the
 * selected pet's favourite pinned to the top. Without this the option required
 * typing exact snake_case ids like `rabbits_foot` from memory.
 */
async function materialAutocomplete(interaction, focused) {
    // Read-only and projected: resolveUser() upserts, and Discord fires an
    // autocomplete event per keystroke with a 3s budget.
    const found = await User.findOne(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        'pets inventory guildId userId'
    );
    if (!found) return interaction.respond([]);
    const user = await attachGrind(found);

    // The slot option may already be filled in; if so, favour that pet's food.
    const selected  = resolvePetRef(user?.pets, readSlotOption(interaction));
    const favourite = selected ? PET_DEFINITIONS[selected.pet.petId]?.favoriteMaterial : null;

    const held = new Map(); // materialId -> quantity
    const add  = (id, qty) => {
        if (!id || !(qty > 0)) return;
        held.set(id, (held.get(id) ?? 0) + qty);
    };
    for (const system of MATERIAL_SYSTEMS) {
        for (const [id, qty] of Object.entries(user?.[system]?.materials ?? {})) add(id, qty);
    }
    for (const entry of user?.inventory ?? []) add(entry.itemId, entry.quantity);

    const query = focused.toLowerCase();
    const choices = [...held.entries()]
        // Grind materials plus shop-bought pet food — not every stray inventory item.
        .filter(([id]) => isEdible(id))
        .filter(([id]) => !query || id.toLowerCase().includes(query))
        .map(([id, qty]) => {
            const meta  = MATERIAL_RARITY[id];
            const label = meta?.label ?? (id === 'pet_food' ? 'Pet Food' : id);
            const isFav = id === favourite;
            return {
                id, qty, isFav,
                name: `${meta?.emoji ?? '🍖'} ${label} — ${qty}x${isFav ? ' ⭐ favourite (+25)' : ' (+10)'}`.slice(0, 100),
            };
        })
        .sort((a, b) => (b.isFav - a.isFav) || (b.qty - a.qty) || a.name.localeCompare(b.name))
        .slice(0, 25)
        .map(c => ({ name: c.name, value: c.id }));

    return interaction.respond(choices);
}

async function petAutocomplete(interaction) {
    try {
        const focused = interaction.options.getFocused(true);
        if (focused.name === 'slot')     return await slotAutocomplete(interaction, focused.value ?? '');
        if (focused.name === 'material') return await materialAutocomplete(interaction, focused.value ?? '');
        return await interaction.respond([]);
    } catch (err) {
        console.error('[pet] autocomplete error:', err);
        return interaction.respond([]).catch(() => {});
    }
}

module.exports = { petAutocomplete, slotAutocomplete, materialAutocomplete };
