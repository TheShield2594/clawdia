const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const {
    EFFECT_CONFIGS,
    resolveEffectType,
    activateEffect,
    hasEffect,
    timeRemaining,
    isActiveEffect,
} = require('../../services/effectsService');
const { DEFAULT_SHOP_ITEMS } = require('../../data/defaultShopItems');
const { getRelicMeta } = require('../../data/exploreData');
const { describeItem, findShopRow, findDefaultRow } = require('../../utils/itemDisplay');
const { withUserLock } = require('../../utils/userMutex');
const { loadAiItems } = require('../../utils/aiItemLookup');
const { grantItemsOrOwe } = require('../../utils/creditOrOwe');
const { lootBoxItemPayoutKey, useRoleRefundPayoutKey } = require('../../utils/payoutKey');
const { SEASONAL_EVENTS, RARITY_COLORS, rollLootBox } = require('../../data/seasonalEvents');
const { PET_DEFINITIONS, MAX_SLOT_EXPANSIONS, petCapacity, hasFreePetSlot, countSlotPets } = require('../../services/petService');
const { MAX_STAMINA_UPGRADES } = require('../../data/crossSystemData');
const COLORS = require('../../utils/embedColors');

// itemId of a seasonal loot box -> the event definition that owns it
const LOOT_BOX_EVENTS = new Map(
    Object.values(SEASONAL_EVENTS)
        .filter(ev => ev.lootBox)
        .map(ev => [ev.lootBox.itemId.toLowerCase(), ev])
);

// itemId of anything a seasonal loot box can roll -> the event it came from.
// These are keepsakes: they sit in the bag, count toward /showcase and trade on
// /market. The one exception is an item that is *also* an effect item (a loot
// box can roll a booster), which the effect lookup reaches first.
const EVENT_COLLECTIBLES = new Map(
    Object.values(SEASONAL_EVENTS)
        .flatMap(ev => (ev.lootBox?.items ?? []).map(item => [item.itemId.toLowerCase(), ev]))
);

const DEFAULT_ITEM_IDS = new Set(DEFAULT_SHOP_ITEMS.map(s => s.itemId.toLowerCase()));

const MAX_FREEZES         = 2;
const MAX_CONTRACT_STACKS = 3;

// Built-in items that are spent by another command. /use used to fall through
// to the generic branch for these and quietly delete them.
const USED_ELSEWHERE = {
    pet_food:        'Feed it to a pet with `/pet feed`.',
    tier_skip_token: 'Spend it on the season pass with `/season tier-skip`.',
};

/** `7_200_000` → `2h`, `1_800_000` → `30m`. */
function formatDuration(ms) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return [h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m';
}

