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
const { listingCancelPayoutKey, listingCreateRefundPayoutKey } = require('../../utils/payoutKey');
const { grantItemsOrOwe } = require('../../utils/creditOrOwe');
const {
    creditPurchasedItem, unwindPurchase, payListingSeller, recordAmbiguousClaim,
} = require('../../services/marketService');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { isSoulbound } = require('../../data/soulboundItems');
const { describeItem } = require('../../utils/itemDisplay');

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
                    o.setName('item')
                        .setDescription('Item to sell — start typing to pick from your inventory.')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addIntegerOption(o =>
                    o.setName('quantity').setDescription('How many to sell.').setRequired(true).setMinValue(1))
                .addIntegerOption(o =>
                    o.setName('price').setDescription('Price per unit (coins).').setRequired(true).setMinValue(MIN_PRICE_PER_ITEM)))
        .addSubcommand(sub =>
            sub.setName('browse')
                .setDescription('Browse active listings.')
                .addStringOption(o =>
                    o.setName('item')
                        .setDescription('Filter by item — start typing to pick one that is actually listed.')
                        .setRequired(false)
                        .setAutocomplete(true)))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Buy a listing by its ID.')
                .addStringOption(o =>
                    o.setName('listing_id')
                        .setDescription('Listing to buy — start typing to pick one.')
                        .setRequired(true)
                        .setAutocomplete(true)))
        .addSubcommand(sub =>
            sub.setName('cancel')
                .setDescription('Cancel one of your active listings and get your item back.')
                .addStringOption(o =>
                    o.setName('listing_id')
                        .setDescription('Which of your listings to cancel — start typing to pick one.')
                        .setRequired(true)
                        .setAutocomplete(true))),

    /**
     * Every option on this command was an id typed from memory.
     *
     * `item` is the worse half of that: inventory ids are not uniformly cased —
     * a relic is stored under its prose name and a custom shop item under its
     * display name, because shop.js stores an item as `itemId || name` — so
     * `/market list item:The Tenth Owl` was a spelling test, and the handler's
     * `.toLowerCase()` meant a relic could not be listed at all. `listing_id` is
     * a 24-character hex string that had to be copied out of `/market browse`.
     */
    async autocomplete(interaction) {
        try {
            const sub     = interaction.options.getSubcommand();
            const focused = interaction.options.getFocused(true);
            const typed   = (focused?.value ?? '').toLowerCase();

            if (focused?.name === 'item' && sub === 'list')   return interaction.respond(await inventoryChoices(interaction, typed));
            if (focused?.name === 'item' && sub === 'browse') return interaction.respond(await listedItemChoices(interaction, typed));
            if (focused?.name === 'listing_id')               return interaction.respond(await listingChoices(interaction, typed, sub));
            return interaction.respond([]);
        } catch (err) {
            console.error('[market] autocomplete error:', err);
            await interaction.respond([]).catch(() => {});
        }
    },

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

/** Prefix matches first, then substring, then alphabetical — as /shop buy ranks. */
function rankByName(items, typed) {
    if (!typed) return [...items].sort((a, b) => a.name.localeCompare(b.name));
    return [...items].sort((a, b) => {
        const aPre = a.name.toLowerCase().startsWith(typed) ? 0 : 1;
        const bPre = b.name.toLowerCase().startsWith(typed) ? 0 : 1;
        return aPre - bPre || a.name.localeCompare(b.name);
    });
}

/** What the seller is holding and is allowed to list, for `/market list`. */
async function inventoryChoices(interaction, typed) {
    const [seller, guildSettings] = await Promise.all([
        User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }, 'inventory').lean(),
        getGuildSettings(interaction.guild.id),
    ]);
    const shopItems = guildSettings?.shop ?? [];

    const items = (seller?.inventory ?? [])
        .filter(e => e.quantity > 0 && !isSoulbound(e.itemId))
        .map(e => ({ quantity: e.quantity, ...describeItem(e.itemId, { shopItems }) }))
        .filter(i => !typed || i.name.toLowerCase().includes(typed) || i.itemId.toLowerCase().includes(typed));

    return rankByName(items, typed).slice(0, 25).map(i => ({
        name: `${i.emoji} ${i.name} — ${i.quantity} held`.slice(0, 100),
        value: i.itemId.slice(0, 100),
    }));
}

/** The items that actually have listings, for the `/market browse` filter. */
async function listedItemChoices(interaction, typed) {
    const [itemIds, guildSettings] = await Promise.all([
        MarketListing.distinct('itemId', { guildId: interaction.guild.id }),
        getGuildSettings(interaction.guild.id),
    ]);
    const shopItems = guildSettings?.shop ?? [];

    const items = itemIds
        .map(id => describeItem(id, { shopItems }))
        .filter(i => !typed || i.name.toLowerCase().includes(typed) || i.itemId.toLowerCase().includes(typed));

    return rankByName(items, typed).slice(0, 25).map(i => ({
        name: `${i.emoji} ${i.name}`.slice(0, 100),
        value: i.itemId.slice(0, 100),
    }));
}

