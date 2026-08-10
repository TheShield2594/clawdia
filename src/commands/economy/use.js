const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const {
    EFFECT_CONFIGS,
    resolveEffectType,
    addEffect,
    hasEffect,
    timeRemaining,
} = require('../../services/effectsService');
const { getItemLore } = require('../../data/defaultShopItems');
const { SEASONAL_EVENTS, RARITY_COLORS, rollLootBox } = require('../../data/seasonalEvents');
const { PET_DEFINITIONS } = require('../../services/petService');

// itemId of a seasonal loot box -> the event definition that owns it
const LOOT_BOX_EVENTS = new Map(
    Object.values(SEASONAL_EVENTS)
        .filter(ev => ev.lootBox)
        .map(ev => [ev.lootBox.itemId.toLowerCase(), ev])
);

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
            const user = await User.findOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                'inventory'
            ).lean();
            const inventory = (user?.inventory ?? []).filter(e => e.quantity > 0);
            const matches = focused
                ? inventory.filter(e => e.itemId.toLowerCase().includes(focused))
                : inventory;
            await interaction.respond(
                matches.slice(0, 25).map(e => ({
                    name: `${e.itemId} (${e.quantity}x)`,
                    value: e.itemId,
                }))
            );
        } catch {
            await interaction.respond([]).catch(() => {});
        }
    },

    async execute(interaction) {
        const itemName = interaction.options.getString('item').trim();
        const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

        // Read first to resolve item identity (itemId casing, effect checks)
        const [preview, guildSettings] = await Promise.all([
            User.findOne(userFilter),
            Guild.findOne({ guildId: interaction.guild.id })
        ]);

        if (!preview || !preview.inventory?.length) {
            return interaction.reply({ content: "Your inventory is empty. Buy items with `/shop buy`.", flags: MessageFlags.Ephemeral });
        }

        const invEntry = preview.inventory.find(e => e.itemId.toLowerCase() === itemName.toLowerCase());
        if (!invEntry || invEntry.quantity < 1) {
            return interaction.reply({ content: `You don't have **${itemName}** in your inventory.`, flags: MessageFlags.Ephemeral });
        }

        const canonicalId = invEntry.itemId; // preserve original casing for DB match
        const effectType  = resolveEffectType(itemName);
        const cfg         = effectType ? EFFECT_CONFIGS[effectType] : null;

        // ── Active-effect items ───────────────────────────────────────────────
        if (cfg) {
            if (hasEffect(preview, effectType)) {
                const existing = preview.activeEffects.find(e => e.type === effectType);
                return interaction.reply({
                    content: `**${cfg.emoji} ${cfg.label}** is already active (${timeRemaining(existing?.expiresAt)} remaining). It will refresh when it expires.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // Atomically consume one item (quantity must be > 0)
            const user = await User.findOneAndUpdate(
                { ...userFilter, inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } } },
                { $inc: { 'inventory.$.quantity': -1 } },
                { new: true }
            );

            if (!user) {
                return interaction.reply({ content: `You don't have **${itemName}** in your inventory.`, flags: MessageFlags.Ephemeral });
            }

            const effect = addEffect(user, effectType);
            // Clean up zero-quantity entries and save effect
            user.inventory = user.inventory.filter(e => e.quantity > 0);
            await user.save();

            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${cfg.emoji} Activated: ${cfg.label}`)
                .setTimestamp();

            let activationDesc;
            if (effect.expiresAt) {
                activationDesc = `Effect active for **${timeRemaining(effect.expiresAt)}**.`;
            } else if (effect.charges === 1) {
                activationDesc = 'Single-use effect is now ready. It will trigger automatically on the next qualifying event.';
            } else {
                activationDesc = 'Effect is permanently active until removed.';
            }

            const lore = getItemLore(canonicalId);
            embed.setDescription(lore ? `${activationDesc}\n\n> *${lore}*` : activationDesc);

            embed.addFields({
                name: 'Remaining in inventory',
                value: `${user.inventory.find(e => e.itemId === canonicalId)?.quantity ?? 0}x`,
                inline: true
            });

            return interaction.reply({ embeds: [embed] });
        }

        // ── Streak Freeze ──────────────────────────────────────────────────────
        if (canonicalId.toLowerCase() === 'streak_freeze') {
            const MAX_FREEZES = 2;
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

            user.inventory = user.inventory.filter(e => e.quantity > 0);
            await user.save();

            const newFreezes = user.streak?.freezes ?? 0;
            const embed = new EmbedBuilder()
                .setColor('#5dade2')
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
            const MAX_STACKS = 3;
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

            user.inventory = user.inventory.filter(e => e.quantity > 0);
            await user.save();

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

            // Consume the scroll and remove the record in one conditional write so a
            // double-click can't revive the same pet twice.
            const user = await User.findOneAndUpdate(
                {
                    ...userFilter,
                    inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } },
                    'deceasedPets._id': fallen._id,
                },
                // arrayFilters rather than the positional `$`: the query touches two
                // arrays here, which makes `$` ambiguous about which one it indexes.
                { $inc: { 'inventory.$[inv].quantity': -1 }, $pull: { deceasedPets: { _id: fallen._id } } },
                { new: true, arrayFilters: [{ 'inv.itemId': canonicalId, 'inv.quantity': { $gt: 0 } }] }
            );
            if (!user) {
                return interaction.reply({ content: "Couldn't use the scroll — try again.", flags: MessageFlags.Ephemeral });
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
            user.pets.push(revived);
            user.inventory = user.inventory.filter(e => e.quantity > 0);
            user.markModified('pets');
            await user.save();

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
                    { name: 'Scrolls left', value: `${user.inventory.find(e => e.itemId === canonicalId)?.quantity ?? 0}x`, inline: true },
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

            // Credit the won item atomically, then clean up zeros
            await User.findOneAndUpdate(
                { ...userFilter, 'inventory.itemId': won.itemId },
                { $inc: { 'inventory.$.quantity': 1 } }
            ).then(async matched => {
                if (!matched) {
                    await User.findOneAndUpdate(
                        userFilter,
                        { $push: { inventory: { itemId: won.itemId, quantity: 1 } } }
                    );
                }
            });

            // Clean up zero-quantity entries
            await User.findOneAndUpdate(userFilter, { $pull: { inventory: { quantity: { $lte: 0 } } } });

            const boxRemaining = (user.inventory.find(e => e.itemId === canonicalId)?.quantity ?? 1) - 1;

            const embed = new EmbedBuilder()
                .setColor(RARITY_COLORS[won.rarity] ?? '#5865F2')
                .setTitle(`${lootBoxEvent.lootBox.emoji} Opened: ${lootBoxEvent.lootBox.name}`)
                .setDescription(`You found a **${won.rarity}** item:\n\n${won.emoji} **${won.name}**`)
                .addFields({ name: 'Remaining in inventory', value: `${boxRemaining}x ${lootBoxEvent.lootBox.name}`, inline: true })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        // ── Generic (role-granting) items ─────────────────────────────────────
        const shopItem = guildSettings?.shop?.find(s => s.name.toLowerCase() === itemName.toLowerCase());

        // Atomically consume one item before side-effects (role grant)
        const user = await User.findOneAndUpdate(
            { ...userFilter, inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } } },
            { $inc: { 'inventory.$.quantity': -1 } },
            { new: true }
        );

        if (!user) {
            return interaction.reply({ content: `You don't have **${itemName}** in your inventory.`, flags: MessageFlags.Ephemeral });
        }

        // Clean up zero-quantity entries
        await User.findOneAndUpdate(userFilter, { $pull: { inventory: { quantity: { $lte: 0 } } } });

        let roleGranted = false;
        if (shopItem?.roleId) {
            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            if (member && !member.roles.cache.has(shopItem.roleId)) {
                await member.roles.add(shopItem.roleId, `Used shop item: ${shopItem.name}`);
                roleGranted = true;
            }
        }

        const loreText    = shopItem?.lore ?? getItemLore(itemName.toLowerCase());
        const baseDesc    = shopItem?.description || 'Item consumed from your inventory.';
        const genericDesc = loreText ? `${baseDesc}\n\n> *${loreText}*` : baseDesc;

        const embed = new EmbedBuilder()
            .setColor('#2ecc71')
            .setTitle(`✅ Used: ${shopItem?.name ?? itemName}`)
            .setDescription(genericDesc)
            .setTimestamp();

        if (roleGranted) {
            embed.addFields({ name: 'Role Granted', value: `<@&${shopItem.roleId}>` });
        }

        const remaining = (user.inventory.find(e => e.itemId === canonicalId)?.quantity ?? 1) - 1;
        embed.addFields({ name: 'Remaining', value: `${remaining}x`, inline: true });

        await interaction.reply({ embeds: [embed] });
    }
};
