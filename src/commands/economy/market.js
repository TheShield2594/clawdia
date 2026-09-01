const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, ComponentType,
    MessageFlags,
} = require('discord.js');
const User           = require('../../models/User');
const MarketListing  = require('../../models/MarketListing');
const Transaction    = require('../../models/Transaction');
const { DEFAULT_SHOP_ITEMS, getItemLore, getItemRarity, RARITY_ORDER } = require('../../data/defaultShopItems');
const { EFFECT_CONFIGS } = require('../../services/effectsService');
const { logTransaction } = require('../../utils/logTransaction');
const { grantInventoryItem } = require('../../utils/inventoryGrant');
const { recordOwedPayout } = require('../../utils/owedPayout');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { isSoulbound } = require('../../data/soulboundItems');

const ITEM_META = Object.fromEntries(DEFAULT_SHOP_ITEMS.map(i => [i.itemId, i]));

const MAX_LISTINGS_PER_USER = 5;
// The slots a seller's listings occupy, 1-based. Each listing carries the one it
// holds and the unique index on { guildId, sellerId, slot } enforces it — see
// createListingInFreeSlot and models/MarketListing.js.
const LISTING_SLOTS = Array.from({ length: MAX_LISTINGS_PER_USER }, (_, i) => i + 1);
const LISTING_TTL_MS        = 48 * 3_600_000;
const MARKET_FEE_RATE       = 0.05;
const MIN_PRICE_PER_ITEM    = 10;
const PAGE_SIZE             = 10;
const CONFIRM_BUY_THRESHOLD = 500;

const SORT_RARITY = 'rarity';
const SORT_PRICE  = 'price';

const RARITY_RANK = Object.fromEntries(RARITY_ORDER.map((r, i) => [r, i]));

