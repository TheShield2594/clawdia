const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } = require('discord.js');
const User    = require('../../models/User');
const AiItem  = require('../../models/AiItem');
const { attachGrind } = require('../../utils/grindProfile');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { pruneEffects, EFFECT_CONFIGS, timeRemaining } = require('../../services/effectsService');
const { MATERIAL_RARITY, TIER_LABELS, TIER_STARS, TIER_COLORS } = require('../../data/materialRarity');
const { getItemLore } = require('../../data/defaultShopItems');
const { getRelicMeta } = require('../../data/exploreData');
const { packFieldsCapped, EMBED_LIMITS } = require('../../utils/embedFields');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');

const TOTAL_MATERIALS = Object.keys(MATERIAL_RARITY).length;

// Characters the item sections may spend between them. An embed's ceiling is
// 6,000 across its title, description and every field — the second budget, the
// one a per-field cap does not protect: four sections spilling into two 1,024
// character fields each is 8,192 and a rejected embed, every field of which
// was individually legal. What is left over from this covers the title, the
// footer and the relic footnote.
const SECTIONS_BUDGET = 4_200;

const TAB_KEYS   = ['items', 'hunt', 'fish', 'mine', 'explore'];
const TAB_LABELS = { items: '🎒 Items', hunt: '⚔️ Hunt', fish: '🎣 Fish', mine: '⛏️ Mine', explore: '🧭 Explore' };

// Which pile each material's `source` is read from. This used to be a ternary
// chain ending in `: mineMats[key]`, so a fourth source would have counted its
// materials against the mining pile — silently, and only ever showing zero.
// Exploration became that fourth source with #753.
function pilesBySource(mats) {
    return { hunt: mats.hunt, fish: mats.fish, mine: mats.mine, explore: mats.explore };
}

/** How many of `key` the player holds, from whichever pile owns that source. */
function quantityOf(piles, key, data) {
    return piles[data.source]?.[key] ?? 0;
}

function highestRarityColor(mats, fallback) {
    const piles = pilesBySource(mats);
    let highest = 0;
    for (const [key, data] of Object.entries(MATERIAL_RARITY)) {
        if (quantityOf(piles, key, data) > 0 && data.tier > highest) highest = data.tier;
    }
    return highest > 0 ? TIER_COLORS[highest] : fallback;
}

function countOwned(mats) {
    const piles = pilesBySource(mats);
    let n = 0;
    for (const [key, data] of Object.entries(MATERIAL_RARITY)) {
        if (quantityOf(piles, key, data) > 0) n++;
    }
    return n;
}

function buildMaterialsEmbed(source, mats, color, footer, target, avatarURL) {
    const byTier = {};
    for (const [key, data] of Object.entries(MATERIAL_RARITY)) {
        if (data.source !== source) continue;
        const qty = mats[key] ?? 0;
        if (qty <= 0) continue;
        if (!byTier[data.tier]) byTier[data.tier] = [];
        byTier[data.tier].push({ data, qty });
    }

    const tiers = Object.keys(byTier).map(Number).sort((a, b) => b - a);
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`🎒 Inventory — ${target.username}`)
        .setThumbnail(avatarURL)
        .setFooter({ text: footer });

    if (tiers.length === 0) {
        embed.setDescription(`No ${source} materials yet.\nTry \`/${source}\` to find some!`);
        return embed;
    }

    const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━━';
    const sections = tiers.map(tier => {
        const items = byTier[tier];
        const header = `${divider}\n  ${TIER_STARS[tier]}  ${TIER_LABELS[tier]}\n${divider}`;
        const rows = [];
        for (let i = 0; i < items.length; i += 2) {
            rows.push(items.slice(i, i + 2).map(({ data, qty }) => `${data.emoji} ${data.label} ×${qty}`).join('    '));
        }
        return `${header}\n  ${rows.join('\n  ')}`;
    });

    embed.setDescription(sections.join('\n\n'));
    return embed;
}