/**
 * Listings addressable by the caller: their own for `cancel`, everyone else's
 * for `buy` — the same split the handlers enforce, so the picker never offers a
 * listing that would be refused on submit.
 */
async function listingChoices(interaction, typed, sub) {
    const query = sub === 'cancel'
        ? { guildId: interaction.guild.id, sellerId: interaction.user.id }
        : { guildId: interaction.guild.id, sellerId: { $ne: interaction.user.id } };

    const [listings, guildSettings] = await Promise.all([
        MarketListing.find(query).sort({ pricePerUnit: 1 }).limit(100).lean(),
        getGuildSettings(interaction.guild.id),
    ]);
    const shopItems = guildSettings?.shop ?? [];
    const currency  = guildSettings?.economy?.currency ?? '';

    return listings
        .map(l => ({ listing: l, ...describeItem(l.itemId, { shopItems }) }))
        .filter(i => !typed
            || i.name.toLowerCase().includes(typed)
            || String(i.listing._id).toLowerCase().startsWith(typed))
        .slice(0, 25)
        .map(i => ({
            name: `${i.emoji} ${i.listing.quantity}× ${i.name} — ${currency}${(i.listing.pricePerUnit * i.listing.quantity).toLocaleString()} total`.slice(0, 100),
            value: String(i.listing._id).slice(0, 100),
        }));
}