module.exports = {
    data: new SlashCommandBuilder()
        .setName('market')
        .setDescription('Server player-to-player item marketplace.')
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List an item for sale.')
                .addStringOption(o =>
                    o.setName('item').setDescription('Item ID to sell.').setRequired(true))
                .addIntegerOption(o =>
                    o.setName('quantity').setDescription('How many to sell.').setRequired(true).setMinValue(1))
                .addIntegerOption(o =>
                    o.setName('price').setDescription('Price per unit (coins).').setRequired(true).setMinValue(MIN_PRICE_PER_ITEM)))
        .addSubcommand(sub =>
            sub.setName('browse')
                .setDescription('Browse active listings.')
                .addStringOption(o =>
                    o.setName('item').setDescription('Filter by item ID (optional).').setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Buy a listing by its ID.')
                .addStringOption(o =>
                    o.setName('listing_id').setDescription('Listing ID from /market browse.').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('cancel')
                .setDescription('Cancel one of your active listings and get your item back.')
                .addStringOption(o =>
                    o.setName('listing_id').setDescription('Listing ID to cancel.').setRequired(true))),

    async execute(interaction) {
        const guildSettings = await getGuildSettings(interaction.guild.id);
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const currency = guildSettings?.economy?.currency || '💰';
        const sub      = interaction.options.getSubcommand();

        if (sub === 'list')   return handleList(interaction, currency);
        if (sub === 'browse') return handleBrowse(interaction, currency);
        if (sub === 'buy')    return handleBuy(interaction, currency);
        if (sub === 'cancel') return handleCancel(interaction, currency);
    },
};

async function handleList(interaction, currency) {
    const itemId = interaction.options.getString('item').toLowerCase();
    const qty    = interaction.options.getInteger('quantity');
    const price  = interaction.options.getInteger('price');

    if (isSoulbound(itemId)) {
        return interaction.reply({ content: `\`${itemId}\` is soulbound and cannot be listed.`, flags: MessageFlags.Ephemeral });
    }

    const seller = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        {},
        { upsert: true, new: true }
    );

    // `stack`, not `slot`: a slot in this file is one of the seller's five
    // listing slots now, and this is the inventory stack being sold out of.
    const stack = seller.inventory.find(i => i.itemId === itemId);
    if (!stack || stack.quantity < qty) {
        return interaction.reply({ content: `You don't have ${qty}x \`${itemId}\` in your inventory.`, flags: MessageFlags.Ephemeral });
    }

    // The friendly refusal, before any stock moves: a seller who is already full
    // is told so without their items being taken and handed back. It is not what
    // enforces the cap — two calls can pass this together — which is what the
    // slot the insert claims below is for.
    const openListings = await MarketListing.find(
        { guildId: interaction.guild.id, sellerId: interaction.user.id },
        'slot',
    ).lean();
    if (openListings.length >= MAX_LISTINGS_PER_USER) {
        return interaction.reply({ content: `You can only have ${MAX_LISTINGS_PER_USER} active listings at a time.`, flags: MessageFlags.Ephemeral });
    }

    // The stock leaves as a compare-and-set, not `stack.quantity -= qty` followed
    // by a save: the quantity read above is history by now, and two concurrent
    // `/market list` calls for the same stack would each see the full count and
    // both take it — one stack backing two listings. The `$elemMatch` filter
    // makes the check and the debit the same write (same shape as use.js).
    const debited = await User.findOneAndUpdate(
        {
            userId:    interaction.user.id,
            guildId:   interaction.guild.id,
            inventory: { $elemMatch: { itemId, quantity: { $gte: qty } } },
        },
        { $inc: { 'inventory.$.quantity': -qty } },
        { new: true },
    );
    if (!debited) {
        return interaction.reply({ content: `You don't have ${qty}x \`${itemId}\` in your inventory.`, flags: MessageFlags.Ephemeral });
    }
    // Drop inventory stacks the decrement above emptied. Advisory: a failure
    // leaves an empty stack, not wrong quantities.
    await User.updateOne(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $pull: { inventory: { quantity: { $lte: 0 } } } },
    ).catch(err => console.error('[market list] inventory cleanup failed:', err));

    // Hand the stock back the same way every other credit lands — one atomic
    // upsert, so the return can't duplicate an inventory stack a concurrent
    // credit is creating (src/utils/inventoryGrant.js).
    //
    // The debit has already committed by the time anything calls this, so a
    // return that does not land is an item the player no longer has and no
    // listing to show for it. Two ways it fails to land: the update rejects, or
    // it matches no document and resolves null. Both are failures, and neither
    // may be reported as a return — the credit is written down as owed instead,
    // the same shape `replayOwedPayout` pays and `npm run payouts:replay` lists
    // (src/utils/owedPayout.js), which is what utils/balanceDelta.js does for a
    // credit that will not land in a command.
    //
    // Returns whether the stock is actually back.
    const returnStock = async () => {
        let failure;
        try {
            if (await grantInventoryItem(interaction.user.id, interaction.guild.id, itemId, qty)) return true;
            failure = new Error(`no user document for ${interaction.user.id} in ${interaction.guild.id}`);
        } catch (restoreErr) {
            failure = restoreErr;
        }

        console.error(
            `[market list] returning ${qty}x ${itemId} to ${interaction.user.id} failed — items owed:`, failure,
        );
        await recordOwedPayout({
            service: 'market',
            jobName: 'listItem',
            guildId: interaction.guild.id,
            payload: {
                kind:     'items',
                userId:   interaction.user.id,
                guildId:  interaction.guild.id,
                itemId,
                quantity: qty,
            },
            error: failure,
        });
        return false;
    };

    // What to tell the seller about their stock. Saying it came back when it did
    // not is the one thing this must never do: they would have no reason to
    // mention it to anyone.
    const stockNote = returned => (returned
        ? 'Your item has been returned.'
        : 'Your item could not be returned automatically — it is recorded as owed and an operator can restore it.');

    let listing;
    try {
        listing = await createListingInFreeSlot({
            guildId:      interaction.guild.id,
            sellerId:     interaction.user.id,
            itemId,
            quantity:     qty,
            pricePerUnit: price,
            expiresAt:    new Date(Date.now() + LISTING_TTL_MS),
        });
    } catch (err) {
        const returned = await returnStock();
        console.error('[market list] MarketListing.create failed:', err);
        return interaction.reply({ content: `Failed to create listing. ${stockNote(returned)}`, flags: MessageFlags.Ephemeral });
    }

    // Every slot was taken by the time the insert went in — the check above and
    // another `/market list` both passed it. The stock is handed straight back,
    // so losing the race costs the seller nothing but the refusal.
    if (!listing) {
        const returned = await returnStock();
        return interaction.reply({
            content: `You can only have ${MAX_LISTINGS_PER_USER} active listings at a time. ${stockNote(returned)}`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle('📦 Item Listed!')
        .setDescription(`**${qty}x \`${itemId}\`** listed for **${currency}${price.toLocaleString()}** per unit.`)
        .addFields(
            { name: 'Listing ID', value: `\`${listing._id}\``, inline: false },
            { name: 'Expires',    value: `<t:${Math.floor(listing.expiresAt.getTime() / 1000)}:R>`, inline: true },
            { name: 'Fee Note',   value: `5% market fee deducted on sale`, inline: true },
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/**
 * Inserts the listing into the seller's first free slot, or answers null when
 * they have none left.
 *
 * The cap used to be a `countDocuments` followed by an insert (#926), which two
 * concurrent calls could both pass — cosmetic, but the pattern is the same one
 * that loses money elsewhere, and the fix is the one the rest of the economy
 * uses: let the write itself be the check. The unique index on
 * { guildId, sellerId, slot } means only one insert per slot can land, so the
 * loser of the race is told no rather than quietly making it six.
 *
 * Each attempt re-reads the taken slots, because an E11000 means exactly that
 * they have changed. One attempt per slot plus one is the most that can be
 * useful: every retry loses a different slot to somebody, and the read after the
 * last one finds the seller full.
 */
async function createListingInFreeSlot(fields) {
    for (let attempt = 0; attempt <= MAX_LISTINGS_PER_USER; attempt++) {
        const open = await MarketListing.find(
            { guildId: fields.guildId, sellerId: fields.sellerId },
            'slot',
        ).lean();
        const slotted = open.filter(l => l.slot != null);
        const taken   = new Set(slotted.map(l => l.slot));
        const free    = LISTING_SLOTS.filter(s => !taken.has(s));

        // A listing written before the slot field existed carries none, and the
        // index skips it — but it is still one of the seller's five, and taking
        // the lowest free number beside it would let a seller with four legacy
        // listings open five more. The legacy rows stand in for that many free
        // slots, so the seller has as many places left as they should and the
        // unique index still decides who gets each remaining number.
        const slot = free[open.length - slotted.length];
        if (slot === undefined) return null;

        try {
            return await MarketListing.create({ ...fields, slot });
        } catch (err) {
            // 11000 is the index doing its job: somebody else took this slot
            // between the read and the insert. Anything else is a real failure
            // and belongs to the caller, which hands the stock back.
            if (err?.code !== 11000) throw err;
        }
    }
    return null;
}

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
function formatLine(l, currency, repMap, tagMap) {
    const sellerTag   = tagMap.get(l.sellerId) ?? 'Unknown';
    const rep         = repMap.get(l.sellerId) ?? '🆕 first listing';
    const totalPrice  = l.pricePerUnit * l.quantity;
    const meta        = ITEM_META[l.itemId];
    const effectCfg   = EFFECT_CONFIGS[l.itemId];
    const itemEmoji   = effectCfg?.emoji ?? '';
    const displayName = meta ? `${itemEmoji} ${meta.name}`.trim() : `\`${l.itemId}\``;
    const loreText    = getItemLore(l.itemId);
    const loreSuffix  = loreText ? `\n  *${loreText.slice(0, 80)}${loreText.length > 80 ? '…' : ''}*` : '';
    const rarity      = getItemRarity(l.itemId, l.pricePerUnit);
    return `\`${String(l._id).slice(-6)}\`  @${sellerTag} *(${rep})*\n**${l.quantity}x ${displayName}** — ${currency}${l.pricePerUnit.toLocaleString()}/ea  *(${currency}${totalPrice.toLocaleString()} total)*  · ${rarity}${loreSuffix}`;
}

async function handleBrowse(interaction, currency) {
    const filterItem = interaction.options.getString('item')?.toLowerCase() ?? null;

    const query = { guildId: interaction.guild.id };
    if (filterItem) query.itemId = filterItem;

    const total = await MarketListing.countDocuments(query);
    if (total === 0) {
        return interaction.reply({
            content: filterItem ? `No listings found for \`${filterItem}\`.` : 'The marketplace is empty.',
            flags: MessageFlags.Ephemeral,
        });
    }

    // Fetch all listings (capped at 200 for performance) and sort client-side for rarity mode
    const allListings = await MarketListing.find(query).sort({ pricePerUnit: 1 }).limit(200).lean();

    let sortMode = SORT_RARITY;

    function sortedListings() {
        if (sortMode === SORT_PRICE) {
            return [...allListings].sort((a, b) => a.pricePerUnit - b.pricePerUnit);
        }
        // Rarity-first: group by tier ascending (Common first), then price within tier
        return [...allListings].sort((a, b) => {
            const ra = RARITY_RANK[getItemRarity(a.itemId, a.pricePerUnit)] ?? 0;
            const rb = RARITY_RANK[getItemRarity(b.itemId, b.pricePerUnit)] ?? 0;
            if (ra !== rb) return ra - rb;
            return a.pricePerUnit - b.pricePerUnit;
        });
    }

    let page = 0;
    const title = filterItem ? `📦 Marketplace — ${filterItem}` : `📦 Server Marketplace`;

    async function buildEmbed() {
        const sorted     = sortedListings();
        const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
        const safePage   = Math.min(page, totalPages - 1);
        const slice      = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

        // Batch all DB/API calls for the page in two round-trips
        const { repMap, tagMap } = await fetchPageContext(slice, interaction.guild.id, interaction.client);
        const lines = slice.map(l => formatLine(l, currency, repMap, tagMap));

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

async function handleBuy(interaction, currency) {
    const rawId = interaction.options.getString('listing_id');

    let listing;
    try {
        listing = await MarketListing.findOne({ _id: rawId, guildId: interaction.guild.id });
    } catch {
        return interaction.reply({ content: 'Invalid listing ID.', flags: MessageFlags.Ephemeral });
    }

    if (!listing) {
        return interaction.reply({ content: 'Listing not found or already expired/sold.', flags: MessageFlags.Ephemeral });
    }
    if (listing.sellerId === interaction.user.id) {
        return interaction.reply({ content: "You can't buy your own listing.", flags: MessageFlags.Ephemeral });
    }

    const totalCost      = listing.pricePerUnit * listing.quantity;
    const feeAmount      = Math.floor(totalCost * MARKET_FEE_RATE);
    const sellerReceives = totalCost - feeAmount;

    const executePurchase = async (editReply) => {
        const buyer = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
            { $inc: { balance: -totalCost } },
            { new: true }
        );
        if (!buyer) {
            const fresh = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            return editReply({
                content: `You need **${currency}${totalCost.toLocaleString()}** but only have **${currency}${(fresh?.balance ?? 0).toLocaleString()}**.`,
                embeds: [], components: [],
            });
        }

        const removed = await MarketListing.findOneAndDelete({ _id: listing._id, guildId: interaction.guild.id });
        if (!removed) {
            await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } });
            return editReply({ content: 'This listing was just sold. Your coins have been refunded.', embeds: [], components: [] });
        }

        // Update buyer inventory first; roll back the buyer deduction if it fails.
        // One atomic upsert rather than read-modify-save: a save computed from a
        // read here would flatten any credit that landed in between, and two
        // concurrent credits of the same item could each push their own slot.
        try {
            const credited = await grantInventoryItem(interaction.user.id, interaction.guild.id, listing.itemId, listing.quantity);
            if (!credited) throw new Error('buyer document not found');
        } catch (inventoryErr) {
            console.error('[market buy] inventory update failed, refunding buyer:', inventoryErr);
            await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(console.error);
            return editReply({ content: 'Something went wrong crediting the item. Your coins have been refunded.', embeds: [], components: [] });
        }

        // Credit seller and capture their new balance for accurate logging
        const updatedSeller = await User.findOneAndUpdate(
            { userId: listing.sellerId, guildId: interaction.guild.id },
            { $inc: { balance: sellerReceives } },
            { new: true }
        );

        logTransaction({ userId: listing.sellerId, guildId: interaction.guild.id, type: 'market_sell', amount: sellerReceives, balance: updatedSeller?.balance ?? 0, note: listing.itemId });
        logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'market_buy', amount: -totalCost, balance: buyer.balance, note: listing.itemId });

        return editReply({
            embeds: [new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle('✅ Purchase Complete!')
                .setDescription(`You bought **${listing.quantity}x \`${listing.itemId}\`** for **${currency}${totalCost.toLocaleString()}**.`)
                .addFields(
                    { name: 'Fee Burned',      value: `${currency}${feeAmount.toLocaleString()}`, inline: true },
                    { name: 'Seller Received', value: `${currency}${sellerReceives.toLocaleString()}`, inline: true },
                )
                .setTimestamp()
            ],
            components: [],
        });
    };

    // Confirmation step for purchases over the threshold
    if (totalCost >= CONFIRM_BUY_THRESHOLD) {
        const meta        = ITEM_META[listing.itemId];
        const effectCfg   = EFFECT_CONFIGS[listing.itemId];
        const displayName = meta ? `${effectCfg?.emoji ?? ''} ${meta.name}`.trim() : listing.itemId;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('mkt_buy_confirm').setLabel('Confirm Purchase').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('mkt_buy_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        );
        const confirmEmbed = new EmbedBuilder()
            .setColor(COLORS.WARN)
            .setTitle('🛒 Confirm Market Purchase')
            .setDescription(`Buy **${listing.quantity}x ${displayName}** for **${currency}${totalCost.toLocaleString()}**?`)
            .addFields(
                { name: 'Price/ea',    value: `${currency}${listing.pricePerUnit.toLocaleString()}`, inline: true },
                { name: 'Fee (5%)',    value: `${currency}${feeAmount.toLocaleString()}`,             inline: true },
                { name: 'You Pay',     value: `${currency}${totalCost.toLocaleString()}`,             inline: true },
            )
            .setFooter({ text: 'Confirmation expires in 30 seconds' });

        const msg = await interaction.reply({ embeds: [confirmEmbed], components: [row], fetchReply: true });
        const collector = msg.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: ownedBy(interaction.user.id, "This isn't your listing."),
            time: 30_000,
            max: 1,
        });
        collector.on('collect', async btn => {
            if (btn.customId === 'mkt_buy_cancel') {
                return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
            }
            await btn.deferUpdate();
            await executePurchase(opts => interaction.editReply(opts)).catch(err => {
                console.error('[market buy]', err);
                interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
            });
        });
        collector.on('end', (collected, reason) => {
            if (reason === 'time' && collected.size === 0) {
                interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
            }
        });
        return;
    }

    await interaction.deferReply();
    await executePurchase(opts => interaction.editReply(opts));
}

