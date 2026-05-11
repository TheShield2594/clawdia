'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { FISH_CRAFT_RECIPES, CONSUMABLES, MATERIAL_NAMES } = require('../../data/fishData');
const { MATERIAL_NAMES: HUNT_MATERIAL_NAMES }              = require('../../data/huntData');
const { ensureFishingData } = require('../../services/fishService');
const { ensureHuntData }    = require('../../services/huntService');

const RECIPE_CHOICES = Object.values(FISH_CRAFT_RECIPES).map(r => ({ name: r.name, value: r.id }));

function getMaterialName(materialId, source) {
    if (source === 'hunt') return HUNT_MATERIAL_NAMES[materialId] ?? materialId;
    return MATERIAL_NAMES[materialId] ?? materialId;
}

function getMaterialStock(materialId, source, h, f) {
    if (source === 'hunt') return h.materials[materialId] ?? 0;
    return f.materials[materialId] ?? 0;
}

module.exports = {
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('fishcraft')
        .setDescription('Craft items from fishing (and hunting) materials')
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Browse all available fishing crafting recipes'))
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
        ensureFishingData(user);
        ensureHuntData(user);
        const f = user.fishing;
        const h = user.hunt;

        // ── LIST ───────────────────────────────────────────────────────────
        if (sub === 'list') {
            const lines = Object.values(FISH_CRAFT_RECIPES).map(r => {
                const ingredientStr = r.ingredients
                    .map(ing => {
                        const name = getMaterialName(ing.material, ing.source);
                        const tag  = ing.source === 'hunt' ? ' *(hunt)*' : '';
                        return `${name}${tag} ×${ing.qty}`;
                    })
                    .join(', ');

                const canCraft = r.ingredients.every(ing =>
                    getMaterialStock(ing.material, ing.source, h, f) >= ing.qty
                );
                const uniqueDone = r.unique && r.output.id === 'luckyHook' && f.luckyHook;
                const status = uniqueDone ? '✅ **[OWNED]**' : canCraft ? '✅' : '❌';

                return `${status} **${r.emoji} ${r.name}**\n> ${r.description}\n> Requires: ${ingredientStr}`;
            });

            const embed = new EmbedBuilder()
                .setColor('#3498db')
                .setTitle('🎣 Fishing Crafting Recipes')
                .setDescription(lines.join('\n\n'))
                .setFooter({ text: '✅ = you can craft now  •  Use /fishcraft make <recipe> to craft  •  /fishinv materials to check stock' });

            return interaction.reply({ embeds: [embed] });
        }

        // ── MAKE ───────────────────────────────────────────────────────────
        if (sub === 'make') {
            const recipeId = interaction.options.getString('recipe');
            const recipe   = FISH_CRAFT_RECIPES[recipeId];

            if (!recipe) {
                return interaction.reply({
                    content: 'Unknown recipe. Use `/fishcraft list` to see available recipes.',
                    ephemeral: true
                });
            }

            // Unique upgrade guard
            if (recipe.unique && recipe.output.id === 'luckyHook' && f.luckyHook) {
                return interaction.reply({
                    content: 'You already have the **🎣 Lucky Hook** upgrade!',
                    ephemeral: true
                });
            }

            // Stack limit guard for consumables and dual_stamina
            if (recipe.output.type === 'consumable' || recipe.output.type === 'dual_stamina') {
                const def          = CONSUMABLES[recipe.output.id];
                const currentStock = f.consumables[recipe.output.id] ?? 0;
                const qty          = recipe.output.qty ?? 1;
                if (def && currentStock + qty > def.maxStack) {
                    return interaction.reply({
                        content: `You can only hold **${def.maxStack}× ${def.name}** (you have ${currentStock}). ` +
                                 `Free up space before crafting more.`,
                        ephemeral: true
                    });
                }
            }

            // Check ingredients (cross-system aware)
            const missing = recipe.ingredients
                .filter(ing => getMaterialStock(ing.material, ing.source, h, f) < ing.qty)
                .map(ing => {
                    const have = getMaterialStock(ing.material, ing.source, h, f);
                    const name = getMaterialName(ing.material, ing.source);
                    const tag  = ing.source === 'hunt' ? ' (hunt material)' : '';
                    return `**${name}${tag}** (need ${ing.qty}, have ${have})`;
                });

            if (missing.length) {
                return interaction.reply({
                    content: `You are missing the following materials:\n${missing.join('\n')}`,
                    ephemeral: true
                });
            }

            // Consume materials (cross-system aware)
            for (const ing of recipe.ingredients) {
                if (ing.source === 'hunt') {
                    h.materials[ing.material] -= ing.qty;
                } else {
                    f.materials[ing.material] -= ing.qty;
                }
            }

            // Apply output
            let outputDesc = '';
            if (recipe.output.type === 'consumable') {
                const qty = recipe.output.qty ?? 1;
                f.consumables[recipe.output.id] = (f.consumables[recipe.output.id] ?? 0) + qty;
                const def = CONSUMABLES[recipe.output.id];
                outputDesc = `${def?.emoji ?? '📦'} **${qty}× ${def?.name ?? recipe.output.id}**`;
            } else if (recipe.output.type === 'dual_stamina') {
                const qty = recipe.output.qty ?? 1;
                f.consumables[recipe.output.id] = (f.consumables[recipe.output.id] ?? 0) + qty;
                outputDesc = `⚗️ **${qty}× Hunter's Brew** — use with \`/fishuse\` to restore stamina in both systems`;
            } else if (recipe.output.type === 'permanent') {
                if (recipe.output.id === 'luckyHook') {
                    f.luckyHook = true;
                    outputDesc = '🎣 **Lucky Hook** — permanently +1% critical catch chance!';
                }
            }

            const huntModified = recipe.ingredients.some(ing => ing.source === 'hunt');
            if (huntModified) user.markModified('hunt');
            user.markModified('fishing');
            await user.save();

            const usedLines = recipe.ingredients.map(ing => {
                const remaining = getMaterialStock(ing.material, ing.source, h, f);
                const name      = getMaterialName(ing.material, ing.source);
                const tag       = ing.source === 'hunt' ? ' *(hunt)*' : '';
                return `• ${name}${tag} ×${ing.qty}  (remaining: ${remaining})`;
            }).join('\n');

            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${recipe.emoji} Crafted: ${recipe.name}`)
                .setDescription(`You crafted ${outputDesc}!`)
                .addFields({ name: 'Materials Consumed', value: usedLines, inline: false })
                .setFooter({ text: 'Use /fishinv materials to check your remaining stock' })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }
    }
};