function buildItemsEmbed(inventory, shopItems, activeEffects, currency, color, footer, target, avatarURL, aiItemMap = {}) {
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`🎒 Inventory — ${target.username}`)
        .setThumbnail(avatarURL)
        .setFooter({ text: footer });

    let hasContent = false;

    // The sections share one budget rather than each holding a fixed number of
    // fields, and take an even slice of whatever is left when their turn comes
    // — so a long shop list cannot starve the relics below it, while a player
    // who only has relics gets the whole allowance for them. Never less than
    // one field: a section that exists should be visible, even if only its
    // first few entries are.
    let budgetLeft = SECTIONS_BUDGET;
    // Counted up front, effects included, so the last section to be added is
    // still working from a share and not from whatever happens to be left.
    let sectionsLeft = activeEffects.length ? 1 : 0;

    /**
     * Add one packed section to the embed, and say how much of it did not fit.
     * Returns whether anything was added, for the sections that carry a
     * footnote of their own.
     */
    const addSection = (name, lines, noun) => {
        if (!lines.length) return false;

        const share = Math.max(0, budgetLeft) / Math.max(1, sectionsLeft);
        const { fields, omitted } = packFieldsCapped(name, lines, {
            maxFields: Math.max(1, Math.floor(share / EMBED_LIMITS.FIELD_VALUE)),
        });
        embed.addFields(...fields);
        budgetLeft  -= fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
        sectionsLeft = Math.max(0, sectionsLeft - 1);

        if (omitted > 0) {
            const note = {
                name: `${name} — and more`,
                value: `*${omitted} further ${noun}${omitted === 1 ? '' : 's'} not shown.*`,
                inline: false,
            };
            embed.addFields(note);
            budgetLeft -= note.name.length + note.value.length;
        }
        hasContent = true;
        return true;
    };

    if (inventory.length) {
        const shopLines  = [];
        const aiLines    = [];
        const relicLines = [];
        for (const entry of inventory) {
            const relic = getRelicMeta(entry.itemId);
            if (relic) {
                // Relics come out of /explore, not the shop — without their own
                // section they render as a bare name with no worth and no story.
                // The lore stays in `/explore relics`: 25 relics' worth of it
                // would blow the 1024-char field limit and take the embed down.
                relicLines.push(
                    `${relic.emoji} **${relic.itemId}**${entry.quantity > 1 ? ` ×${entry.quantity}` : ''} `
                    + `*(${relic.rarity} · ${relic.regionName} · ${currency}${relic.value.toLocaleString()})*`
                );
            } else if (entry.itemId.startsWith('ai_') && aiItemMap[entry.itemId]) {
                const ai = aiItemMap[entry.itemId];
                const rarityLine = ai.rarity ? ` *(${ai.rarity})*` : '';
                const loreLine   = ai.lore    ? `\n*${ai.lore}*`   : '';
                aiLines.push(`${ai.emoji ?? '✨'} **${ai.name}** ×${entry.quantity}${rarityLine}${loreLine}`);
            } else if (entry.itemId.startsWith('ai_')) {
                aiLines.push(`✨ *Unknown forged item* ×${entry.quantity} *(data missing)*`);
            } else {
                const shopItem = shopItems.find(s => s.name.toLowerCase() === entry.itemId.toLowerCase()
                                                  || (s.itemId && s.itemId.toLowerCase() === entry.itemId.toLowerCase()));
                const displayName = shopItem ? shopItem.name : entry.itemId;
                const worth    = shopItem ? ` (worth ${currency}${shopItem.price} each)` : '';
                const lore     = getItemLore(entry.itemId);
                const loreLine = lore ? `\n*${lore}*` : '';
                shopLines.push(`**${displayName}** ×${entry.quantity}${worth}${loreLine}`);
            }
        }
        // Every one of these grows with what the player owns, and shop and
        // forged items each carry a lore line on top of the entry — so an
        // inventory does not have to be remarkable before one joined field is
        // past 1,024 characters and discord.js throws the whole embed out.
        // Relics were packed and these two were not, which is the same bug
        // waiting in the section next to the fix.
        sectionsLeft += [shopLines, aiLines, relicLines].filter(l => l.length).length;
        addSection('🛍️ Shop Items',   shopLines,  'shop item');
        addSection('⚒️ Forged Items', aiLines,    'forged item');
        // A full collection is 25 relics — well past one field's budget.
        if (addSection('🏺 Relics', relicLines, 'relic')) {
            embed.addFields({
                name: '​',
                value: '*Every distinct relic pays a standing bonus on exploration coins — see `/explore relics`.*',
                inline: false,
            });
        }
    }

    if (activeEffects.length) {
        const lines = activeEffects.map(e => {
            const cfg = EFFECT_CONFIGS[e.type];
            if (!cfg) return null;
            const durationStr = e.expiresAt
                ? `⏳ ${timeRemaining(e.expiresAt)} remaining`
                : e.charges > 0
                    ? `${e.charges} use${e.charges !== 1 ? 's' : ''} left`
                    : 'permanent';
            return `${cfg.emoji} **${cfg.label}** — ${durationStr}`;
        }).filter(Boolean);

        addSection('✨ Active Effects', lines, 'active effect');
    }

    if (!hasContent) {
        embed.setDescription('No items yet.\nBuy items from the `/shop`!');
    }

    return embed;
}

