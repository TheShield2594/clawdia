const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { pruneEffects, EFFECT_CONFIGS, timeRemaining } = require('../../services/effectsService');
const { MATERIAL_RARITY, TIER_LABELS, TIER_STARS, TIER_COLORS } = require('../../data/materialRarity');
const { getItemLore } = require('../../data/defaultShopItems');

const TOTAL_MATERIALS = Object.keys(MATERIAL_RARITY).length;

const TAB_KEYS   = ['items', 'hunt', 'fish', 'mine'];
const TAB_LABELS = { items: '🎒 Items', hunt: '⚔️ Hunt', fish: '🎣 Fish', mine: '⛏️ Mine' };

function highestRarityColor(huntMats, fishMats, mineMats, fallback) {
    let highest = 0;
    for (const [key, data] of Object.entries(MATERIAL_RARITY)) {
        const qty = data.source === 'hunt' ? huntMats[key]
                  : data.source === 'fish' ? fishMats[key]
                  : mineMats[key];
        if ((qty ?? 0) > 0 && data.tier > highest) highest = data.tier;
    }
    return highest > 0 ? TIER_COLORS[highest] : fallback;
}

function countOwned(huntMats, fishMats, mineMats) {
    let n = 0;
    for (const [key, data] of Object.entries(MATERIAL_RARITY)) {
        const qty = data.source === 'hunt' ? huntMats[key]
                  : data.source === 'fish' ? fishMats[key]
                  : mineMats[key];
        if ((qty ?? 0) > 0) n++;
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

function buildItemsEmbed(inventory, shopItems, activeEffects, currency, color, footer, target, avatarURL) {
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`🎒 Inventory — ${target.username}`)
        .setThumbnail(avatarURL)
        .setFooter({ text: footer });

    let hasContent = false;

    if (inventory.length) {
        const lines = inventory.map(entry => {
            const shopItem = shopItems.find(s => s.name.toLowerCase() === entry.itemId.toLowerCase()
                                              || (s.itemId && s.itemId.toLowerCase() === entry.itemId.toLowerCase()));
            const worth = shopItem ? ` (worth ${currency}${shopItem.price} each)` : '';
            const lore = getItemLore(entry.itemId);
            const loreLine = lore ? `\n*${lore}*` : '';
            return `**${entry.itemId}** ×${entry.quantity}${worth}${loreLine}`;
        });
        embed.addFields({ name: '🛍️ Shop Items', value: lines.join('\n'), inline: false });
        hasContent = true;
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

        if (lines.length) {
            embed.addFields({ name: '✨ Active Effects', value: lines.join('\n'), inline: false });
            hasContent = true;
        }
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
            Guild.findOne({ guildId: interaction.guild.id })
        ]);

        const currency = guildSettings?.economy?.currency ?? '💰';
        // Read-only: prune expired effects in memory for display only, no save performed.
        // Matches the pattern in /balance, /rank, and /profile.
        if (userData) pruneEffects(userData);

        const huntMats    = userData?.hunt?.materials    ?? {};
        const fishMats    = userData?.fishing?.materials ?? {};
        const mineMats    = userData?.mining?.materials  ?? {};
        const inventory   = userData?.inventory          ?? [];
        const activeEffects = userData?.activeEffects    ?? [];
        const shopItems   = guildSettings?.shop          ?? [];

        const hasItems = inventory.length > 0 || activeEffects.length > 0;
        const hasMaterials = Object.entries(MATERIAL_RARITY).some(([key, data]) => {
            const qty = data.source === 'hunt' ? huntMats[key]
                      : data.source === 'fish' ? fishMats[key]
                      : mineMats[key];
            return (qty ?? 0) > 0;
        });

        if (!hasItems && !hasMaterials) {
            const emptyEmbed = new EmbedBuilder()
                .setColor('#9e9e9e')
                .setTitle('🎒 Inventory — Empty')
                .setDescription('Nothing here yet.\nTry `/hunt`, `/fish`, or `/mine` to find materials.')
                .setThumbnail(target.displayAvatarURL({ dynamic: true }));
            return interaction.reply({ embeds: [emptyEmbed], ephemeral: true });
        }

        const color    = highestRarityColor(huntMats, fishMats, mineMats, hasItems ? '#5865F2' : '#9e9e9e');
        const owned    = countOwned(huntMats, fishMats, mineMats);
        const footer   = `Collection: ${owned} / ${TOTAL_MATERIALS} materials found`;
        const avatarURL = target.displayAvatarURL({ dynamic: true });

        const embeds = {
            items: buildItemsEmbed(inventory, shopItems, activeEffects, currency, color, footer, target, avatarURL),
            hunt:  buildMaterialsEmbed('hunt', huntMats, color, footer, target, avatarURL),
            fish:  buildMaterialsEmbed('fish', fishMats, color, footer, target, avatarURL),
            mine:  buildMaterialsEmbed('mine', mineMats, color, footer, target, avatarURL),
        };

        let activeTab = 'items';
        const message = await interaction.reply({
            embeds: [embeds[activeTab]],
            components: [buildTabRow(activeTab, interaction.id)],
            fetchReply: true
        });

        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: btn => btn.user.id === interaction.user.id
                && TAB_KEYS.some(k => btn.customId === `inv_${k}_${interaction.id}`),
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
    }
};
