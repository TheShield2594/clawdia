'use strict';

// `/market browse` — the paged, sortable listing board.

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags,
} = require('discord.js');
const MarketListing = require('../../../models/MarketListing');
const Transaction = require('../../../models/Transaction');
const COLORS = require('../../../utils/embedColors');
const { ownedBy } = require('../../../utils/collectorOwner');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { itemDescriber } = require('../../../utils/aiItemLookup');
const { PAGE_SIZE, SORT_RARITY, SORT_PRICE, RARITY_RANK, itemLabel } = require('./shared');

// Batch-fetches seller rep counts and Discord usernames for a page slice.
// Returns { repMap: Map<sellerId, label>, tagMap: Map<sellerId, username> }
async function fetchPageContext(slice, guildId, client) {
    const sellerIds = [...new Set(slice.map(l => l.sellerId))];

    const [repRows] = await Promise.all([
        Transaction.aggregate([
            { $match: { guildId, userId: { $in: sellerIds }, type: 'market_sell' } },
            { $group: { _id: '$userId', count: { $sum: 1 } } },
        ]),
    ]);

    const repMap = new Map(sellerIds.map(id => [id, '🆕 first listing']));
    for (const row of repRows) {
        repMap.set(row._id, `👑 ${row.count} sale${row.count !== 1 ? 's' : ''}`);
    }

    const tagResults = await Promise.all(
        sellerIds.map(id => client.users.fetch(id).then(u => [id, u.username]).catch(() => [id, 'Unknown']))
    );
    const tagMap = new Map(tagResults);

    return { repMap, tagMap };
}

// Formats a single listing line using pre-fetched context (no per-item DB/API calls)
function formatLine(l, currency, repMap, tagMap, describe) {
    const sellerTag   = tagMap.get(l.sellerId) ?? 'Unknown';
    const rep         = repMap.get(l.sellerId) ?? '🆕 first listing';
    const totalPrice  = l.pricePerUnit * l.quantity;
    const meta        = describe(l.itemId);
    const loreText    = meta.lore;
    const loreSuffix  = loreText ? `\n  *${loreText.slice(0, 80)}${loreText.length > 80 ? '…' : ''}*` : '';
    const rarity      = meta.rarity ? `${meta.rarityEmoji} ${meta.rarity}`.trim() : '';
    return `\`${String(l._id).slice(-6)}\`  @${sellerTag} *(${rep})*\n**${l.quantity}x** ${itemLabel(meta)} — ${currency}${l.pricePerUnit.toLocaleString()}/ea  *(${currency}${totalPrice.toLocaleString()} total)*${rarity ? `  · ${rarity}` : ''}${loreSuffix}`;
}

async function handleBrowse(interaction, currency) {
    const filterItem = interaction.options.getString('item')?.trim() || null;

    const query = { guildId: interaction.guild.id };
    // Anchored and case-insensitive rather than an equality on the lowercased
    // string: a listed relic's itemId is "The Tenth Owl", so the old filter
    // matched nothing for exactly the items hardest to type. Escaped because the
    // value is whatever the member sent, and a stray `(` would otherwise throw.
    if (filterItem) query.itemId = new RegExp(`^${filterItem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

    const total = await MarketListing.countDocuments(query);
    if (total === 0) {
        return interaction.reply({
            content: filterItem ? `No listings found for \`${filterItem}\`.` : 'The marketplace is empty.',
            flags: MessageFlags.Ephemeral,
        });
    }

    // Fetch all listings (capped at 200 for performance) and sort client-side for rarity mode
    const allListings = await MarketListing.find(query).sort({ pricePerUnit: 1 }).limit(200).lean();
    const guildSettings = await getGuildSettings(interaction.guild.id);
    const describe = await itemDescriber(allListings.map(l => l.itemId), guildSettings?.shop ?? []);
    const rank = l => RARITY_RANK[describe(l.itemId).rarity] ?? 0;

    let sortMode = SORT_RARITY;

    function sortedListings() {
        if (sortMode === SORT_PRICE) {
            return [...allListings].sort((a, b) => a.pricePerUnit - b.pricePerUnit);
        }
        // Rarity-first: group by tier ascending (Common first), then price within tier
        return [...allListings].sort((a, b) => {
            const ra = rank(a);
            const rb = rank(b);
            if (ra !== rb) return ra - rb;
            return a.pricePerUnit - b.pricePerUnit;
        });
    }

    let page = 0;
    const filterMeta = filterItem ? describe(allListings[0]?.itemId ?? filterItem) : null;
    const title = filterMeta ? `📦 Marketplace — ${filterMeta.emoji} ${filterMeta.name}` : `📦 Server Marketplace`;

    async function buildEmbed() {
        const sorted     = sortedListings();
        const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
        const safePage   = Math.min(page, totalPages - 1);
        const slice      = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

        // Batch all DB/API calls for the page in two round-trips
        const { repMap, tagMap } = await fetchPageContext(slice, interaction.guild.id, interaction.client);
        const lines = slice.map(l => formatLine(l, currency, repMap, tagMap, describe));

        const sortLabel = sortMode === SORT_RARITY ? '🏷️ Rarity sort' : '💰 Price sort';
        return new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle(title)
            .setDescription(lines.join('\n\n') || 'No listings.')
            .setFooter({ text: `Page ${safePage + 1}/${totalPages} · ${sorted.length} listings · 5% fee · ${sortLabel}` })
            .setTimestamp();
    }

    function buildComponents(currentPage) {
        const sorted     = sortedListings();
        const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
        const iid        = interaction.id;
        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`mkt_prev_${iid}`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
                new ButtonBuilder().setCustomId(`mkt_next_${iid}`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= totalPages - 1),
                new ButtonBuilder().setCustomId(`mkt_sort_${iid}`).setLabel(sortMode === SORT_RARITY ? '💰 Sort: Price' : '🏷️ Sort: Rarity').setStyle(ButtonStyle.Primary),
            )
        ];
    }

    const embed = await buildEmbed();
    const msg = await interaction.reply({
        embeds: [embed],
        components: buildComponents(page),
        fetchReply: true,
    });

    const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: ownedBy(interaction.user.id, "This isn't your listing."),
        time: 3 * 60_000,
    });

    collector.on('collect', async btn => {
        await btn.deferUpdate();
        if (btn.customId === `mkt_prev_${interaction.id}`) page = Math.max(0, page - 1);
        else if (btn.customId === `mkt_next_${interaction.id}`) {
            const tp = Math.ceil(sortedListings().length / PAGE_SIZE);
            page = Math.min(tp - 1, page + 1);
        } else if (btn.customId === `mkt_sort_${interaction.id}`) {
            sortMode = sortMode === SORT_RARITY ? SORT_PRICE : SORT_RARITY;
            page = 0;
        }
        const updated = await buildEmbed();
        await interaction.editReply({ embeds: [updated], components: buildComponents(page) });
    });

    collector.on('end', () => {
        interaction.editReply({ components: [] }).catch(() => {});
    });
}

module.exports = { handleBrowse };
