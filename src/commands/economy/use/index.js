'use strict';

// `/use` — the command definition, the item picker, and the routing to the file
// that handles each kind of item.
//
// This was one file until it neared the 900-line command-file cap
// (eslint-rules/command-file-size.js). It is split the way /market was (#1124):
// `status.js` answers what /use would do with an item without touching
// anything, and each family of item has its own handler beside it. The loader
// treats <category>/<name>/index.js as the command, so the siblings never
// register as commands of their own.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User  = require('../../../models/User');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { resolveEffectType } = require('../../../services/effectsService');
const { describeItem } = require('../../../utils/itemDisplay');
const { loadAiItems } = require('../../../utils/aiItemLookup');
const { resolveTiers } = require('../../../utils/jobTiers');
const { matchesName, rankByName } = require('../../../utils/pickerRank');
const COLORS = require('../../../utils/embedColors');
const { LOOT_BOX_EVENTS, useStatus } = require('./status');
const { useEffect } = require('./effects');
const { useBlackMarketContract, usePermanentStamina, usePetSlotExpansion, useStreakFreeze } = require('./caps');
const { useReviveScroll } = require('./revive');
const { useCareerBadge, useMasterKey } = require('./workFinds');
const { useLootBox } = require('./lootBoxes');
const { useShopItem } = require('./redeem');

// The items with a handler of their own, by lowercased id.
const SPECIAL_ITEMS = {
    streak_freeze:         useStreakFreeze,
    black_market_contract: useBlackMarketContract,
    permanent_stamina:     usePermanentStamina,
    pet_slot_expansion:    usePetSlotExpansion,
    revive_scroll:         useReviveScroll,
    master_key:            useMasterKey,
    career_badge:          useCareerBadge,
};

