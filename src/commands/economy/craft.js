'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { CRAFT_RECIPES, CONSUMABLES, MATERIAL_NAMES } = require('../../data/huntData');
const { ensureHuntData } = require('../../services/huntService');

const RECIPE_CHOICES = Object.values(CRAFT_RECIPES).map(r => ({ name: r.name, value: r.id }));

module.exports = {
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('craft')
        .setDescription('Craft items from hunting materials')
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Browse all available crafting recipes'))
        .addSubcommand(sub =>
            sub.setName('make')
                .setDescription('Craft an item from your materials')
                .addStringOption(o =>
                    o.setName('recipe')
                        .setDescription('Recipe to craft')
                        .setRequired(true)
                        .addChoices(...RECIPE_CHOICES))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );
        ensureHuntData(user);
        const h = user.hunt;

        // ── LIST ───────────────────────────────────────────────────────────
        if (sub === 'list') {
            const lines = Object.values(CRAFT_RECIPES).map(r => {
                const ingredientStr = r.ingredients
                    .map(ing => `${MATERIAL_NAMES[ing.material] ?? ing.material} ×${ing.qty}`)
                    .join(', ');

                const canCraft = r.ingredients.every(ing => (h.materials[ing.material] ?? 0) >= ing.qty);
                const uniqueDone = r.unique && r.output.id === 'luckyPaw' && h.luckyPaw;
                const status = uniqueDone ? '✅ **[OWNED]**' : canCraft ? '✅' : '❌';

                return `${status} **${r.emoji} ${r.name}**\n> ${r.description}\n> Requires: ${ingredientStr}`;
            });

            const embed = new EmbedBuilder()
                .setColor('#1abc9c')
                .setTitle('🔨 Crafting Recipes')
                .setDescription(lines.join('\n\n'))
                .setFooter({ text: '✅ = you can craft now  •  Use /craft make <recipe> to craft  •  /huntinv materials to check stock' });

            return interaction.reply({ embeds: [embed] });
        }

        // ── MAKE ───────────────────────────────────────────────────────────
        if (sub === 'make') {
            const recipeId = interaction.options.getString('recipe');
            const recipe   = CRAFT_RECIPES[recipeId];

            if (!recipe) {
                return interaction.reply({
                    content: 'Unknown recipe. Use `/craft list` to see available recipes.',
                    ephemeral: true
                });
            }

            // Unique upgrade guard
            if (recipe.unique && recipe.output.id === 'luckyPaw' && h.luckyPaw) {
                return interaction.reply({
                    content: 'You already have the **🐾 Lucky Paw** upgrade!',
                    ephemeral: true
                });
            }

            // Stack limit guard for consumables
            if (recipe.output.type === 'consumable') {
                const def          = CONSUMABLES[recipe.output.id];
                const currentStock = h.consumables[recipe.output.id] ?? 0;
                if (def && currentStock + recipe.output.qty > def.maxStack) {
                    return interaction.reply({
                        content: `You can only hold **${def.maxStack}× ${def.name}** (you have ${currentStock}). ` +
                                 `Free up space before crafting more.`,
                        ephemeral: true
                    });
                }
            }

            // Check ingredients
            const missing = recipe.ingredients
                .filter(ing => (h.materials[ing.material] ?? 0) < ing.qty)
                .map(ing => `**${MATERIAL_NAMES[ing.material] ?? ing.material}** (need ${ing.qty}, have ${h.materials[ing.material] ?? 0})`);

            if (missing.length) {
                return interaction.reply({
                    content: `You are missing the following materials:\n${missing.join('\n')}`,
                    ephemeral: true
                });
            }

            // Consume materials
            for (const ing of recipe.ingredients) {
                h.materials[ing.material] -= ing.qty;
            }

            // Apply output
            let outputDesc = '';
            if (recipe.output.type === 'consumable') {
                h.consumables[recipe.output.id] = (h.consumables[recipe.output.id] ?? 0) + recipe.output.qty;
                const def = CONSUMABLES[recipe.output.id];
                outputDesc = `${def?.emoji ?? '📦'} **${recipe.output.qty}× ${def?.name ?? recipe.output.id}**`;
            } else if (recipe.output.type === 'ammo') {
                h.ammo[recipe.output.id] = (h.ammo[recipe.output.id] ?? 0) + recipe.output.qty;
                outputDesc = `🔶 **${recipe.output.qty}× ${recipe.output.id.replace(/_/g, ' ')}** rounds`;
            } else if (recipe.output.type === 'permanent') {
                if (recipe.output.id === 'luckyPaw') {
                    h.luckyPaw = true;
                    outputDesc = '🐾 **Lucky Paw** — permanently +1% critical hit chance!';
                }
            }

            user.markModified('hunt');
            await user.save();

            const usedLines = recipe.ingredients.map(ing =>
                `• ${MATERIAL_NAMES[ing.material] ?? ing.material} ×${ing.qty}` +
                `  (remaining: ${h.materials[ing.material]})`
            ).join('\n');

            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${recipe.emoji} Crafted: ${recipe.name}`)
                .setDescription(`You crafted ${outputDesc}!`)
                .addFields({ name: 'Materials Consumed', value: usedLines, inline: false })
                .setFooter({ text: 'Use /huntinv materials to check your remaining stock' })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }
    }
};