/** Discord's relative timestamp — renders as "in 2 hours" and keeps ticking. */
const relativeTime = date => `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;

/**
 * The running effect of `type`, if any. Unlike `hasEffect` this never prunes
 * (and so never mutates) the user — autocomplete reads a lean document — but it
 * asks effectsService what "active" means, so the two cannot disagree.
 */
function runningEffect(user, type) {
    const now = Date.now();
    return (user?.activeEffects ?? []).find(e => e.type === type && isActiveEffect(e, now));
}

/** How a running effect reads in a one-line status. */
function runningLabel(effect) {
    if (effect.expiresAt) return `active · ${timeRemaining(effect.expiresAt)} left`;
    if (effect.charges > 1) return `armed · ${effect.charges} charges left`;
    return 'armed';
}

/** The catalogue description with its leading emoji stripped, for an embed body. */
function describeEffect(itemId, shopItems) {
    const row = findShopRow(itemId, shopItems) ?? findDefaultRow(itemId);
    return (row?.description ?? '')
        .replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\uFE0F|\u200D)+\s*/u, '')
        .trim();
}

/**
 * What `/use` would do with one inventory item, right now.
 *
 * One answer shared by the autocomplete and `execute`, so the dropdown never
 * offers something the command then refuses for a reason it could have shown:
 *
 *   usable   false  → /use has nothing to do with it; `redirect` says what does.
 *                     These are left out of the dropdown and refused on submit
 *                     without consuming anything.
 *   ready    false  → it is a /use item but is blocked for now (the effect is
 *                     already running, a cap is reached, nobody to revive).
 *                     Still offered, with `status` saying why, sorted last.
 *   status          → the short tag the dropdown shows after the quantity.
 *
 * Only the guild's own shop items fall through to the generic "redeem" path.
 * Anything else nothing recognises — a /work find, a drop from a system that
 * never got a handler — is refused rather than consumed for nothing.
 *
 * `hasRole(roleId)` answers whether the member already holds a role, when the
 * caller can tell; a role item they already have is blocked, not spent.
 */
function useStatus(itemId, user, { shopItems = [], hasRole = () => false } = {}) {
    const lower = itemId.toLowerCase();

    const effectType = resolveEffectType(itemId);
    if (effectType) {
        const cfg = EFFECT_CONFIGS[effectType];
        const running = runningEffect(user, effectType);
        if (running) return { usable: true, ready: false, status: runningLabel(running) };
        if (cfg.durationMs) return { usable: true, ready: true, status: `lasts ${formatDuration(cfg.durationMs)}` };
        return {
            usable: true, ready: true,
            status: cfg.charges > 1 ? `arms ${cfg.charges} charges` : 'arms for the next trigger',
        };
    }

    const capped = (have, max, noun) => ({ usable: true, ready: have < max, status: have < max ? `${have}/${max} ${noun}` : `maxed · ${max}/${max} ${noun}` });
    switch (lower) {
        case 'streak_freeze':         return capped(user?.streak?.freezes ?? 0, MAX_FREEZES, 'banked');
        case 'black_market_contract': return capped(user?.crimeContractStacks ?? 0, MAX_CONTRACT_STACKS, 'stacks');
        case 'permanent_stamina':     return capped(user?.staminaUpgrades ?? 0, MAX_STAMINA_UPGRADES, 'upgrades');
        case 'pet_slot_expansion':    return capped(user?.petSlots ?? 0, MAX_SLOT_EXPANSIONS, 'expansions');
        case 'revive_scroll': {
            const fallen = user?.deceasedPets?.[0];
            if (!fallen) return { usable: true, ready: false, status: 'no fallen pet to revive' };
            const name = fallen.name || PET_DEFINITIONS[fallen.petId]?.name || fallen.petId;
            return { usable: true, ready: true, status: `revives ${name}` };
        }
    }

    if (LOOT_BOX_EVENTS.has(lower)) return { usable: true, ready: true, status: 'open it' };

    if (USED_ELSEWHERE[lower]) return { usable: false, redirect: USED_ELSEWHERE[lower] };

    if (getRelicMeta(itemId)) {
        return { usable: false, redirect: "It's a relic from `/explore` — a collectible, not a consumable. Admire it in `/explore relics`, or sell it to another player with `/market list`." };
    }
    if (lower.startsWith('ai_')) {
        return { usable: false, redirect: "It's a forged collectible — there's nothing to activate, but it counts toward your `/showcase`, and you can sell it to another player with `/market list` or hand it over with `/gift`." };
    }
    const event = EVENT_COLLECTIBLES.get(lower);
    if (event) {
        return { usable: false, redirect: `It's a ${event.emoji} ${event.name} keepsake — a collectible for your \`/showcase\` or the \`/market\`, not a consumable.` };
    }

    const shopItem = findShopRow(itemId, shopItems);
    if (shopItem?.roleId) {
        return hasRole(shopItem.roleId)
            ? { usable: true, ready: false, status: 'you already have the role' }
            : { usable: true, ready: true, status: 'grants a role' };
    }

    // A built-in item with no handler above (badges, frames, titles…) does its
    // job by being owned. Spending it would only throw it away.
    if (DEFAULT_ITEM_IDS.has(lower)) {
        return { usable: false, redirect: 'It works just by being in your bag — there is nothing to activate, and using it would only throw it away.' };
    }

    // A custom item the server's admins sell: theirs to define, so /use redeems it.
    if (shopItem) return { usable: true, ready: true, status: 'redeem' };

    // Either nothing in the game ever activated it (a /work find), or it was a
    // server shop item whose row has since been removed. Both are refused rather
    // than consumed; the wording covers both without claiming to know which.
    return {
        usable: false, unknown: true,
        redirect: "Nothing in the game or this server's shop uses it (any more), so there's nothing to activate. "
            + 'Keep it, hand it over with `/gift`, or sell it with `/market list`. '
            + "If it was a server shop item that's since been removed, ask an admin.",
    };
}