/** `🍀 Lucky Charm — 3 held · lasts 2h`, clipped to Discord's 100. */
function toChoice({ item, quantity, status }) {
    return {
        name: `${item.emoji} ${item.name} — ${quantity} held${status.status ? ` · ${status.status}` : ''}`.slice(0, 100),
        value: item.itemId.slice(0, 100),
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('use')
        .setDescription('Use an item from your inventory')
        .addStringOption(o =>
            o.setName('item')
                .setDescription('Name of the item to use (see /inventory for your items).')
                .setRequired(true)
                .setAutocomplete(true)),

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused()?.toLowerCase() ?? '';
            const [user, guildSettings] = await Promise.all([
                User.findOne(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    'inventory activeEffects streak crimeContractStacks staminaUpgrades petSlots deceasedPets shiftsWorked'
                ).lean(),
                getGuildSettings(interaction.guild.id),
            ]);
            const shopItems = guildSettings?.shop ?? [];
            // The member is on the autocomplete interaction; if its roles are not
            // there, say "no" and let execute do the authoritative check.
            const hasRole = roleId => Boolean(interaction.member?.roles?.cache?.has?.(roleId));

            // Only what /use can actually do something with. Pet food, relics,
            // forged items and event keepsakes live in the same bag but belong
            // to other commands, and offering them here was an invitation to
            // throw them away.
            const items = (user?.inventory ?? [])
                .filter(e => e.quantity > 0)
                .map(e => {
                    const item = describeItem(e.itemId, { shopItems });
                    return {
                        name: item.name,
                        itemId: item.itemId,
                        item,
                        quantity: e.quantity,
                        status: useStatus(e.itemId, user, { shopItems, hasRole, tiers: resolveTiers(guildSettings) }),
                    };
                })
                .filter(c => c.status.usable);

            // Ready to use first, blocked ones (already running, maxed) after;
            // within each, prefix matches ahead of substring ones, then A–Z.
            // Matched on the display name and the raw id, like /gift.
            const ranked = rankByName(items.filter(c => matchesName(c, focused)), focused, { first: c => c.status.ready });

            await interaction.respond(ranked.slice(0, 25).map(toChoice));
        } catch (err) {
            console.error('[use] autocomplete error:', err);
            await interaction.respond([]).catch(() => {});
        }
    },

    async execute(interaction) {
        const itemName = interaction.options.getString('item').trim();
        const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

        /**
         * Drop inventory slots the decrement above emptied.
         *
         * Not `user.inventory = filter(...)` followed by `save()`: save() writes
         * each modified path as a `$set`, and `inventory` is an array, so that
         * writes the whole list back from a snapshot taken a moment earlier —
         * erasing anything bought, gifted or dropped into the bag in between.
         * `$pull` removes exactly the emptied entries and leaves the rest alone.
         * (`balance` is never at risk here; save() only writes paths that were
         * actually touched.)
         */
        const dropEmptyInventorySlots = () => User.updateOne(
            userFilter,
            { $pull: { inventory: { quantity: { $lte: 0 } } } },
        ).catch(err => console.error('[use] inventory cleanup failed:', err));

        // Read first to resolve item identity (itemId casing, effect checks)
        const [preview, guildSettings] = await Promise.all([
            User.findOne(userFilter),
            getGuildSettings(interaction.guild.id)
        ]);

        if (!preview || !preview.inventory?.length) {
            return interaction.reply({ content: "Your inventory is empty. Buy items with `/shop buy`.", flags: MessageFlags.Ephemeral });
        }

        const shopItems = guildSettings?.shop ?? [];
        const typed     = itemName.toLowerCase();

        // The id first (what autocomplete submits), then the display name, so a
        // player who types "Lucky Charm" by hand still gets their lucky_charm.
        const held = preview.inventory.filter(e => e.quantity > 0);
        const invEntry = held.find(e => e.itemId.toLowerCase() === typed)
            ?? held.find(e => describeItem(e.itemId, { shopItems }).name.toLowerCase() === typed)
            ?? preview.inventory.find(e => e.itemId.toLowerCase() === typed);
        if (!invEntry || invEntry.quantity < 1) {
            return interaction.reply({
                content: `You don't have **${itemName}** in your inventory. Start typing in the \`item\` box to pick from what you're holding.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        const canonicalId = invEntry.itemId; // preserve original casing for DB match
        const item        = describeItem(canonicalId, { shopItems });

        // ── Items /use has nothing to do with ────────────────────────────────
        // Refused before anything is written. The generic shop-item branch
        // (redeem.js) used to swallow these — a relic, a forged item or a bag of pet food
        // would be "used" into nothing.
        // No settings (a guild that never saved any) means no custom shop, so
        // an unknown item there is refused like any other. A settings read that
        // fails throws out of the Promise.all above, before anything is spent.
        const tiers  = resolveTiers(guildSettings);
        const status = useStatus(canonicalId, preview, { shopItems, tiers });
        if (!status.usable) {
            let shown = item;
            if (item.kind === 'forged') {
                const aiItems = await loadAiItems([canonicalId]);
                shown = describeItem(canonicalId, { shopItems, aiItem: aiItems[canonicalId] });
            }
            const embed = new EmbedBuilder()
                .setColor(shown.color ?? COLORS.NEUTRAL)
                .setTitle(`${shown.emoji} ${shown.name} can't be used`)
                .setDescription(`${status.redirect}\n\nNothing was consumed.`);
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        const ctx = {
            interaction, userFilter, preview, canonicalId, item, itemName, shopItems, tiers,
            dropEmptyInventorySlots,
        };

        const effectType = resolveEffectType(canonicalId);
        if (effectType) return useEffect(ctx, effectType);

        const special = SPECIAL_ITEMS[canonicalId.toLowerCase()];
        if (special) return special(ctx);

        const lootBoxEvent = LOOT_BOX_EVENTS.get(canonicalId.toLowerCase());
        if (lootBoxEvent) return useLootBox(ctx, lootBoxEvent);

        // What is left is one of the guild's own shop items.
        return useShopItem(ctx);
    }
};

module.exports.__test__ = { useStatus };
