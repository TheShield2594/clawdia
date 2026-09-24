'use strict';

/**
 * The `use` picker and result pieces `/hunt shop use`, `/fish shop use` and
 * `/mine shop use` share (#1134), on the model of `/use`'s (#1124).
 *
 * Each shop describes itself with a spec:
 *
 *   key                the grind subdocument on the user (`hunt`, `fishing`, `mining`)
 *   label              for log lines
 *   activatable        the consumable ids `use` accepts, in no particular order
 *   defOf(id)          the consumable's definition ({ name, emoji, … })
 *   ensure(user)       the service's ensure*Data, seeding a new player's profile
 *   applyStaminaRegen  the service's, so a tonic's status reads the real bar
 *   consumableStatus   the service's: { ready, status } for one consumable
 */

const User = require('../models/User');
const { attachGrind } = require('./grindProfile');
const { matchesName, rankByName } = require('./pickerRank');

/** How many of `itemId` the player's grind bag holds. */
const heldCount = (user, spec, itemId) => Math.max(0, user[spec.key]?.consumables?.[itemId] ?? 0);

/** `🍀 Luck Charm — 2 held · lasts 5 hunts`, clipped to Discord's 100. */
function toChoice(row) {
    return {
        name: `${row.emoji} ${row.name} — ${row.quantity} held${row.status ? ` · ${row.status}` : ''}`.slice(0, 100),
        value: row.itemId.slice(0, 100),
    };
}

/**
 * The picker's rows for a user whose grind profiles are attached: held
 * consumables only, ready ones first, then prefix matches, then A–Z.
 * `typed` is expected lowercased.
 */
function consumableRows(user, spec, typed) {
    const rows = spec.activatable
        .map(itemId => ({ itemId, def: spec.defOf(itemId), quantity: heldCount(user, spec, itemId) }))
        .filter(r => r.def && r.quantity > 0)
        .map(r => ({
            itemId: r.itemId,
            name: r.def.name,
            emoji: r.def.emoji ?? '📦',
            quantity: r.quantity,
            ...spec.consumableStatus(user, r.itemId),
        }));
    return rankByName(rows.filter(r => matchesName(r, typed)), typed, { first: r => r.ready });
}

/**
 * Answers the `item` autocomplete of a grind shop's `use`.
 *
 * The user document is loaded and prepared the way the shop's own execute
 * does it, and never saved: the stamina regen applied here only makes the
 * status current. A failure answers with no suggestions rather than an error.
 */
async function respondWithConsumables(interaction, spec) {
    try {
        const typed = interaction.options.getFocused()?.toLowerCase() ?? '';
        const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!user) return await interaction.respond([]);
        await attachGrind(user);
        spec.ensure(user);
        spec.applyStaminaRegen(user);
        return await interaction.respond(consumableRows(user, spec, typed).slice(0, 25).map(toChoice));
    } catch (err) {
        console.error(`[${spec.label}] use autocomplete error:`, err);
        await interaction.respond([]).catch(() => {});
    }
}

/**
 * The consumable id a submitted `item` value names: the id first (what the
 * picker submits), then the display name, so a player who types
 * "Luck Charm" by hand still gets their luck_charm. Anything else is passed
 * through for the service to refuse.
 */
function resolveConsumableId(value, spec) {
    const typed = String(value ?? '').trim();
    const lower = typed.toLowerCase();
    return spec.activatable.find(id => id.toLowerCase() === lower)
        ?? spec.activatable.find(id => spec.defOf(id)?.name.toLowerCase() === lower)
        ?? typed;
}

/** The result embed's `🎒 Left in bag` field, as `/use` shows it. */
function leftInBagField(user, spec, itemId) {
    return { name: '🎒 Left in bag', value: `${heldCount(user, spec, itemId)}x`, inline: true };
}

module.exports = { consumableRows, leftInBagField, resolveConsumableId, respondWithConsumables };