async function handleCancel(interaction, _currency) {
    const rawId = interaction.options.getString('listing_id');

    let listing;
    try {
        listing = await MarketListing.findOneAndDelete({
            _id:      rawId,
            guildId:  interaction.guild.id,
            sellerId: interaction.user.id,
        });
    } catch {
        return interaction.reply({ content: 'Invalid listing ID.', flags: MessageFlags.Ephemeral });
    }

    if (!listing) {
        return interaction.reply({ content: 'Listing not found, already sold, or not yours.', flags: MessageFlags.Ephemeral });
    }

    // The listing is already deleted, so this credit is the only copy of the
    // stock — return it atomically and say so if the return fails, rather than
    // saving a stale in-memory inventory over concurrent credits.
    try {
        await grantInventoryItem(interaction.user.id, interaction.guild.id, listing.itemId, listing.quantity, { upsert: true });
    } catch (creditErr) {
        console.error(
            `[market cancel] listing ${listing._id} was removed but returning ` +
            `${listing.quantity}x ${listing.itemId} to ${interaction.user.id} failed — items owed:`, creditErr,
        );
        return interaction.reply({
            content: 'The listing was cancelled, but returning your items hit an error. Tell an admin — it is recoverable.',
            flags: MessageFlags.Ephemeral,
        });
    }

    const embed = new EmbedBuilder()
        .setColor('#e67e22')
        .setTitle('↩️ Listing Cancelled')
        .setDescription(`Returned **${listing.quantity}x \`${listing.itemId}\`** to your inventory.`)
        .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