function buildTabRow(active, interactionId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        TAB_KEYS.map(key =>
            new ButtonBuilder()
                .setCustomId(`inv_${key}_${interactionId}`)
                .setLabel(TAB_LABELS[key])
                .setStyle(key === active ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(disabled || key === active)
        )
    );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('inventory')
        .setDescription("View your or another user's inventory")
        .addUserOption(o => o.setName('user').setDescription('User to inspect')),

    async execute(interaction) {
        const target = interaction.options.getUser('user') ?? interaction.user;

        const [userData, guildSettings] = await Promise.all([
            User.findOne({ userId: target.id, guildId: interaction.guild.id }),
            getGuildSettings(interaction.guild.id)
        ]);
        await attachGrind(userData);

        const currency = guildSettings?.economy?.currency ?? '💰';
        // Read-only: prune expired effects in memory for display only, no save performed.
        // Matches the pattern in /balance, /rank, and /profile.
        if (userData) pruneEffects(userData);

        // Keyed by MATERIAL_RARITY `source`, not by the profile name that holds
        // it, so a new source is one entry here and one tab below.
        const mats = {
            hunt:    userData?.hunt?.materials        ?? {},
            fish:    userData?.fishing?.materials     ?? {},
            mine:    userData?.mining?.materials      ?? {},
            explore: userData?.exploration?.materials ?? {},
        };
        const inventory   = userData?.inventory          ?? [];
        const activeEffects = userData?.activeEffects    ?? [];
        const shopItems   = guildSettings?.shop          ?? [];

        // Load AI item definitions for items starting with "ai_"
        const aiItemIds = inventory.filter(i => i.itemId.startsWith('ai_')).map(i => i.itemId);
        let aiItemDocs = [];
        try {
            if (aiItemIds.length) {
                aiItemDocs = await AiItem.find({ itemId: { $in: aiItemIds } }).lean();
            }
        } catch (err) {
            console.error('[INVENTORY] AiItem lookup failed:', err?.message || err);
            // Degrade gracefully: ai_ items will show as orphaned
        }
        const aiItemMap = Object.fromEntries(aiItemDocs.map(d => [d.itemId, d]));

        const hasItems = inventory.length > 0 || activeEffects.length > 0;
        const hasMaterials = countOwned(mats) > 0;

        if (!hasItems && !hasMaterials) {
            const emptyEmbed = new EmbedBuilder()
                .setColor(COLORS.NEUTRAL)
                .setTitle('🎒 Inventory — Empty')
                .setDescription('Nothing here yet.\nTry `/hunt`, `/fish`, `/mine`, or `/explore` to find materials.')
                .setThumbnail(target.displayAvatarURL({ dynamic: true }));
            return interaction.reply({ embeds: [emptyEmbed], flags: MessageFlags.Ephemeral });
        }

        const color    = highestRarityColor(mats, hasItems ? '#5865F2' : '#9e9e9e');
        const owned    = countOwned(mats);
        const footer   = `Collection: ${owned} / ${TOTAL_MATERIALS} materials found`;
        const avatarURL = target.displayAvatarURL({ dynamic: true });

        const embeds = {
            items: buildItemsEmbed(inventory, shopItems, activeEffects, currency, color, footer, target, avatarURL, aiItemMap),
            hunt:    buildMaterialsEmbed('hunt',    mats.hunt,    color, footer, target, avatarURL),
            fish:    buildMaterialsEmbed('fish',    mats.fish,    color, footer, target, avatarURL),
            mine:    buildMaterialsEmbed('mine',    mats.mine,    color, footer, target, avatarURL),
            explore: buildMaterialsEmbed('explore', mats.explore, color, footer, target, avatarURL),
        };

        let activeTab = 'items';
        const message = await interaction.reply({
            embeds: [embeds[activeTab]],
            components: [buildTabRow(activeTab, interaction.id)],
            fetchReply: true
        });

        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: ownedBy(
                interaction.user.id,
                btn => TAB_KEYS.some(k => btn.customId === `inv_${k}_${interaction.id}`),
                "This isn't your inventory — run `/inventory` for your own.",
            ),
            time: 120_000
        });

        collector.on('collect', async btn => {
            activeTab = btn.customId.split('_')[1];
            await btn.update({
                embeds: [embeds[activeTab]],
                components: [buildTabRow(activeTab, interaction.id)]
            });
        });

        collector.on('end', async () => {
            await interaction.editReply({
                components: [buildTabRow(activeTab, interaction.id, true)]
            }).catch(() => {});
        });
    },

    __test__: { buildItemsEmbed },
};
