'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const { attachGrind } = require('../../utils/grindProfile');
const Guild = require('../../models/Guild');
const { CRAFT_RECIPES: HUNT_RECIPES, CONSUMABLES: HUNT_CONSUMABLES, MATERIAL_NAMES: HUNT_MAT_NAMES } = require('../../data/huntData');
const { CRAFT_RECIPES: MINE_RECIPES, CONSUMABLES: MINE_CONSUMABLES, MATERIAL_NAMES: MINE_MAT_NAMES } = require('../../data/mineData');
const { FISH_CRAFT_RECIPES, CONSUMABLES: FISH_CONSUMABLES, MATERIAL_NAMES: FISH_MAT_NAMES } = require('../../data/fishData');
const { CROSS_CRAFT_RECIPES, CROSS_CONSUMABLES } = require('../../data/crossSystemData');
const { ensureHuntData } = require('../../services/huntService');
const { ensureMineData } = require('../../services/mineService');
const { ensureFishingData } = require('../../services/fishService');

const ALL_RECIPES   = { ...HUNT_RECIPES, ...MINE_RECIPES, ...FISH_CRAFT_RECIPES, ...CROSS_CRAFT_RECIPES };
const ALL_MAT_NAMES = { ...HUNT_MAT_NAMES, ...MINE_MAT_NAMES, ...FISH_MAT_NAMES };
const RECIPE_LIST = Object.values(ALL_RECIPES).map(r => ({ name: r.name, value: r.id }));