/** How many of an item are left after a use, from the post-update document. */
const leftInBag = (user, itemId) => Math.max(0, user.inventory.find(e => e.itemId === itemId)?.quantity ?? 0);
const leftField = (user, itemId) => ({ name: '🎒 Left in bag', value: `${leftInBag(user, itemId)}x`, inline: true });

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
                    'inventory activeEffects streak crimeContractStacks staminaUpgrades petSlots deceasedPets'
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
                .map(e => ({
                    quantity: e.quantity,
                    item: describeItem(e.itemId, { shopItems }),
                    status: useStatus(e.itemId, user, { shopItems, hasRole }),
                }))
                .filter(c => c.status.usable);

            // Matched on the display name and the raw id, like /gift.
            const matches = focused
                ? items.filter(c => c.item.name.toLowerCase().includes(focused) || c.item.itemId.toLowerCase().includes(focused))
                : items;

            // Ready to use first, blocked ones (already running, maxed) after;
            // within each, prefix matches ahead of substring ones, then A–Z.
            const prefix = c => (focused && !c.item.name.toLowerCase().startsWith(focused) ? 1 : 0);
            const ranked = [...matches].sort((a, b) =>
                (Number(b.status.ready) - Number(a.status.ready))
                || (prefix(a) - prefix(b))
                || a.item.name.localeCompare(b.item.name));

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
        const effectType  = resolveEffectType(canonicalId);
        const cfg         = effectType ? EFFECT_CONFIGS[effectType] : null;

        // ── Items /use has nothing to do with ────────────────────────────────
        // Refused before anything is written. The generic branch at the bottom
        // used to swallow these — a relic, a forged item or a bag of pet food
        // would be "used" into nothing.
        // No settings (a guild that never saved any) means no custom shop, so
        // an unknown item there is refused like any other. A settings read that
        // fails throws out of the Promise.all above, before anything is spent.
        const status = useStatus(canonicalId, preview, { shopItems });
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

        // ── Active-effect items ───────────────────────────────────────────────
        if (cfg) {
            if (hasEffect(preview, effectType)) {
                const existing = preview.activeEffects.find(e => e.type === effectType);
                const when = existing?.expiresAt
                    ? `It runs out ${relativeTime(existing.expiresAt)} — use another once it does.`
                    : 'It is armed and waiting for its trigger — use another once it fires.';
                return interaction.reply({
                    content: `**${cfg.emoji} ${cfg.label}** is already active. ${when} Nothing was consumed.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // Consume the item and start the effect in one guarded write (#873,
            // pass 14). This used to consume atomically and then add the effect
            // to the loaded document and save() it: a save that failed left the
            // item spent with no effect running, a save that landed wrote the
            // whole activeEffects array back from its snapshot, and two clicks
            // could both pass the "already active" read above and spend two
            // items on one effect.
            const activation = await activateEffect(User, userFilter, effectType, { consumeItemId: canonicalId });

            if (activation.status !== 'activated') {
                // Either the item went, or the effect started, since the read
                // above — a double-click lands here. Nothing was consumed.
                return interaction.reply({
                    content: `Couldn't activate **${cfg.emoji} ${cfg.label}** — it may already be active, or you no longer have one.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const { doc: user, effect } = activation;
            user.inventory = user.inventory.filter(e => e.quantity > 0);
            await dropEmptyInventorySlots();

            const embed = new EmbedBuilder()
                .setColor(item.color ?? COLORS.SUCCESS)
                .setTitle(`${cfg.emoji} Activated: ${cfg.label}`)
                .setTimestamp();

            const what = describeEffect(canonicalId, shopItems);
            embed.setDescription([what, item.lore && `> *${item.lore}*`].filter(Boolean).join('\n\n') || null);

            if (effect.expiresAt) {
                embed.addFields({ name: '⏳ Expires', value: relativeTime(effect.expiresAt), inline: true });
            } else if (effect.charges > 1) {
                embed.addFields({ name: '🔋 Charges', value: `${effect.charges} — spent automatically as they trigger`, inline: true });
            } else {
                embed.addFields({ name: '🎯 Armed', value: 'Fires automatically on the next qualifying event', inline: true });
            }
            embed.addFields(leftField(user, canonicalId));

            return interaction.reply({ embeds: [embed] });
        }

        // ── Streak Freeze ──────────────────────────────────────────────────────
        if (canonicalId.toLowerCase() === 'streak_freeze') {
            const currentFreezes = preview.streak?.freezes ?? 0;
            if (currentFreezes >= MAX_FREEZES) {
                return interaction.reply({
                    content: `🧊 You already have **${currentFreezes}** streak freeze${currentFreezes !== 1 ? 's' : ''} banked (max ${MAX_FREEZES}). Use some before banking more.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const user = await User.findOneAndUpdate(
                { ...userFilter, inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } }, 'streak.freezes': { $lt: MAX_FREEZES } },
                { $inc: { 'inventory.$.quantity': -1, 'streak.freezes': 1 } },
                { new: true }
            );

            if (!user) {
                return interaction.reply({ content: `Couldn't bank the freeze — you may be at the cap already.`, flags: MessageFlags.Ephemeral });
            }

            // Local copy stays filtered for anything rendered below; the stored
            // one is corrected by a targeted $pull.
            user.inventory = user.inventory.filter(e => e.quantity > 0);
            await dropEmptyInventorySlots();

            const newFreezes = user.streak?.freezes ?? 0;
            const embed = new EmbedBuilder()
                .setColor(COLORS.INFO)
                .setTitle('🧊 Streak Freeze Banked')
                .setDescription(
                    `One freeze is now stored. If you miss a daily, it auto-consumes to keep your streak alive.\n\n` +
                    `**Freezes banked:** ${newFreezes} / ${MAX_FREEZES}`
                )
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        // ── Black Market Contract ──────────────────────────────────────────────
        if (canonicalId.toLowerCase() === 'black_market_contract') {
            const MAX_STACKS = MAX_CONTRACT_STACKS;
            const currentStacks = preview.crimeContractStacks ?? 0;
            if (currentStacks >= MAX_STACKS) {
                return interaction.reply({
                    content: `📜 You already have **${currentStacks}** contract stacks (max ${MAX_STACKS}). The house won't deal further.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const user = await User.findOneAndUpdate(
                {
                    ...userFilter,
                    inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } },
                    crimeContractStacks: { $lt: MAX_STACKS },
                },
                { $inc: { 'inventory.$.quantity': -1, crimeContractStacks: 1 } },
                { new: true }
            );

            if (!user) {
                return interaction.reply({ content: `Couldn't apply the contract — you may be at the max stacks already.`, flags: MessageFlags.Ephemeral });
            }

            // Local copy stays filtered for anything rendered below; the stored
            // one is corrected by a targeted $pull.
            user.inventory = user.inventory.filter(e => e.quantity > 0);
            await dropEmptyInventorySlots();

            const newStacks = user.crimeContractStacks ?? 0;
            const embed = new EmbedBuilder()
                .setColor('#2c3e50')
                .setTitle('📜 Black Market Contract Signed')
                .setDescription(
                    `A permanent +5% crime success bonus has been added to your record.\n\n` +
                    `**Contract stacks:** ${newStacks} / ${MAX_STACKS} (+${newStacks * 5}% total bonus)`
                )
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        // ── Permanent Stamina +1 ───────────────────────────────────────────────
        if (canonicalId.toLowerCase() === 'permanent_stamina') {
            if ((preview.staminaUpgrades ?? 0) >= MAX_STAMINA_UPGRADES) {
                return interaction.reply({
                    content: `⚡ You already have all **${MAX_STAMINA_UPGRADES}** stamina upgrades. There is no more endurance to buy.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const user = await User.findOneAndUpdate(
                {
                    ...userFilter,
                    inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } },
                    staminaUpgrades: { $lt: MAX_STAMINA_UPGRADES },
                },
                { $inc: { 'inventory.$.quantity': -1, staminaUpgrades: 1 } },
                { new: true }
            );
            if (!user) {
                return interaction.reply({ content: "Couldn't apply the upgrade — you may be at the cap already.", flags: MessageFlags.Ephemeral });
            }

            // The decrement above is already persisted; this only clears the
            // husk it may have left behind.
            await dropEmptyInventorySlots();

            const owned = user.staminaUpgrades ?? 0;
            const embed = new EmbedBuilder()
                .setColor('#f1c40f')
                .setTitle('⚡ Stamina Raised')
                .setDescription(
                    `Your maximum stamina in hunting, fishing and mining is now **+${owned}**.\n\n` +
                    `**Upgrades:** ${owned} / ${MAX_STAMINA_UPGRADES}`
                )
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        // ── Pet Slot Expansion ─────────────────────────────────────────────────
        if (canonicalId.toLowerCase() === 'pet_slot_expansion') {
            if ((preview.petSlots ?? 0) >= MAX_SLOT_EXPANSIONS) {
                return interaction.reply({
                    content: `🐾 You already have all **${MAX_SLOT_EXPANSIONS}** expansions (${petCapacity(preview)} pet slots). There's no more room to make.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const user = await User.findOneAndUpdate(
                {
                    ...userFilter,
                    inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } },
                    petSlots: { $lt: MAX_SLOT_EXPANSIONS },
                },
                { $inc: { 'inventory.$.quantity': -1, petSlots: 1 } },
                { new: true }
            );
            if (!user) {
                return interaction.reply({ content: "Couldn't add the slot — you may be at the cap already.", flags: MessageFlags.Ephemeral });
            }

            // Local copy stays filtered for anything rendered below; the stored
            // one is corrected by a targeted $pull.
            user.inventory = user.inventory.filter(e => e.quantity > 0);
            await dropEmptyInventorySlots();

            const embed = new EmbedBuilder()
                .setColor(COLORS.RARE)
                .setTitle('🐾 Pet Slot Added')
                .setDescription(
                    `Room for one more companion.\n\n` +
                    `**Slots:** ${petCapacity(user)} (${user.petSlots} / ${MAX_SLOT_EXPANSIONS} expansions used)\n` +
                    `*Rare companions found while hunting, fishing or mining don't take up a slot.*`
                )
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        // ── Revive Scroll ──────────────────────────────────────────────────────
        if (canonicalId.toLowerCase() === 'revive_scroll') {
            const fallen = preview.deceasedPets?.[0];
            if (!fallen) {
                return interaction.reply({
                    content: '📜 The scroll finds no one to call back — none of your pets have starved. Keep it for a rainier day.',
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
                // Comes back weak but alive: bond, level, XP and record are preserved,
                // the starvation state is not.
                hunger: 50,
                lastFed: now,
                lastDecayAt: now,
                starving: false,
                starvingStartAt: null,
            };
            delete revived._id;
            delete revived.diedAt;

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
                    `**${fallen.battleWins ?? 0}W / ${fallen.battleLosses ?? 0}L**, and every day of your bond.`
                )
                .addFields(
                    { name: '🍖 Hunger', value: '50% — feed them soon', inline: true },
                    leftField(user, canonicalId),
                )
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        // ── Seasonal loot boxes ────────────────────────────────────────────────
        const lootBoxEvent = LOOT_BOX_EVENTS.get(canonicalId.toLowerCase());
        if (lootBoxEvent) {
            const won = rollLootBox(lootBoxEvent);
            if (!won) {
                return interaction.reply({ content: `The **${lootBoxEvent.lootBox.name}** is empty. That shouldn't happen — let a mod know.`, flags: MessageFlags.Ephemeral });
            }

            // Atomically consume the loot box
            const user = await User.findOneAndUpdate(
                { ...userFilter, inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } } },
                { $inc: { 'inventory.$.quantity': -1 } },
                { new: true }
            );

            if (!user) {
                return interaction.reply({ content: `You don't have **${itemName}** in your inventory.`, flags: MessageFlags.Ephemeral });
            }

            // Credit the won item in one atomic update, then clean up zeros. The
            // match-then-push it replaced could leave two slots for the same item
            // when two boxes opened at once, stranding the second slot's quantity.
            //
            // The box is already consumed above, so a grant that fails loses the
            // prize outright — the item-side #804 failure. A bare grant read
            // nothing back and announced the win regardless; grantItemsOrOwe
            // (keyed, never throwing) records it for `payouts:replay` when it
            // will not land, and the embed says so instead of promising an item
            // that isn't in the bag.
            const wonGrant = await grantItemsOrOwe(
                { userId: userFilter.userId, guildId: userFilter.guildId },
                won.itemId, 1,
                {
                    payoutKey: lootBoxItemPayoutKey(interaction.id),
                    service: 'use',
                    jobName: 'lootBoxItem',
                },
            );

            await dropEmptyInventorySlots();

            // `user` is the post-decrement document, so this is already net of
            // the box just opened.
            const boxRemaining = leftInBag(user, canonicalId);

            const embed = new EmbedBuilder()
                .setColor(RARITY_COLORS[won.rarity] ?? '#5865F2')
                .setTitle(`${lootBoxEvent.lootBox.emoji} Opened: ${lootBoxEvent.lootBox.name}`)
                .setDescription(`You found a **${won.rarity}** item:\n\n${won.emoji} **${won.name}**`)
                .addFields({ name: '🎒 Left in bag', value: `${boxRemaining}x ${lootBoxEvent.lootBox.name}`, inline: true })
                .setTimestamp();

            if (!wonGrant.granted) {
                embed.addFields({
                    name: '⚠️ Not Yet in Your Inventory',
                    value: wonGrant.owed
                        ? `**${won.name}** couldn't be added just now and has been recorded as owed — it'll appear once the problem clears. Tell an admin if it doesn't.`
                        : `**${won.name}** couldn't be added and could not be recorded — please contact a server admin.`,
                });
            }

            return interaction.reply({ embeds: [embed] });
        }

        // ── Generic (role-granting) items ─────────────────────────────────────
        const shopItem = findShopRow(canonicalId, shopItems);

        // A role item is acknowledged privately *before* the lock, as /gift is:
        // a second press can wait out the first one's forced member fetch,
        // write, roles.add and possibly a refund, and an unacknowledged wait
        // past three seconds ends in "the application did not respond".
        // Refusals and refund notes stay private in that reply; the success
        // card goes out publicly as a follow-up.
        const isRoleItem = Boolean(shopItem?.roleId);
        if (isRoleItem) await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const redeem = async () => {
            // The role is checked before anything is spent, against a fresh fetch
            // (`force`): a cached member can predate a role another bot or an
            // admin just gave, and would let the item be spent on a no-op.
            let member = null;
            if (isRoleItem) {
                member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true }).catch(() => null);
                if (!member) {
                    return interaction.editReply({
                        content: `Couldn't check your roles just now, so nothing was used. Try again in a moment.`,
                    });
                }
                if (member.roles.cache.has(shopItem.roleId)) {
                    return interaction.editReply({
                        content: `You already have <@&${shopItem.roleId}>, so **${shopItem.name ?? item.name}** would do nothing. Nothing was used.`,
                        allowedMentions: { parse: [] },
                    });
                }
            } else {
                // Acknowledged before the write, like the role path above.
                await interaction.deferReply();
            }

            // Atomically consume one item before side-effects (role grant)
            const user = await User.findOneAndUpdate(
                { ...userFilter, inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } } },
                { $inc: { 'inventory.$.quantity': -1 } },
                { new: true }
            );

            if (!user) {
                return interaction.editReply({ content: `You don't have **${itemName}** in your inventory.` });
            }

            await dropEmptyInventorySlots();

            let roleGranted = false;
            if (member) {
                try {
                    await member.roles.add(shopItem.roleId, `Used shop item: ${shopItem.name}`);
                    roleGranted = true;
                } catch (err) {
                    // Discord refused (missing permission, role above the bot's). The
                    // item is already spent, so it goes back — keyed, and recorded as
                    // owed if even that will not land.
                    console.error('[use] role grant failed, returning the item:', err?.message ?? err);
                    const refund = await grantItemsOrOwe(
                        { userId: userFilter.userId, guildId: userFilter.guildId },
                        canonicalId, 1,
                        { payoutKey: useRoleRefundPayoutKey(interaction.id), service: 'use', jobName: 'roleRefund' },
                    );
                    return interaction.editReply({
                        content: refund.granted
                            ? `Couldn't give you <@&${shopItem.roleId}> — the bot may lack permission. Your **${item.name}** was returned; let an admin know.`
                            : `Couldn't give you <@&${shopItem.roleId}>, and returning your **${item.name}** failed${refund.owed ? ' — it is recorded as owed and will come back' : ''}. Please tell an admin.`,
                        allowedMentions: { parse: [] },
                    });
                }
            }

            const baseDesc    = shopItem?.description || 'Redeemed from your inventory.';
            const genericDesc = item.lore ? `${baseDesc}\n\n> *${item.lore}*` : baseDesc;

            const embed = new EmbedBuilder()
                .setColor(item.color ?? COLORS.SUCCESS)
                .setTitle(`${item.emoji} Used: ${shopItem?.name ?? item.name}`)
                .setDescription(genericDesc)
                .setTimestamp();

            if (roleGranted) {
                embed.addFields({ name: '🎭 Role Granted', value: `<@&${shopItem.roleId}>`, inline: true });
            }

            // `user` is the post-decrement document — no second subtraction.
            embed.addFields(leftField(user, canonicalId));

            if (isRoleItem) {
                await interaction.editReply({ content: `✅ Used **${shopItem.name ?? item.name}**.` });
                return interaction.followUp({ embeds: [embed] });
            }
            return interaction.editReply({ embeds: [embed] });
        };

        // One role redemption per member at a time: two quick /use presses on a
        // stack of two would otherwise both pass the has-role check and spend
        // the second item on a role the first had just granted.
        return isRoleItem
            ? withUserLock(`use-role:${userFilter.guildId}:${userFilter.userId}`, redeem)
            : redeem();
    }
};
