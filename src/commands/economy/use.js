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

        const [user, guildSettings] = await Promise.all([
            User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
            Guild.findOne({ guildId: interaction.guild.id })
        ]);

        if (!user || !user.inventory?.length) {
            return interaction.reply({ content: "Your inventory is empty. Buy items with `/shop buy`.", flags: MessageFlags.Ephemeral });
        }

        const invEntry = user.inventory.find(e => e.itemId.toLowerCase() === itemName.toLowerCase());
        if (!invEntry || invEntry.quantity < 1) {
            return interaction.reply({ content: `You don't have **${itemName}** in your inventory.`, flags: MessageFlags.Ephemeral });
        }

        const effectType = resolveEffectType(itemName);
        const cfg        = effectType ? EFFECT_CONFIGS[effectType] : null;

        // ── Active-effect items ───────────────────────────────────────────────
        if (cfg) {
            if (hasEffect(user, effectType)) {
                const existing = user.activeEffects.find(e => e.type === effectType);
                return interaction.reply({
                    content: `**${cfg.emoji} ${cfg.label}** is already active (${timeRemaining(existing?.expiresAt)} remaining). It will refresh when it expires.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // Consume one from inventory
            invEntry.quantity -= 1;
            if (invEntry.quantity <= 0) {
                user.inventory = user.inventory.filter(e => e.itemId.toLowerCase() !== itemName.toLowerCase());
            }

            const effect = addEffect(user, effectType);
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

            const lore = getItemLore(invEntry.itemId);
            embed.setDescription(lore ? `${activationDesc}\n\n> *${lore}*` : activationDesc);

            embed.addFields({
                name: 'Remaining in inventory',
                value: `${user.inventory.find(e => e.itemId.toLowerCase() === itemName.toLowerCase())?.quantity ?? 0}x`,
                inline: true
            });

            return interaction.reply({ embeds: [embed] });
        }

        // ── Seasonal loot boxes ────────────────────────────────────────────────
        const lootBoxEvent = LOOT_BOX_EVENTS.get(invEntry.itemId.toLowerCase());
        if (lootBoxEvent) {
            const won = rollLootBox(lootBoxEvent);
            if (!won) {
                return interaction.reply({ content: `The **${lootBoxEvent.lootBox.name}** is empty. That shouldn't happen — let a mod know.`, flags: MessageFlags.Ephemeral });
            }

            invEntry.quantity -= 1;
            if (invEntry.quantity <= 0) {
                user.inventory = user.inventory.filter(e => e.itemId.toLowerCase() !== itemName.toLowerCase());
            }

            if (!user.inventory) user.inventory = [];
            const wonSlot = user.inventory.find(e => e.itemId === won.itemId);
            if (wonSlot) {
                wonSlot.quantity += 1;
            } else {
                user.inventory.push({ itemId: won.itemId, quantity: 1 });
            }

            await user.save();

            const embed = new EmbedBuilder()
                .setColor(RARITY_COLORS[won.rarity] ?? '#5865F2')
                .setTitle(`${lootBoxEvent.lootBox.emoji} Opened: ${lootBoxEvent.lootBox.name}`)
                .setDescription(`You found a **${won.rarity}** item:\n\n${won.emoji} **${won.name}**`)
                .addFields({ name: 'Remaining in inventory', value: `${user.inventory.find(e => e.itemId === invEntry.itemId)?.quantity ?? 0}x ${lootBoxEvent.lootBox.name}`, inline: true })
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

        invEntry.quantity -= 1;
        if (invEntry.quantity <= 0) {
            user.inventory = user.inventory.filter(e => e.itemId.toLowerCase() !== itemName.toLowerCase());
        }
        await user.save();

        const loreText   = shopItem?.lore ?? getItemLore(itemName.toLowerCase());
        const baseDesc   = shopItem?.description || 'Item consumed from your inventory.';
        const genericDesc = loreText ? `${baseDesc}\n\n> *${loreText}*` : baseDesc;

        const embed = new EmbedBuilder()
            .setColor('#2ecc71')
            .setTitle(`✅ Used: ${shopItem?.name ?? itemName}`)
            .setDescription(genericDesc)
            .setTimestamp();

        if (roleGranted) {
            embed.addFields({ name: 'Role Granted', value: `<@&${shopItem.roleId}>` });
        }

        const remaining = user.inventory.find(e => e.itemId.toLowerCase() === itemName.toLowerCase())?.quantity ?? 0;
        embed.addFields({ name: 'Remaining', value: `${remaining}x`, inline: true });

        await interaction.reply({ embeds: [embed] });
    }
};