async function handleList(interaction, currency) {
    const typedItem = interaction.options.getString('item');
    const qty       = interaction.options.getInteger('quantity');
    const price     = interaction.options.getInteger('price');

    const seller = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        {},
        { upsert: true, new: true }
    );

    // Resolve what was typed against the seller's own bag, case-insensitively.
    //
    // This used to be `getString('item').toLowerCase()` compared with `===`
    // against the stored id, which is only ever right for the snake_cased shop
    // items. Relics are stored under their prose name ("The Tenth Owl") and a
    // custom guild item under whatever an admin called it, since shop.js stores
    // an item as `itemId || name` — so neither could be listed at all, whatever
    // the seller typed. Same resolution /gift and /use do.
    //
    // `stack`, not `slot`: a slot in this file is one of the seller's five
    // listing slots now, and this is the inventory stack being sold out of.
    const wanted = typedItem.trim().toLowerCase();
    const owned  = (seller.inventory ?? []).filter(i => i.itemId.toLowerCase() === wanted && i.quantity > 0);
    // The same predicate as the atomic debit below: a duplicate stack too small
    // to cover the sale must not reject one that can.
    const stack  = owned.find(i => i.quantity >= qty);

    if (!owned.length) {
        return interaction.reply({
            content: `You don't have **${typedItem}** in your inventory. Start typing in the \`item\` box to pick from what you're holding.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    // Canonical casing, for every database match and every label from here down
    // — including the soulbound test, which on the raw string let `Lifesaver`
    // past and refused it several lines later with the wrong reason.
    const itemId = (stack ?? owned[0]).itemId;

    if (isSoulbound(itemId)) {
        return interaction.reply({ content: `\`${itemId}\` is soulbound and cannot be listed.`, flags: MessageFlags.Ephemeral });
    }

    if (!stack) {
        const held = owned.reduce((n, i) => n + i.quantity, 0);
        return interaction.reply({ content: `You don't have ${qty}x \`${itemId}\` in your inventory — you hold ${held}.`, flags: MessageFlags.Ephemeral });
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
    // This was the first of the three to be written and the only one that got it
    // right; it is `grantItemsOrOwe` now so all three share the rule rather than
    // one of them carrying it (#873). The one thing it gains is the key: the
    // record it files could previously be replayed against a write that had in
    // fact committed and merely lost its response, which would hand the seller a
    // second copy of the stock.
    //
    // The whole result, not just `granted`: `recordOwedPayout` answers false
    // when even the queue write failed, and collapsing that into the same
    // boolean would make the reply below promise an operator a record that is
    // not there — which is the same class of untrue reassurance as the ones the
    // rest of this pass removed.
    const returnStock = () => grantItemsOrOwe(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        itemId, qty,
        {
            payoutKey: listingCreateRefundPayoutKey(interaction.id),
            service: 'market',
            jobName: 'listItem',
        },
    );

    // What to tell the seller about their stock. Saying it came back when it did
    // not is the one thing this must never do: they would have no reason to
    // mention it to anyone. Saying it is recorded when it is not is the second.
    const stockNote = ({ granted, owed }) => (granted
        ? 'Your item has been returned.'
        : owed
            ? 'Your item could not be returned automatically — it is recorded as owed and an operator can restore it.'
            : 'Your item could not be returned and could not be recorded. Please contact a server admin.');

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

        // What to tell the buyer about their coins. Saying they came back when
        // they did not is the one thing this must never do; saying they are
        // recorded when the queue write failed too is the second. The writes
        // themselves are `unwindPurchase` in services/marketService.js, beside
        // the expiry sweep that unwinds the other way (#873).
        const refundNote = ({ credited, owed }) => (credited
            ? 'Your coins have been refunded.'
            : owed
                ? 'Returning your coins failed — it is recorded and an admin can restore them.'
                : 'Returning your coins failed and could not be recorded. Please contact a server admin.');

        const unwind = (jobName, returnStock) => unwindPurchase({
            buyerId: interaction.user.id, sellerId: listing.sellerId,
            guildId: interaction.guild.id, listing, totalCost,
            refundKey: interaction.id, jobName, returnStock,
        });

        // The claim, and the one write in this flow whose *failure* says nothing
        // about its outcome (#873). It had no `catch` at all, so a rejection
        // escaped a purchase that had already taken the buyer's money — the
        // coins gone, with nothing written down anywhere.
        let removed;
        try {
            removed = await MarketListing.findOneAndDelete({ _id: listing._id, guildId: interaction.guild.id });
        } catch (claimErr) {
            console.error('[market buy] claiming the listing failed after the buyer was debited:', claimErr);
            // The buyer is refunded; the stock is not, because a rejection
            // leaves it unknowable whether this delete landed or a concurrent
            // buyer's did, and returning stock for a listing somebody else
            // bought mints an item. But "not granted" must not mean "not written
            // down" (#873): the record goes in first, where an operator can find
            // it, rather than into a log line nobody was reading at the time.
            // Tri-state on purpose: `true`, `false`, or `null` when the
            // re-read itself failed. `Boolean()` here turned a failed read into
            // "the listing is gone", which is guidance that ends in stock being
            // returned for a listing that may still be live.
            const stillListed = await MarketListing
                .findOne({ _id: listing._id, guildId: interaction.guild.id }, '_id').lean()
                .then(Boolean)
                .catch(() => null);
            const recorded = await recordAmbiguousClaim({
                listing, buyerId: interaction.user.id, guildId: interaction.guild.id,
                stillListed, error: claimErr,
            });
            const { refund } = await unwind('buyRefundClaim', false);
            if (stillListed !== true) {
                console.error(
                    `[market buy] listing ${listing._id} ` +
                    `${stillListed === false ? 'is gone' : 'could not be re-read'} after a claim that rejected — ` +
                    `${listing.quantity}x ${listing.itemId} may be owed back to ${listing.sellerId}; ` +
                    `${recorded ? 'recorded for an operator to adjudicate' : 'NOT RECORDED'}`,
                );
            }
            return editReply({ content: `Something went wrong claiming the listing. ${refundNote(refund)}`, embeds: [], components: [] });
        }

        if (!removed) {
            // Somebody else's purchase won the delete, so the item is theirs and
            // only the coins come back.
            const { refund } = await unwind('buyRefundLost', false);
            return editReply({ content: `This listing was just sold. ${refundNote(refund)}`, embeds: [], components: [] });
        }

        // Update buyer inventory first; roll back the buyer deduction if it
        // fails. One atomic upsert rather than read-modify-save: a save computed
        // from a read here would flatten any credit that landed in between, and
        // two concurrent credits of the same item could each push their own slot.
        //
        // Keyed, which is what lets the unwind below decide rather than assume —
        // see `creditPurchasedItem`.
        // `indeterminate` is not `!delivered`, and unwinding on it is worse than
        // either guess (#873): undoing a purchase whose credit had in fact
        // landed refunds the buyer *and* returns the seller's stock, so the
        // buyer keeps a free item and a second copy appears in the seller's bag.
        // Nothing is undone for that state — `creditPurchasedItem` files it
        // under the purchase's own key, which settles it whichever way it went.
        const {
            delivered, indeterminate, owed: itemOwed, error: inventoryErr,
        } = await creditPurchasedItem({
            buyerId: interaction.user.id, guildId: interaction.guild.id, listing,
        });

        if (!delivered && !indeterminate) {
            console.error('[market buy] inventory update failed, refunding buyer:', inventoryErr);
            // A definite miss, so the purchase comes apart. The listing is
            // claimed, so the stock comes back too: it left the seller's bag
            // when they listed it and the row that held it is gone.
            const { refund } = await unwind('buyRefundItem', true);
            return editReply({ content: `Something went wrong crediting the item. ${refundNote(refund)}`, embeds: [], components: [] });
        }

        // The seller's proceeds — keyed, verified and filed as owed when they
        // will not land, in `payListingSeller` (#869).
        const {
            paid: sellerPaid, owed: owedRecorded, balance: sellerBalance, payoutKey: saleKey,
        } = await payListingSeller({
            sellerId: listing.sellerId, guildId: interaction.guild.id,
            listing, amount: sellerReceives,
        });

        // Logged whether or not the credit landed: the sale happened, and a row
        // that only appears when the credit lands leaves the coins unaccounted
        // for exactly when someone goes looking for them. The note says which it
        // was, so an operator reading a `market_sell` whose balance did not move
        // has the reason in front of them rather than a discrepancy to work out.
        //
        // The one thing that stops the row being written is not knowing the
        // balance to put on it (#873). `balance` is required on the Transaction
        // schema, and the figure used to fall back to `0` — a number nobody
        // read, filed in the ledger as though somebody had. A missing row is a
        // gap an operator can see; a fabricated balance is one they cannot.
        if (sellerBalance === null) {
            console.error(
                `[market buy] listing ${listing._id} sold and the seller's balance could not be read — ` +
                `no market_sell row filed for ${sellerReceives} to ${listing.sellerId} ` +
                `(payout ${sellerPaid ? 'landed' : `owed under ${saleKey}`})`,
            );
        } else {
            logTransaction({
                userId: listing.sellerId, guildId: interaction.guild.id, type: 'market_sell',
                amount: sellerReceives, balance: sellerBalance,
                note: sellerPaid ? listing.itemId : `${listing.itemId} — payout owed (${saleKey})`,
            });
        }
        logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'market_buy', amount: -totalCost, balance: buyer.balance, note: listing.itemId });

        // The buyer's side of the trade is complete whatever happened above, so
        // this is still a success — but the receipt does not claim the seller
        // was paid when they were not, nor that the payout is recorded when the
        // queue write failed too: `recordOwedPayout` returns false for that, and
        // an unrecorded payout is the one case a human has to be told about.
        return editReply({
            embeds: [new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle('✅ Purchase Complete!')
                .setDescription(`You bought **${listing.quantity}x \`${listing.itemId}\`** for **${currency}${totalCost.toLocaleString()}**.`)
                .addFields(
                    { name: 'Fee Burned', value: `${currency}${feeAmount.toLocaleString()}`, inline: true },
                    sellerPaid
                        ? { name: 'Seller Received', value: `${currency}${sellerReceives.toLocaleString()}`, inline: true }
                        : {
                            name: 'Seller Payout',
                            value: owedRecorded
                                ? `${currency}${sellerReceives.toLocaleString()} — delayed, recorded as owed`
                                : `${currency}${sellerReceives.toLocaleString()} — delayed and not recorded, please contact a server admin`,
                            inline: true,
                        },
                    // Said out loud rather than left to the buyer to notice. The
                    // sale is real and the coins are spent either way, but a bag
                    // that may not have the item in it is not something to find
                    // out by looking.
                    ...(indeterminate ? [{
                        name: 'Your Item',
                        value: itemOwed
                            ? 'Delivery could not be confirmed — it is recorded and will be settled without charging you twice'
                            : 'Delivery could not be confirmed and could not be recorded, please contact a server admin',
                        inline: false,
                    }] : []),
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
    // stock — and the delete is what makes it the only copy: nothing will find
    // this return again, on this tick or any later one.
    //
    // It used to be a bare `grantInventoryItem` in a `try`, which got both
    // halves of that wrong (#873). The call answers `null` rather than throwing
    // for a seller whose document has gone, and the return value was never
    // looked at — so the reply said "Returned 3x lucky_charm" over an item that
    // by then existed nowhere. And the `catch` that did fire wrote a console
    // line calling the items "owed" without recording anything owed, three
    // hundred lines below the `returnStock` in `handleList` that records exactly
    // this for exactly this reason. Both are `grantItemsOrOwe` now, so the
    // failure the reply describes is the failure that happened.
    const returned = await grantItemsOrOwe(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        listing.itemId, listing.quantity,
        {
            payoutKey: listingCancelPayoutKey(listing._id),
            service: 'market',
            jobName: 'cancelListing',
            extra: { listingId: String(listing._id) },
            // The seller is standing right here typing the command, so their
            // document exists; `upsert` is on for the same reason the expiry
            // sweep has it on — a return that arrives after an account prune is
            // still theirs, and a stock return is not a resurrection worth
            // refusing when the alternative is losing the item.
            upsert: true,
        },
    );
    if (!returned.granted) {
        return interaction.reply({
            content: returned.owed
                ? 'The listing was cancelled, but returning your items failed. It is recorded and an admin can restore them.'
                : 'The listing was cancelled, but returning your items failed and could not be recorded. Please contact a server admin.',
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
