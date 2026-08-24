'use strict';

// /fish craft — recipes, and spending materials (fishing and hunting alike) on
// one.

const Guild = require('../../../models/Guild');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { ensureFishingData } = require('../../../services/fishService');
const { ensureHuntData } = require('../../../services/huntService');
const { FISH_CRAFT_RECIPES, CONSUMABLES, MATERIAL_NAMES } = require('../../../data/fishData');
const { MATERIAL_NAMES: HUNT_MATERIAL_NAMES } = require('../../../data/huntData');
const COLORS = require('../../../utils/embedColors');

// ═══════════════════════════════════════════════════════════════════════════════
// CRAFT
// ═══════════════════════════════════════════════════════════════════════════════

async function handleCraft(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureFishingData(user);
    ensureHuntData(user);
    const f = user.fishing;
    const h = user.hunt;

    if (sub === 'list') {
        const lines = Object.values(FISH_CRAFT_RECIPES).map(r => {
            const ingredientStr = r.ingredients
                .map(ing => {
                    const name = getCraftMaterialName(ing.material, ing.source);
                    const tag  = ing.source === 'hunt' ? ' *(hunt)*' : '';
                    return `${name}${tag} ×${ing.qty}`;
                })
                .join(', ');

            const canCraft = r.ingredients.every(ing =>
                getCraftMaterialStock(ing.material, ing.source, h, f) >= ing.qty
            );
            const uniqueDone = r.unique && r.output.id === 'luckyHook' && f.luckyHook;
            const status = uniqueDone ? '✅ **[OWNED]**' : canCraft ? '✅' : '❌';

            return `${status} **${r.emoji} ${r.name}**\n> ${r.description}\n> Requires: ${ingredientStr}`;
        });

        const embed = new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle('🎣 Fishing Crafting Recipes')
            .setDescription(lines.join('\n\n'))
            .setFooter({ text: '✅ = you can craft now  •  Use /fish craft make <recipe> to craft  •  /fish inv materials to check stock' });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'make') {
        const recipeId = interaction.options.getString('recipe');
        const recipe   = FISH_CRAFT_RECIPES[recipeId];

        if (!recipe) {
            return interaction.reply({
                content: 'Unknown recipe. Use `/fish craft list` to see available recipes.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (recipe.unique && recipe.output.id === 'luckyHook' && f.luckyHook) {
            return interaction.reply({
                content: 'You already have the **🎣 Lucky Hook** upgrade!',
                flags: MessageFlags.Ephemeral
            });
        }

        if (recipe.output.type === 'consumable' || recipe.output.type === 'dual_stamina') {
            const def          = CONSUMABLES[recipe.output.id];
            const currentStock = f.consumables[recipe.output.id] ?? 0;
            const qty          = recipe.output.qty ?? 1;
            if (def && currentStock + qty > def.maxStack) {
                return interaction.reply({
                    content: `You can only hold **${def.maxStack}× ${def.name}** (you have ${currentStock}). ` +
                             `Free up space before crafting more.`,
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        const missing = recipe.ingredients
            .filter(ing => getCraftMaterialStock(ing.material, ing.source, h, f) < ing.qty)
            .map(ing => {
                const have = getCraftMaterialStock(ing.material, ing.source, h, f);
                const name = getCraftMaterialName(ing.material, ing.source);
                const tag  = ing.source === 'hunt' ? ' (hunt material)' : '';
                return `**${name}${tag}** (need ${ing.qty}, have ${have})`;
            });

        if (missing.length) {
            return interaction.reply({
                content: `You are missing the following materials:\n${missing.join('\n')}`,
                flags: MessageFlags.Ephemeral
            });
        }

        for (const ing of recipe.ingredients) {
            if (ing.source === 'hunt') {
                h.materials[ing.material] -= ing.qty;
            } else {
                f.materials[ing.material] -= ing.qty;
            }
        }

        let outputDesc = '';
        if (recipe.output.type === 'consumable') {
            const qty = recipe.output.qty ?? 1;
            f.consumables[recipe.output.id] = (f.consumables[recipe.output.id] ?? 0) + qty;
            const def = CONSUMABLES[recipe.output.id];
            outputDesc = `${def?.emoji ?? '📦'} **${qty}× ${def?.name ?? recipe.output.id}**`;
        } else if (recipe.output.type === 'dual_stamina') {
            const qty = recipe.output.qty ?? 1;
            f.consumables[recipe.output.id] = (f.consumables[recipe.output.id] ?? 0) + qty;
            const def = CONSUMABLES[recipe.output.id];
            outputDesc = `${def?.emoji ?? '⚗️'} **${qty}× ${def?.name ?? recipe.output.id}** — use with \`/use\` to restore stamina in both systems`;
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
            const remaining = getCraftMaterialStock(ing.material, ing.source, h, f);
            const name      = getCraftMaterialName(ing.material, ing.source);
            const tag       = ing.source === 'hunt' ? ' *(hunt)*' : '';
            return `• ${name}${tag} ×${ing.qty}  (remaining: ${remaining})`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setColor(COLORS.SUCCESS)
            .setTitle(`${recipe.emoji} Crafted: ${recipe.name}`)
            .setDescription(`You crafted ${outputDesc}!`)
            .addFields({ name: 'Materials Consumed', value: usedLines, inline: false })
            .setFooter({ text: 'Use /fish inv materials to check your remaining stock' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }
}

function getCraftMaterialName(materialId, source) {
    if (source === 'hunt') return HUNT_MATERIAL_NAMES[materialId] ?? materialId;
    return MATERIAL_NAMES[materialId] ?? materialId;
}

function getCraftMaterialStock(materialId, source, h, f) {
    if (source === 'hunt') return h.materials[materialId] ?? 0;
    return f.materials[materialId] ?? 0;
}

module.exports = {
    getCraftMaterialName,
    getCraftMaterialStock,
    handleCraft,
};
