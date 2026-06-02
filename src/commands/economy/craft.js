'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { CRAFT_RECIPES: HUNT_RECIPES, CONSUMABLES: HUNT_CONSUMABLES, MATERIAL_NAMES: HUNT_MATERIAL_NAMES } = require('../../data/huntData');
const { CRAFT_RECIPES: MINE_RECIPES, CONSUMABLES: MINE_CONSUMABLES, MATERIAL_NAMES: MINE_MATERIAL_NAMES } = require('../../data/mineData');
const { ensureHuntData } = require('../../services/huntService');
const { ensureMineData } = require('../../services/mineService');

const ALL_RECIPES     = { ...HUNT_RECIPES, ...MINE_RECIPES };
const ALL_MAT_NAMES   = { ...HUNT_MATERIAL_NAMES, ...MINE_MATERIAL_NAMES };
const RECIPE_CHOICES  = Object.values(ALL_RECIPES).map(r => ({ name: r.name, value: r.id }));

module.exports = {
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('craft')
        .setDescription('Craft items from hunting or mining materials')
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
        ensureMineData(user);
        const h = user.hunt;
        const m = user.mining;

        // Helper: get material qty from either skill
        function getMat(matId) {
            return (h.materials[matId] ?? 0) + (m.materials[matId] ?? 0);
        }
        // Helper: consume material from hunt first, then mine
        function consumeMat(matId, qty) {
            const huntHas = h.materials[matId] ?? 0;
            const fromHunt = Math.min(huntHas, qty);
            h.materials[matId] = huntHas - fromHunt;
            const fromMine = qty - fromHunt;
            if (fromMine > 0) m.materials[matId] = (m.materials[matId] ?? 0) - fromMine;
        }

        // ── LIST ───────────────────────────────────────────────────────────
        if (sub === 'list') {
            const huntLines = Object.values(HUNT_RECIPES).map(r => {
                const ingredientStr = r.ingredients
                    .map(ing => `${ALL_MAT_NAMES[ing.material] ?? ing.material} ×${ing.qty}`)
                    .join(', ');
                const canCraft  = r.ingredients.every(ing => getMat(ing.material) >= ing.qty);
                const uniqueDone = r.unique && r.output.id === 'luckyPaw' && h.luckyPaw;
                const status = uniqueDone ? '✅ **[OWNED]**' : canCraft ? '✅' : '❌';
                return `${status} **${r.emoji} ${r.name}**\n> ${r.description}\n> Requires: ${ingredientStr}`;
            });

            const mineLines = Object.values(MINE_RECIPES).map(r => {
                const ingredientStr = r.ingredients
                    .map(ing => `${ALL_MAT_NAMES[ing.material] ?? ing.material} ×${ing.qty}`)
                    .join(', ');
                const canCraft = r.ingredients.every(ing => getMat(ing.material) >= ing.qty);
                const status = canCraft ? '✅' : '❌';
                return `${status} **${r.emoji} ${r.name}**\n> ${r.description}\n> Requires: ${ingredientStr}`;
            });

            const embed = new EmbedBuilder()
                .setColor('#1abc9c')
                .setTitle('🔨 Crafting Recipes')
                .addFields(
                    { name: '🏹 Hunting Recipes', value: huntLines.join('\n\n') || 'None', inline: false },
                    { name: '⛏️ Mining Recipes',  value: mineLines.join('\n\n') || 'None', inline: false }
                )
                .setFooter({ text: '✅ = you can craft now  •  Use /craft make <recipe> to craft' });

            return interaction.reply({ embeds: [embed] });
        }

        // ── MAKE ───────────────────────────────────────────────────────────
        if (sub === 'make') {
            const recipeId = interaction.options.getString('recipe');
            const recipe   = ALL_RECIPES[recipeId];

            if (!recipe) {
                return interaction.reply({
                    content: 'Unknown recipe. Use `/craft list` to see available recipes.',
                    ephemeral: true
                });
            }

            // Unique upgrade guard (hunt)
            if (recipe.unique && recipe.output.id === 'luckyPaw' && h.luckyPaw) {
                return interaction.reply({
                    content: 'You already have the **🐾 Lucky Paw** upgrade!',
                    ephemeral: true
                });
            }

            // Stack limit guard for hunt consumables
            if (recipe.output.type === 'consumable') {
                const def          = HUNT_CONSUMABLES[recipe.output.id];
                const currentStock = h.consumables[recipe.output.id] ?? 0;
                if (def && currentStock + recipe.output.qty > def.maxStack) {
                    return interaction.reply({
                        content: `You can only hold **${def.maxStack}× ${def.name}** (you have ${currentStock}). ` +
                                 `Free up space before crafting more.`,
                        ephemeral: true
                    });
                }
            }

            // Stack limit guard for mine consumables
            if (recipe.output.type === 'mine_consumable') {
                const def          = MINE_CONSUMABLES[recipe.output.id];
                const currentStock = m.consumables[recipe.output.id] ?? 0;
                if (def && currentStock + recipe.output.qty > def.maxStack) {
                    return interaction.reply({
                        content: `You can only hold **${def.maxStack}× ${def.name}** (you have ${currentStock}). ` +
                                 `Free up space before crafting more.`,
                        ephemeral: true
                    });
                }
            }

            // Check ingredients across both material pools
            const missing = recipe.ingredients
                .filter(ing => getMat(ing.material) < ing.qty)
                .map(ing => `**${ALL_MAT_NAMES[ing.material] ?? ing.material}** (need ${ing.qty}, have ${getMat(ing.material)})`);

            if (missing.length) {
                return interaction.reply({
                    content: `You are missing the following materials:\n${missing.join('\n')}`,
                    ephemeral: true
                });
            }

            // Consume materials
            for (const ing of recipe.ingredients) {
                consumeMat(ing.material, ing.qty);
            }

            // Apply output
            let outputDesc = '';
            if (recipe.output.type === 'consumable') {
                h.consumables[recipe.output.id] = (h.consumables[recipe.output.id] ?? 0) + recipe.output.qty;
                const def = HUNT_CONSUMABLES[recipe.output.id];
                outputDesc = `${def?.emoji ?? '📦'} **${recipe.output.qty}× ${def?.name ?? recipe.output.id}**`;
            } else if (recipe.output.type === 'ammo') {
                h.ammo[recipe.output.id] = (h.ammo[recipe.output.id] ?? 0) + recipe.output.qty;
                outputDesc = `🔶 **${recipe.output.qty}× ${recipe.output.id.replace(/_/g, ' ')}** rounds`;
            } else if (recipe.output.type === 'permanent') {
                if (recipe.output.id === 'luckyPaw') {
                    h.luckyPaw = true;
                    outputDesc = '🐾 **Lucky Paw** — permanently +1% critical hit chance!';
                }
            } else if (recipe.output.type === 'mine_consumable') {
                // Guard: can't craft a mine_lock while one is already active
                if (recipe.output.id === 'mine_lock' && m.mineLockActive) {
                    return interaction.reply({
                        content: 'Your mine already has an active **Mine Lock**. Use it up before crafting another.',
                        ephemeral: true
                    });
                }
                m.consumables[recipe.output.id] = (m.consumables[recipe.output.id] ?? 0) + recipe.output.qty;
                const def = MINE_CONSUMABLES[recipe.output.id];
                outputDesc = `${def?.emoji ?? '📦'} **${recipe.output.qty}× ${def?.name ?? recipe.output.id}**`;
            } else if (recipe.output.type === 'mine_charge') {
                m.charges[recipe.output.id] = (m.charges[recipe.output.id] ?? 0) + recipe.output.qty;
                outputDesc = `💥 **${recipe.output.qty}× ${recipe.output.id.replace(/_/g, ' ')}** (mine charge)`;
            }

            user.markModified('hunt');
            user.markModified('mining');
            await user.save();

            const usedLines = recipe.ingredients.map(ing => {
                const remaining = getMat(ing.material);
                return `• ${ALL_MAT_NAMES[ing.material] ?? ing.material} ×${ing.qty}  (remaining: ${remaining})`;
            }).join('\n');

            const isMineRecipe = Object.hasOwn(MINE_RECIPES, recipeId);
            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${recipe.emoji} Crafted: ${recipe.name}`)
                .setDescription(`You crafted ${outputDesc}!`)
                .addFields({ name: 'Materials Consumed', value: usedLines, inline: false })
                .setFooter({ text: isMineRecipe ? 'Use /mine inv view to check mining stock' : 'Use /hunt inv materials to check your remaining stock' })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }
    }
};