module.exports = {
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('craft')
        .setDescription('Craft items from hunting, fishing, or mining materials')
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
                        .setAutocomplete(true))),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused()?.toLowerCase() ?? '';
        const matches = focused
            ? RECIPE_LIST.filter(r =>
                r.name.toLowerCase().includes(focused) ||
                r.value.toLowerCase().includes(focused))
            : RECIPE_LIST;
        await interaction.respond(matches.slice(0, 25));
    },

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
        await attachGrind(user);
        ensureHuntData(user);
        ensureMineData(user);
        ensureFishingData(user);
        const h = user.hunt;
        const m = user.mining;
        const f = user.fishing;

        // Get material quantity from the correct pool (source-aware)
        function getMat(matId, source) {
            if (source === 'hunt')  return h.materials[matId] ?? 0;
            if (source === 'mine')  return m.materials[matId] ?? 0;
            if (source === 'fish')  return f.materials[matId] ?? 0;
            // No source: check hunt then mine then fish
            return (h.materials[matId] ?? 0) + (m.materials[matId] ?? 0) + (f.materials[matId] ?? 0);
        }

        // Consume materials from the correct pool.
        // When `source` is provided (all cross-system recipes), materials are drawn
        // exclusively from that pool.  When absent (legacy hunt/mine recipes that
        // predate source annotations), we drain hunt first, then mine, then fish so
        // the behaviour stays compatible with those existing recipes.
        function consumeMat(matId, qty, source) {
            if (source === 'hunt') {
                h.materials[matId] = Math.max(0, (h.materials[matId] ?? 0) - qty);
                return;
            }
            if (source === 'mine') {
                m.materials[matId] = Math.max(0, (m.materials[matId] ?? 0) - qty);
                return;
            }
            if (source === 'fish') {
                f.materials[matId] = Math.max(0, (f.materials[matId] ?? 0) - qty);
                return;
            }
            // No source: drain hunt first, then mine, then fish
            const fromHunt = Math.min(h.materials[matId] ?? 0, qty);
            h.materials[matId] = (h.materials[matId] ?? 0) - fromHunt;
            qty -= fromHunt;
            if (qty > 0) {
                const fromMine = Math.min(m.materials[matId] ?? 0, qty);
                m.materials[matId] = (m.materials[matId] ?? 0) - fromMine;
                qty -= fromMine;
            }
            if (qty > 0) {
                f.materials[matId] = Math.max(0, (f.materials[matId] ?? 0) - qty);
            }
        }

        function matLabel(ing) {
            return ALL_MAT_NAMES[ing.material] ?? ing.material;
        }

        // ── LIST ────────────────────────────────────────────────────────────
        if (sub === 'list') {
            function recipeLines(recipes, ownedChecks = {}) {
                return Object.values(recipes).map(r => {
                    const ingredientStr = r.ingredients
                        .map(ing => `${matLabel(ing)} ×${ing.qty}${ing.source ? ` *(${ing.source})*` : ''}`)
                        .join(', ');
                    const canCraft = r.ingredients.every(ing => getMat(ing.material, ing.source) >= ing.qty);
                    const ownedId  = r.output?.id;
                    const isOwned  = r.unique && ownedChecks[ownedId];
                    const status   = isOwned ? '✅ **[OWNED]**' : canCraft ? '✅' : '❌';
                    return `${status} **${r.emoji} ${r.name}**\n> ${r.description}\n> Requires: ${ingredientStr}`;
                });
            }

            // Discord embed field values must be 1..1024 chars. Split a category's
            // lines across multiple same-named fields rather than overflowing one.
            const FIELD_LIMIT = 1024;
            function buildFields(name, lines) {
                if (!lines.length) return [{ name, value: 'None', inline: false }];
                const fields = [];
                let chunk = '';
                for (const line of lines) {
                    const candidate = chunk ? `${chunk}\n\n${line}` : line;
                    if (candidate.length > FIELD_LIMIT) {
                        if (chunk) fields.push(chunk);
                        chunk = line.length > FIELD_LIMIT ? line.slice(0, FIELD_LIMIT - 1) + '…' : line;
                    } else {
                        chunk = candidate;
                    }
                }
                if (chunk) fields.push(chunk);
                return fields.map((value, i) => ({
                    name: i === 0 ? name : `${name} (cont.)`,
                    value,
                    inline: false
                }));
            }

            const huntLines  = recipeLines(HUNT_RECIPES,  { luckyPaw: h.luckyPaw });
            const mineLines  = recipeLines(MINE_RECIPES);
            const fishLines  = recipeLines(FISH_CRAFT_RECIPES, { luckyHook: f.luckyHook });
            const crossLines = recipeLines(CROSS_CRAFT_RECIPES, { precisionScope: h.precisionScope });

            const fields = [
                ...buildFields('🏹 Hunting Recipes', huntLines),
                ...buildFields('⛏️ Mining Recipes', mineLines),
                ...buildFields('🎣 Fishing Recipes', fishLines),
                ...buildFields('🔗 Cross-System Recipes', crossLines)
            ].slice(0, 25);

            const embed = new EmbedBuilder()
                .setColor('#1abc9c')
                .setTitle('🔨 Crafting Recipes')
                .addFields(...fields)
                .setFooter({ text: '✅ = can craft now  •  /craft make <recipe>' });

            return interaction.reply({ embeds: [embed] });
        }

        // ── MAKE ────────────────────────────────────────────────────────────
        if (sub === 'make') {
            const recipeId = interaction.options.getString('recipe');
            const recipe   = ALL_RECIPES[recipeId];

            if (!recipe) {
                return interaction.reply({
                    content: 'Unknown recipe. Use `/craft list` to see available recipes.',
                    ephemeral: true
                });
            }

            // Unique guard
            if (recipe.unique) {
                if (recipe.output.id === 'luckyPaw'       && h.luckyPaw)       return interaction.reply({ content: 'You already have the **🐾 Lucky Paw** upgrade!',       ephemeral: true });
                if (recipe.output.id === 'luckyHook'      && f.luckyHook)      return interaction.reply({ content: 'You already have the **🎣 Lucky Hook** upgrade!',      ephemeral: true });
                if (recipe.output.id === 'precisionScope' && h.precisionScope) return interaction.reply({ content: 'You already have the **🔭 Precision Scope** upgrade!', ephemeral: true });
            }

            // Stack limit guards
            if (recipe.output.type === 'consumable') {
                const def = HUNT_CONSUMABLES[recipe.output.id];
                const cur = h.consumables[recipe.output.id] ?? 0;
                if (def && cur + recipe.output.qty > def.maxStack) {
                    return interaction.reply({ content: `You can only hold **${def.maxStack}× ${def.name}** (have ${cur}).`, ephemeral: true });
                }
            }
            if (recipe.output.type === 'mine_consumable') {
                const def = MINE_CONSUMABLES[recipe.output.id];
                const cur = m.consumables[recipe.output.id] ?? 0;
                if (def && cur + recipe.output.qty > def.maxStack) {
                    return interaction.reply({ content: `You can only hold **${def.maxStack}× ${def.name}** (have ${cur}).`, ephemeral: true });
                }
            }
            if (recipe.output.type === 'fish_consumable' || recipe.output.type === 'dual_stamina') {
                const def = FISH_CONSUMABLES[recipe.output.id] ?? CROSS_CONSUMABLES[recipe.output.id];
                const cur = f.consumables[recipe.output.id] ?? 0;
                if (def?.maxStack && cur + recipe.output.qty > def.maxStack) {
                    return interaction.reply({ content: `You can only hold **${def.maxStack}× ${def.name}** (have ${cur}).`, ephemeral: true });
                }
            }
            if (recipe.output.type === 'mine_immunity') {
                const def = CROSS_CONSUMABLES[recipe.output.id];
                const cur = m.consumables[recipe.output.id] ?? 0;
                if (def?.maxStack && cur + recipe.output.qty > def.maxStack) {
                    return interaction.reply({ content: `You can only hold **${def.maxStack}× ${def.name}** (have ${cur}).`, ephemeral: true });
                }
            }

            // Check ingredients
            const missing = recipe.ingredients
                .filter(ing => getMat(ing.material, ing.source) < ing.qty)
                .map(ing => `**${matLabel(ing)}** (need ${ing.qty}, have ${getMat(ing.material, ing.source)})`);
            if (missing.length) {
                return interaction.reply({
                    content: `You are missing the following materials:\n${missing.join('\n')}`,
                    ephemeral: true
                });
            }

            // Consume materials
            for (const ing of recipe.ingredients) {
                consumeMat(ing.material, ing.qty, ing.source);
            }

            // Apply output
            let outputDesc = '';
            const out = recipe.output;

            if (out.type === 'consumable') {
                h.consumables[out.id] = (h.consumables[out.id] ?? 0) + out.qty;
                const def = HUNT_CONSUMABLES[out.id];
                outputDesc = `${def?.emoji ?? '📦'} **${out.qty}× ${def?.name ?? out.id}**`;

            } else if (out.type === 'ammo') {
                h.ammo[out.id] = (h.ammo[out.id] ?? 0) + out.qty;
                outputDesc = `🔶 **${out.qty}× ${out.id.replace(/_/g, ' ')}** rounds`;

            } else if (out.type === 'permanent') {
                if (out.id === 'luckyPaw') {
                    h.luckyPaw = true;
                    outputDesc = '🐾 **Lucky Paw** — permanently +1% critical hit chance!';
                }

            } else if (out.type === 'hunt_permanent') {
                if (out.id === 'precisionScope') {
                    h.precisionScope = true;
                    outputDesc = '🔭 **Precision Scope** — permanently +2% rarity boost on all hunts!';
                }

            } else if (out.type === 'mine_consumable') {
                if (out.id === 'mine_lock' && m.mineLockActive) {
                    return interaction.reply({ content: 'Your mine already has an active **Mine Lock**.', ephemeral: true });
                }
                m.consumables[out.id] = (m.consumables[out.id] ?? 0) + out.qty;
                const def = MINE_CONSUMABLES[out.id];
                outputDesc = `${def?.emoji ?? '📦'} **${out.qty}× ${def?.name ?? out.id}**`;

            } else if (out.type === 'mine_charge') {
                m.charges[out.id] = (m.charges[out.id] ?? 0) + out.qty;
                outputDesc = `💥 **${out.qty}× ${out.id.replace(/_/g, ' ')}** (mine charge)`;

            } else if (out.type === 'mine_immunity') {
                m.consumables[out.id] = (m.consumables[out.id] ?? 0) + out.qty;
                const def = CROSS_CONSUMABLES[out.id];
                outputDesc = `${def?.emoji ?? '🪤'} **${out.qty}× ${def?.name ?? out.id}**`;

            } else if (out.type === 'fish_consumable') {
                f.consumables[out.id] = (f.consumables[out.id] ?? 0) + out.qty;
                const def = FISH_CONSUMABLES[out.id] ?? CROSS_CONSUMABLES[out.id];
                outputDesc = `${def?.emoji ?? '📦'} **${out.qty}× ${def?.name ?? out.id}**`;

            } else if (out.type === 'dual_stamina') {
                f.consumables[out.id] = (f.consumables[out.id] ?? 0) + out.qty;
                const def = FISH_CONSUMABLES[out.id];
                outputDesc = `${def?.emoji ?? '⚗️'} **${out.qty}× ${def?.name ?? out.id}** (restores stamina in fishing AND hunting)`;

            } else if (out.type === 'fish_permanent') {
                if (out.id === 'luckyHook') {
                    f.luckyHook = true;
                    outputDesc = '🎣 **Lucky Hook** — permanently +1% critical catch chance!';
                }
            }

            user.markModified('hunt');
            user.markModified('mining');
            user.markModified('fishing');
            await user.save();

            const usedLines = recipe.ingredients.map(ing => {
                const remaining = getMat(ing.material, ing.source);
                const srcLabel  = ing.source ? ` *(${ing.source})*` : '';
                return `• ${matLabel(ing)}${srcLabel} ×${ing.qty}  (remaining: ${remaining})`;
            }).join('\n');

            const isCross = Object.hasOwn(CROSS_CRAFT_RECIPES, recipeId);
            const isFish  = Object.hasOwn(FISH_CRAFT_RECIPES, recipeId);
            const isMine  = Object.hasOwn(MINE_RECIPES, recipeId);
            const footer  = isCross ? 'Cross-system item — check /fish inv or /mine inv to use it'
                          : isFish  ? 'Use /fish inv to view your fishing stock'
                          : isMine  ? 'Use /mine inv view to check mining stock'
                          : 'Use /hunt inv materials to check your remaining stock';

            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${recipe.emoji} Crafted: ${recipe.name}`)
                .setDescription(`You crafted ${outputDesc}!`)
                .addFields({ name: 'Materials Consumed', value: usedLines, inline: false })
                .setFooter({ text: footer })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }
    }
};
