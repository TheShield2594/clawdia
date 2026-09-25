'use strict';

// `/use revive_scroll` — bringing back the most recent pet that starved.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const { PET_DEFINITIONS, petCapacity, hasFreePetSlot, countSlotPets, joinVacation } = require('../../../services/petService');
const { leftField } = require('./status');

/** Revives `deceasedPets[0]` with its level, record and remaining bond, or says why not. */
async function useReviveScroll({ interaction, userFilter, preview, canonicalId, dropEmptyInventorySlots }) {
    const fallen = preview.deceasedPets?.[0];
    if (!fallen) {
        return interaction.reply({
            content: '📜 The scroll finds no one to call back — none of your pets have run away. Keep it for a rainier day.',
            flags: MessageFlags.Ephemeral,
        });
    }
    if ((preview.pets ?? []).some(p => p.petId === fallen.petId)) {
        const def = PET_DEFINITIONS[fallen.petId];
        return interaction.reply({
            content: `📜 You already have another ${def?.emoji ?? '🐾'} **${def?.name ?? fallen.petId}**, and the scroll won't make a second. Release it first if you want this one back.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    // Same capacity rule /pet adopt enforces — otherwise a player whose pet
    // starved, who then adopted a replacement, could revive above capacity.
    // Rare companions are exempt from slots, so they are exempt here too.
    if (PET_DEFINITIONS[fallen.petId]?.purchasable && !hasFreePetSlot(preview)) {
        return interaction.reply({
            content: `📜 No free pet slot (${countSlotPets(preview.pets)} / ${petCapacity(preview)}). `
                   + `Release a pet or buy a **Pet Slot Expansion** before using this.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const now = new Date();
    const revived = {
        ...(fallen.toObject ? fallen.toObject() : fallen),
        // Comes back weak but alive: level, XP and record are preserved, and the
        // bond it kept after the runaway penalty; the starvation state is not.
        hunger: 50,
        lastFed: now,
        lastDecayAt: now,
        starving: false,
        starvingStartAt: null,
        // A fresh start for the hunger DMs and no leftover vacation (#1181).
        hungerWarnedLow: false,
        hungerWarnedEmpty: false,
        vacationFrom: null,
        vacationUntil: null,
    };
    delete revived._id;
    delete revived.diedAt;
    // Coming home mid-vacation, it joins the others rather than being the one
    // active pet while they are away.
    joinVacation(preview, revived, now.getTime());

    // Consume the scroll, remove the record and bring the pet back in one
    // conditional write, so a double-click can't revive the same pet twice
    // and no failure can land between the three (#873, pass 14). The pet
    // used to be pushed onto the loaded document and save()d after the
    // scroll and the record were already gone: a save that failed lost the
    // pet for good, and one that landed wrote the whole `pets` array back
    // from its snapshot over any feed, battle or adoption in between. The
    // `$ne` re-asserts the "no second copy" check above inside the write.
    const user = await User.findOneAndUpdate(
        {
            ...userFilter,
            inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } },
            'deceasedPets._id': fallen._id,
            'pets.petId': { $ne: fallen.petId },
        },
        // arrayFilters rather than the positional `$`: the query touches
        // several arrays here, which makes `$` ambiguous about which one
        // it indexes.
        {
            $inc:  { 'inventory.$[inv].quantity': -1 },
            $pull: { deceasedPets: { _id: fallen._id } },
            $push: { pets: revived },
        },
        { new: true, arrayFilters: [{ 'inv.itemId': canonicalId, 'inv.quantity': { $gt: 0 } }] }
    );
    if (!user) {
        return interaction.reply({ content: "Couldn't use the scroll — try again.", flags: MessageFlags.Ephemeral });
    }

    user.inventory = user.inventory.filter(e => e.quantity > 0);
    await dropEmptyInventorySlots();

    const def  = PET_DEFINITIONS[fallen.petId];
    const name = fallen.name || def?.name || fallen.petId;
    const embed = new EmbedBuilder()
        .setColor('#f1c40f')
        .setTitle(`📜 ${name} Returns!`)
        .setDescription(
            `${def?.emoji ?? '🐾'} **${name}** is back at your side, weak but whole.\n\n` +
            `They kept everything: **Level ${fallen.level ?? 1}**, ` +
            `**${fallen.battleWins ?? 0}W / ${fallen.battleLosses ?? 0}L** — though running off cost some of your bond.`
        )
        .addFields(
            { name: '🍖 Hunger', value: '50% — feed them soon', inline: true },
            leftField(user, canonicalId),
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

module.exports = { useReviveScroll };
