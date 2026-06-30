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
                .setRequired(true)),

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

        let roleGranted = false;
        if (shopItem?.roleId) {
            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            if (member && !member.roles.cache.has(shopItem.roleId)) {
                await member.roles.add(shopItem.roleId, `Used shop item: ${shopItem.name}`);
                roleGranted = true;
            }
        }

        // Atomically consume one item
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
