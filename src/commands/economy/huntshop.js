'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { CONSUMABLES, AMMO_PACKS } = require('../../data/huntData');
const { ensureHuntData, activateConsumable } = require('../../services/huntService');

// Flat list for buy choices (consumables + ammo packs)
const ALL_ITEMS = [
    ...Object.values(CONSUMABLES),
    ...AMMO_PACKS
];
const ITEM_CHOICES = ALL_ITEMS.map(i => ({ name: i.name, value: i.id }));

// Activatable consumable IDs (items that get "activated" vs just stocked)
const ACTIVATABLE = ['basic_bait', 'premium_bait', 'luck_charm', 'hunters_focus', 'xp_scroll', 'stamina_tonic'];

module.exports = {
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('huntshop')
        .setDescription('Buy and manage hunting consumables and ammunition')
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('Browse the hunting shop')
                .addStringOption(o =>
                    o.setName('category')
                        .setDescription('Category to view')
                        .setRequired(false)
                        .addChoices(
                            { name: 'Consumables', value: 'consumables' },
                            { name: 'Ammunition',  value: 'ammo' },
                            { name: 'All',         value: 'all' }
                        )))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Purchase an item')
                .addStringOption(o =>
                    o.setName('item')
                        .setDescription('Item to buy')
                        .setRequired(true)
                        .addChoices(...ITEM_CHOICES))
                .addIntegerOption(o =>
                    o.setName('quantity')
                        .setDescription('How many to buy (default: 1)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(20)))
        .addSubcommand(sub =>
            sub.setName('use')
                .setDescription('Activate a consumable buff')
                .addStringOption(o =>
                    o.setName('item')
                        .setDescription('Consumable to activate')
                        .setRequired(true)
                        .addChoices(...ACTIVATABLE.map(id => ({ name: CONSUMABLES[id].name, value: id }))))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        const currency = guildSettings?.economy?.currency ?? '💰';

        // ── VIEW ───────────────────────────────────────────────────────────
        if (sub === 'view') {
            const category = interaction.options.getString('category') ?? 'all';
            const embed    = new EmbedBuilder().setColor('#f39c12').setTimestamp();

            if (category === 'consumables' || category === 'all') {
                const lines = Object.values(CONSUMABLES).map(c =>
                    `**${c.emoji} ${c.name}** — ${currency}${c.cost}\n> ${c.description}`
                );
                embed.addFields({ name: '🧪 Consumables', value: lines.join('\n') });
            }

            if (category === 'ammo' || category === 'all') {
                const lines = AMMO_PACKS.map(a =>
                    `**${a.emoji} ${a.name}** — ${currency}${a.cost}\n> ${a.description}`
                );
                embed.addFields({ name: '🔶 Ammunition', value: lines.join('\n') });
            }

            embed.setTitle('🏪 Hunt Shop');
            embed.setFooter({ text: 'Use /huntshop buy <item> to purchase • /huntshop use <item> to activate buffs' });
            return interaction.reply({ embeds: [embed] });
        }

        // ── BUY ────────────────────────────────────────────────────────────
        if (sub === 'buy') {
            const itemId   = interaction.options.getString('item');
            const quantity = interaction.options.getInteger('quantity') ?? 1;

            // Find item in consumables or ammo packs
            const consumableDef = CONSUMABLES[itemId];
            const ammoDef       = AMMO_PACKS.find(a => a.id === itemId);
            const itemDef       = consumableDef ?? ammoDef;

            if (!itemDef) {
                return interaction.reply({ content: 'Unknown item. Use `/huntshop view` to see available items.', ephemeral: true });
            }

            const user = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
                { upsert: true, new: true }
            );
            ensureHuntData(user);
            const h = user.hunt;

            const totalCost = itemDef.cost * quantity;
            if (user.balance < totalCost) {
                return interaction.reply({
                    content: `You need ${currency}${totalCost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
                    ephemeral: true
                });
            }

            // Stack limit check for consumables
            if (consumableDef) {
                const currentStock = h.consumables[itemId] ?? 0;
                if (currentStock + quantity > consumableDef.maxStack) {
                    return interaction.reply({
                        content: `You can only hold **${consumableDef.maxStack}× ${consumableDef.name}** at once (you have ${currentStock}).`,
                        ephemeral: true
                    });
                }
                user.balance           -= totalCost;
                h.consumables[itemId]   = currentStock + quantity;
            } else {
                // Ammo pack
                const ammoType         = ammoDef.ammoType;
                const gained           = ammoDef.quantity * quantity;
                user.balance          -= totalCost;
                h.ammo[ammoType]       = (h.ammo[ammoType] ?? 0) + gained;
            }

            user.markModified('hunt');
            await user.save();

            const isAmmo   = !!ammoDef;
            const gained   = isAmmo ? `${ammoDef.quantity * quantity} rounds` : `${quantity}× ${consumableDef.name}`;
            const ammoNote = isAmmo ? `\nAmmo stock for **${ammoDef.ammoType.replace(/_/g, ' ')}**: ${h.ammo[ammoDef.ammoType]}` : '';

            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${itemDef.emoji} Purchase Successful`)
                .setDescription(`You bought **${gained}** for ${currency}${totalCost.toLocaleString()}.${ammoNote}`)
                .addFields(
                    { name: 'New Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true },
                    { name: 'In Stock',    value: isAmmo
                        ? `${h.ammo[ammoDef.ammoType]} ${ammoDef.ammoType.replace(/_/g, ' ')}`
                        : `${h.consumables[itemId]}× ${consumableDef.name}`, inline: true }
                );

            if (!isAmmo && ACTIVATABLE.includes(itemId)) {
                embed.setFooter({ text: `Activate with /huntshop use ${itemId}` });
            }

            return interaction.reply({ embeds: [embed] });
        }

        // ── USE ────────────────────────────────────────────────────────────
        if (sub === 'use') {
            const itemId = interaction.options.getString('item');

            const user = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
                { upsert: true, new: true }
            );
            ensureHuntData(user);

            const { success, error } = activateConsumable(user, itemId);

            if (!success) {
                return interaction.reply({ content: error, ephemeral: true });
            }

            await user.save();

            const def  = CONSUMABLES[itemId];
            const h    = user.hunt;
            let statusMsg = '';

            if (def.type === 'bait')   statusMsg = `Active for **${h.activeBaitHuntsLeft}** hunts.`;
            if (def.type === 'charm')  statusMsg = `Active for **${h.activeCharmHuntsLeft}** hunts.`;
            if (def.type === 'instant' && itemId === 'hunters_focus')  statusMsg = `Will apply on your next hunt.`;
            if (def.type === 'instant' && itemId === 'xp_scroll')      statusMsg = `Will apply on your next hunt.`;
            if (def.type === 'stamina') statusMsg = `Stamina: **${h.stamina}/${h.stamina + (def.staminaRestore ?? 0)}** — restored ${def.staminaRestore} points.`;

            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${def.emoji} ${def.name} Activated!`)
                .setDescription(`${def.description}\n${statusMsg}`)
                .setFooter({ text: 'Go hunt! Use /hunt' });

            return interaction.reply({ embeds: [embed] });
        }
    }
};
