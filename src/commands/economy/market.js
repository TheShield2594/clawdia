const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User           = require('../../models/User');
const Guild          = require('../../models/Guild');
const MarketListing  = require('../../models/MarketListing');

const MAX_LISTINGS_PER_USER = 5;
const LISTING_TTL_MS        = 48 * 3_600_000; // 48 hours
const MARKET_FEE_RATE       = 0.05;           // 5%
const MIN_PRICE_PER_ITEM    = 10;
const PAGE_SIZE             = 10;

// Items that cannot be listed (soulbound)
const SOULBOUND_ITEMS = new Set(['lifesaver', 'streak_shield']);

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
                    o.setName('item').setDescription('Filter by item ID (optional).').setRequired(false))
                .addIntegerOption(o =>
                    o.setName('page').setDescription('Page number.').setMinValue(1).setRequired(false)))
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

    // Deduct item from inventory before creating listing
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
        // Restore inventory if listing creation fails
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

async function handleBrowse(interaction, currency) {
    const filterItem = interaction.options.getString('item')?.toLowerCase() ?? null;
    const rawPage    = (interaction.options.getInteger('page') ?? 1) - 1;

    const query = { guildId: interaction.guild.id };
    if (filterItem) query.itemId = filterItem;

    const total = await MarketListing.countDocuments(query);

    if (total === 0) {
        return interaction.reply({
            content: filterItem
                ? `No listings found for \`${filterItem}\`.`
                : 'The marketplace is empty.',
            ephemeral: true,
        });
    }

    const totalPages = Math.ceil(total / PAGE_SIZE);
    const page = Math.max(0, Math.min(rawPage, totalPages - 1));

    if (rawPage >= totalPages) {
        return interaction.reply({
            content: `Page ${rawPage + 1} is out of range. There are only **${totalPages}** page(s).`,
            ephemeral: true,
        });
    }

    const listings = await MarketListing.find(query).sort({ pricePerUnit: 1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE);

    const title = filterItem
        ? `📦 Marketplace — ${filterItem}`
        : `📦 Server Marketplace`;

    const lines = await Promise.all(listings.map(async (l, idx) => {
        const sellerTag = await interaction.client.users.fetch(l.sellerId).then(u => u.username).catch(() => 'Unknown');
        const total_price = l.pricePerUnit * l.quantity;
        return `\`${String(l._id).slice(-6)}\`  @${sellerTag}  **${l.quantity}x \`${l.itemId}\`**  ${currency}${l.pricePerUnit.toLocaleString()}/ea  *(${currency}${total_price.toLocaleString()} total)*`;
    }));

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle(title)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Page ${page + 1}/${totalPages} · ${total} listings · 5% market fee on purchase · Use /market buy <listing_id>` })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
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

    const totalCost = listing.pricePerUnit * listing.quantity;
    const feeAmount = Math.floor(totalCost * MARKET_FEE_RATE);
    const sellerReceives = totalCost - feeAmount;

    // Atomically deduct from buyer
    const buyer = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
        { $inc: { balance: -totalCost } },
        { new: true }
    );
    if (!buyer) {
        const fresh = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        return interaction.reply({
            content: `You need **${currency}${totalCost.toLocaleString()}** but only have **${currency}${(fresh?.balance ?? 0).toLocaleString()}**.`,
            ephemeral: true,
        });
    }

    // Remove listing atomically — prevent double-buys
    const removed = await MarketListing.findOneAndDelete({ _id: listing._id, guildId: interaction.guild.id });
    if (!removed) {
        // Someone else bought it first — refund buyer
        await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } });
        return interaction.reply({ content: 'This listing was just sold. Your coins have been refunded.', ephemeral: true });
    }

    // Credit seller and give item to buyer
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
    ]);

    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle('✅ Purchase Complete!')
        .setDescription(`You bought **${listing.quantity}x \`${listing.itemId}\`** for **${currency}${totalCost.toLocaleString()}**.`)
        .addFields(
            { name: 'Fee Burned',       value: `${currency}${feeAmount.toLocaleString()}`, inline: true },
            { name: 'Seller Received',  value: `${currency}${sellerReceives.toLocaleString()}`, inline: true },
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
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

    // Return item to seller
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
