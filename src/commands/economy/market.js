const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, ComponentType,
} = require('discord.js');
const User           = require('../../models/User');
const Guild          = require('../../models/Guild');
const MarketListing  = require('../../models/MarketListing');
const Transaction    = require('../../models/Transaction');
const { DEFAULT_SHOP_ITEMS, getItemLore, getItemRarity, RARITY_ORDER } = require('../../data/defaultShopItems');
const { EFFECT_CONFIGS } = require('../../services/effectsService');
const { logTransaction } = require('../../utils/logTransaction');

const ITEM_META = Object.fromEntries(DEFAULT_SHOP_ITEMS.map(i => [i.itemId, i]));

const MAX_LISTINGS_PER_USER = 5;
const LISTING_TTL_MS        = 48 * 3_600_000;
const MARKET_FEE_RATE       = 0.05;
const MIN_PRICE_PER_ITEM    = 10;
const PAGE_SIZE             = 10;
const CONFIRM_BUY_THRESHOLD = 500;

const SOULBOUND_ITEMS = new Set(['lifesaver', 'streak_shield']);

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
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
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

    if (SOULBOUND_ITEMS.has(itemId)) {
        return interaction.reply({ content: `\`${itemId}\` is soulbound and cannot be listed.`, ephemeral: true });
    }

    const seller = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        {},
        { upsert: true, new: true }
    );

    const slot = seller.inventory.find(i => i.itemId === itemId);
    if (!slot || slot.quantity < qty) {
        return interaction.reply({ content: `You don't have ${qty}x \`${itemId}\` in your inventory.`, ephemeral: true });
    }

    const activeListing = await MarketListing.countDocuments({
        guildId:  interaction.guild.id,
        sellerId: interaction.user.id,
    });
    if (activeListing >= MAX_LISTINGS_PER_USER) {
        return interaction.reply({ content: `You can only have ${MAX_LISTINGS_PER_USER} active listings at a time.`, ephemeral: true });
    }

    slot.quantity -= qty;
    if (slot.quantity <= 0) seller.inventory = seller.inventory.filter(i => i.itemId !== itemId);
    seller.markModified('inventory');
    await seller.save();

    let listing;
    try {
        listing = await MarketListing.create({
            guildId:      interaction.guild.id,
            sellerId:     interaction.user.id,
            itemId,
            quantity:     qty,
            pricePerUnit: price,
            expiresAt:    new Date(Date.now() + LISTING_TTL_MS),
        });
    } catch (err) {
        const restored = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (restored) {
            const s = restored.inventory.find(i => i.itemId === itemId);
            if (s) { s.quantity += qty; }
            else   { restored.inventory.push({ itemId, quantity: qty }); }
            restored.markModified('inventory');
            await restored.save().catch(console.error);
        }
        console.error('[market list] MarketListing.create failed:', err);
        return interaction.reply({ content: 'Failed to create listing. Your item has been returned.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle('📦 Item Listed!')
        .setDescription(`**${qty}x \`${itemId}\`** listed for **${currency}${price.toLocaleString()}** per unit.`)
        .addFields(
            { name: 'Listing ID', value: `\`${listing._id}\``, inline: false },
            { name: 'Expires',    value: `<t:${Math.floor(listing.expiresAt.getTime() / 1000)}:R>`, inline: true },
            { name: 'Fee Note',   value: `5% market fee deducted on sale`, inline: true },
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
}

// Returns a seller rep label: '👑 N sales' or '🆕 first listing'
async function getSellerRep(guildId, sellerId) {
    const count = await Transaction.countDocuments({ guildId, userId: sellerId, type: 'market_sell' });
    return count > 0 ? `👑 ${count} sale${count !== 1 ? 's' : ''}` : '🆕 first listing';
}

// Formats a single listing line for embed display
async function formatLine(l, currency, client) {
    const sellerTag  = await client.users.fetch(l.sellerId).then(u => u.username).catch(() => 'Unknown');
    const rep        = await getSellerRep(l.guildId, l.sellerId);
    const totalPrice = l.pricePerUnit * l.quantity;
    const meta       = ITEM_META[l.itemId];
    const effectCfg  = EFFECT_CONFIGS[l.itemId];
    const itemEmoji  = effectCfg?.emoji ?? '';
    const displayName = meta ? `${itemEmoji} ${meta.name}`.trim() : `\`${l.itemId}\``;
    const loreText   = getItemLore(l.itemId);
    const loreSuffix = loreText ? `\n  *${loreText.slice(0, 80)}${loreText.length > 80 ? '…' : ''}*` : '';
    const rarity     = getItemRarity(l.itemId, l.pricePerUnit);
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
            ephemeral: true,
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

        const lines = await Promise.all(slice.map(l => formatLine(l, currency, interaction.client)));

        const sortLabel = sortMode === SORT_RARITY ? '🏷️ Rarity sort' : '💰 Price sort';
        return new EmbedBuilder()
            .setColor('#3498db')
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
        filter: btn => btn.user.id === interaction.user.id,
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
        return interaction.reply({ content: 'Invalid listing ID.', ephemeral: true });
    }

    if (!listing) {
        return interaction.reply({ content: 'Listing not found or already expired/sold.', ephemeral: true });
    }
    if (listing.sellerId === interaction.user.id) {
        return interaction.reply({ content: "You can't buy your own listing.", ephemeral: true });
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

        await Promise.all([
            User.updateOne({ userId: listing.sellerId, guildId: interaction.guild.id }, { $inc: { balance: sellerReceives } }),
            (async () => {
                const buyerDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
                const slot = buyerDoc.inventory.find(i => i.itemId === listing.itemId);
                if (slot) { slot.quantity += listing.quantity; }
                else       { buyerDoc.inventory.push({ itemId: listing.itemId, quantity: listing.quantity }); }
                buyerDoc.markModified('inventory');
                await buyerDoc.save();
            })(),
            logTransaction({ userId: listing.sellerId, guildId: interaction.guild.id, type: 'market_sell',    amount: sellerReceives, balance: 0, note: listing.itemId }),
            logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'market_buy', amount: -totalCost,     balance: buyer.balance, note: listing.itemId }),
        ]);

        return editReply({
            embeds: [new EmbedBuilder()
                .setColor('#2ecc71')
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
            .setColor('#f39c12')
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
            filter: i => i.user.id === interaction.user.id,
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

async function handleCancel(interaction, currency) {
    const rawId = interaction.options.getString('listing_id');

    let listing;
    try {
        listing = await MarketListing.findOneAndDelete({
            _id:      rawId,
            guildId:  interaction.guild.id,
            sellerId: interaction.user.id,
        });
    } catch {
        return interaction.reply({ content: 'Invalid listing ID.', ephemeral: true });
    }

    if (!listing) {
        return interaction.reply({ content: 'Listing not found, already sold, or not yours.', ephemeral: true });
    }

    const seller = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
    const slot = seller.inventory.find(i => i.itemId === listing.itemId);
    if (slot) { slot.quantity += listing.quantity; }
    else       { seller.inventory.push({ itemId: listing.itemId, quantity: listing.quantity }); }
    seller.markModified('inventory');
    await seller.save();

    const embed = new EmbedBuilder()
        .setColor('#e67e22')
        .setTitle('↩️ Listing Cancelled')
        .setDescription(`Returned **${listing.quantity}x \`${listing.itemId}\`** to your inventory.`)
        .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
}
