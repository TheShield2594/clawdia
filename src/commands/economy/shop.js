const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
} = require('discord.js');
const Guild = require('../../models/Guild');
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const { ensureDefaultShopItems, getItemLore, getItemRarity, isPrestigeItem, RARITY_ORDER } = require('../../data/defaultShopItems');
const { getItemImageAttachment } = require('../../utils/itemImageHelper');
const { runShopBrowse } = require('../../utils/shopBrowse');
const { logTransaction } = require('../../utils/logTransaction');

const CONFIRM_THRESHOLD = 500;
const NEW_ITEM_TTL_MS   = 48 * 3_600_000; // 48 hours

const RARITY_EMOJIS = {
    Common:   '⚪',
    Uncommon: '🟢',
    Rare:     '🔵',
    Epic:     '🟣',
    Mythic:   '🟠',
};

// Extract the leading emoji from a description string (e.g. '🔒 Protects…' → '🔒')
function extractEmoji(str) {
    if (!str) return '';
    const m = str.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
    return m ? m[0] : '';
}

// Returns the set of itemIds bought by 3+ unique users in the last 24h
async function getTrendingItemIds(guildId) {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const rows = await Transaction.aggregate([
        { $match: { guildId, type: 'shop_buy', createdAt: { $gte: since } } },
        { $group: { _id: '$note', buyers: { $addToSet: '$userId' } } },
        { $match: { 'buyers.2': { $exists: true } } },
    ]);
    return new Set(rows.map(r => r._id));
}

// Build the runShopBrowse page descriptors from the guild's shop items
async function buildShopPages(guildSettings, currency) {
    const trending = await getTrendingItemIds(guildSettings.guildId);
    const now = Date.now();

    // Group items by rarity
    const byRarity = {};
    for (const item of guildSettings.shop) {
        const rarity = getItemRarity(item.itemId, item.price);
        if (!byRarity[rarity]) byRarity[rarity] = [];
        byRarity[rarity].push(item);
    }

    // Separate prestige items into their own page
    const prestigeItems = [];
    const standardByRarity = {};
    for (const rarity of RARITY_ORDER) {
        const items = byRarity[rarity];
        if (!items) continue;
        for (const item of items) {
            if (isPrestigeItem(item.itemId)) {
                prestigeItems.push(item);
            } else {
                if (!standardByRarity[rarity]) standardByRarity[rarity] = [];
                standardByRarity[rarity].push(item);
            }
        }
    }

    const pages = [];
    for (const rarity of RARITY_ORDER) {
        const items = standardByRarity[rarity];
        if (!items || items.length === 0) continue;

        const emoji = RARITY_EMOJIS[rarity] || '⚫';

        const pageItems = items.map(item => {
            let badge = null;
            const iid = item.itemId || item.name;
            if (item.createdAt && now - new Date(item.createdAt).getTime() < NEW_ITEM_TTL_MS) {
                badge = 'NEW';
            } else if (trending.has(iid)) {
                badge = 'TRENDING';
            }
            const stock = item.stock === -1 ? '∞' : String(item.stock);
            return {
                name:    item.name,
                emoji:   extractEmoji(item.description),
                price:   item.price,
                badge,
                subline: `Stock: ${stock}${item.roleId ? ' · Role reward' : ''}`,
            };
        });

        const listText = items.map((item, i) => {
            const stock = item.stock === -1 ? '∞' : item.stock;
            return `**${i + 1}. ${item.name}** — ${currency}${item.price.toLocaleString()} (Stock: ${stock})`;
        }).join('\n') + `\n\n*Use /shop buy <item name> to purchase*`;

        pages.push({
            id:       `rarity_${rarity.toLowerCase()}`,
            label:    `${rarity}`,
            emoji,
            subtitle: `${items.length} item${items.length !== 1 ? 's' : ''}`,
            items:    pageItems,
            listText,
        });
    }

    // Prestige page — high-cost aspirational items shown last with special treatment
    if (prestigeItems.length > 0) {
        const pageItems = prestigeItems.map(item => {
            let badge = null;
            const iid = item.itemId || item.name;
            if (item.createdAt && now - new Date(item.createdAt).getTime() < NEW_ITEM_TTL_MS) {
                badge = 'NEW';
            } else if (trending.has(iid)) {
                badge = 'TRENDING';
            }
            const stock = item.stock === -1 ? '∞' : String(item.stock);
            return {
                name:    item.name,
                emoji:   extractEmoji(item.description),
                price:   item.price,
                badge,
                subline: `Stock: ${stock} · Prestige`,
            };
        });
        const listText =
            `**✨ Prestige items** — high-cost purchases that flex your wealth and unlock server perks.\n` +
            `*Save up and make a statement.*\n\n` +
            prestigeItems.map((item, i) => {
                const stock = item.stock === -1 ? '∞' : item.stock;
                return `**${i + 1}. ${item.name}** — ${currency}${item.price.toLocaleString()} (Stock: ${stock})`;
            }).join('\n') +
            `\n\n*Use /shop buy <item name> to purchase*`;

        pages.push({
            id:       'prestige',
            label:    'Prestige',
            emoji:    '✨',
            subtitle: `${prestigeItems.length} aspirational item${prestigeItems.length !== 1 ? 's' : ''}`,
            items:    pageItems,
            listText,
        });
    }

    return pages;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('shop')
        .setDescription('Browse and buy items from the server shop')
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('Browse available items'))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Purchase an item from the shop')
                .addStringOption(o => o.setName('item').setDescription('Exact name of the item to buy (see /shop view for the full list)').setRequired(true)))
        .setDefaultMemberPermissions(null),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $setOnInsert: { name: interaction.guild.name } },
            { upsert: true, new: true }
        );

        if (ensureDefaultShopItems(guildSettings)) {
            await guildSettings.save();
        }

        const currency = guildSettings.economy.currency;

        // ── VIEW ──────────────────────────────────────────────────────────────
        if (sub === 'view') {
            if (!guildSettings.shop.length) {
                return interaction.reply({ content: 'The shop is empty. Admins can add items via the dashboard.', ephemeral: true });
            }

            const pages = await buildShopPages(guildSettings, currency);
            if (!pages.length) {
                return interaction.reply({ content: 'The shop is empty.', ephemeral: true });
            }

            const userData = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            const userBalance = userData?.balance ?? 0;
            const balanceFooter = `Balance: ${currency}${userBalance.toLocaleString()} · Use /shop buy <item name>`;

            return runShopBrowse(interaction, {
                activity: pages[0].id.replace('rarity_', 'shop_'),
                title:    `${interaction.guild.name} Shop`,
                currency,
                footer:   balanceFooter,
                pages,
            });
        }

        // ── BUY ───────────────────────────────────────────────────────────────
        if (sub === 'buy') {
            const itemName = interaction.options.getString('item').toLowerCase();
            const item = guildSettings.shop.find(i => i.name.toLowerCase() === itemName);

            if (!item) {
                return interaction.reply({ content: `Item \`${itemName}\` not found. Use \`/shop view\` to see available items.`, ephemeral: true });
            }

            if (item.stock === 0) {
                return interaction.reply({ content: 'That item is out of stock!', ephemeral: true });
            }

            const userData = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
                { upsert: true, new: true }
            );

            if (userData.balance < item.price) {
                return interaction.reply({
                    content: `You need ${currency}${item.price.toLocaleString()} but only have ${currency}${userData.balance.toLocaleString()}.`,
                    ephemeral: true
                });
            }

            const doPurchase = async (reply) => {
                // Re-fetch to catch any changes since the pre-check (stock sold out, balance changed)
                const [freshGuild, freshUser] = await Promise.all([
                    Guild.findOne({ guildId: interaction.guild.id }),
                    User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id })
                ]);

                const freshItem = freshGuild?.shop.find(i => i.name.toLowerCase() === itemName);
                if (!freshItem || freshItem.stock === 0) {
                    return reply({ content: 'That item is no longer available.', embeds: [], components: [] });
                }
                if (!freshUser || freshUser.balance < freshItem.price) {
                    return reply({
                        content: `You need ${currency}${freshItem.price.toLocaleString()} but only have ${currency}${(freshUser?.balance ?? 0).toLocaleString()}.`,
                        embeds: [], components: []
                    });
                }

                // Atomically deduct balance — prevents double-spend if balance changed between checks
                const chargedUser = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: freshItem.price } },
                    { $inc: { balance: -freshItem.price } },
                    { new: true }
                );
                if (!chargedUser) {
                    return reply({ content: `You no longer have enough ${currency} for this purchase.`, embeds: [], components: [] });
                }

                // Atomically decrement stock if limited; refund on sell-out race
                if (freshItem.stock > 0) {
                    const stockResult = await Guild.findOneAndUpdate(
                        { guildId: interaction.guild.id, 'shop._id': freshItem._id, 'shop.stock': { $gt: 0 } },
                        { $inc: { 'shop.$.stock': -1 } }
                    );
                    if (!stockResult) {
                        try {
                            await User.findOneAndUpdate(
                                { userId: interaction.user.id, guildId: interaction.guild.id },
                                { $inc: { balance: freshItem.price } }
                            );
                            return reply({ content: 'That item just sold out. Your coins have been refunded.', embeds: [], components: [] });
                        } catch (refundErr) {
                            console.error('[shop] refund failed after sell-out:', refundErr);
                            return reply({ content: 'That item just sold out and the automatic refund failed — please contact support.', embeds: [], components: [] });
                        }
                    }
                }

                // Use the item's canonical itemId if set, otherwise fall back to its name
                const inventoryId = freshItem.itemId || freshItem.name;

                // Update inventory atomically: increment if entry exists, otherwise push
                const incResult = await User.updateOne(
                    { userId: interaction.user.id, guildId: interaction.guild.id, 'inventory.itemId': inventoryId },
                    { $inc: { 'inventory.$.quantity': 1 } }
                );
                if (incResult.modifiedCount === 0) {
                    // No existing entry — push a new one; $ne guard makes this a no-op if a
                    // concurrent request already inserted the entry between these two operations
                    await User.updateOne(
                        { userId: interaction.user.id, guildId: interaction.guild.id, 'inventory.itemId': { $ne: inventoryId } },
                        { $push: { inventory: { itemId: inventoryId, quantity: 1 } } }
                    );
                }

                if (freshItem.roleId) {
                    await interaction.member.roles.add(freshItem.roleId).catch(console.error);
                }

                logTransaction({
                    userId:  interaction.user.id,
                    guildId: interaction.guild.id,
                    type:    'shop_buy',
                    amount:  -freshItem.price,
                    balance: chargedUser.balance,
                    note:    inventoryId,
                });

                const successLore = getItemLore(freshItem.itemId);
                const successDesc = successLore
                    ? `You bought **${freshItem.name}** for ${currency}${freshItem.price.toLocaleString()}.\n\n*${successLore}*`
                    : `You bought **${freshItem.name}** for ${currency}${freshItem.price.toLocaleString()}.`;
                const successEmbed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Purchase Successful')
                    .setDescription(successDesc)
                    .addFields({ name: 'New Balance', value: `${currency}${chargedUser.balance.toLocaleString()}`, inline: true });

                if (freshItem.roleId) {
                    successEmbed.addFields({ name: 'Role Granted', value: `<@&${freshItem.roleId}>`, inline: true });
                }

                const successImg = await getItemImageAttachment(freshItem.itemId, interaction.guildId).catch(() => null);
                if (successImg) successEmbed.setThumbnail(successImg.url);
                const successPayload = { embeds: [successEmbed], components: [] };
                if (successImg) successPayload.files = [successImg.attachment];
                return reply(successPayload);
            };

            if (item.price >= CONFIRM_THRESHOLD) {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('shop_confirm').setLabel('Confirm Purchase').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('shop_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                );

                const confirmLore = getItemLore(item.itemId);
                const confirmDesc = confirmLore
                    ? `Buy **${item.name}** for **${currency}${item.price.toLocaleString()}**?\n\n*${confirmLore}*`
                    : `Buy **${item.name}** for **${currency}${item.price.toLocaleString()}**?`;
                const confirmEmbed = new EmbedBuilder()
                    .setColor('#f39c12')
                    .setTitle('Confirm Purchase')
                    .setDescription(confirmDesc)
                    .addFields(
                        { name: 'Your Balance', value: `${currency}${userData.balance.toLocaleString()}`, inline: true },
                        { name: 'After Purchase', value: `${currency}${(userData.balance - item.price).toLocaleString()}`, inline: true }
                    )
                    .setFooter({ text: 'This confirmation expires in 30 seconds' });

                const confirmImg = await getItemImageAttachment(item.itemId, interaction.guildId).catch(() => null);
                if (confirmImg) confirmEmbed.setThumbnail(confirmImg.url);
                const confirmPayload = { embeds: [confirmEmbed], components: [row], fetchReply: true };
                if (confirmImg) confirmPayload.files = [confirmImg.attachment];
                const msg = await interaction.reply(confirmPayload);

                const collector = msg.createMessageComponentCollector({
                    componentType: ComponentType.Button,
                    filter: i => i.user.id === interaction.user.id,
                    time: 30_000,
                    max: 1
                });

                collector.on('collect', async btn => {
                    if (btn.customId === 'shop_cancel') {
                        return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
                    }
                    await btn.deferUpdate();
                    try {
                        await doPurchase(opts => interaction.editReply(opts));
                    } catch (err) {
                        console.error(err);
                        interaction.editReply({ content: 'Something went wrong processing your purchase. Please try again.', embeds: [], components: [] }).catch(() => {});
                    }
                });

                collector.on('end', (collected, reason) => {
                    if (reason === 'time' && collected.size === 0) {
                        interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
                    }
                });

                return;
            }

            await interaction.deferReply();
            try {
                await doPurchase(opts => interaction.editReply(opts));
            } catch (err) {
                console.error(err);
                interaction.editReply({ content: 'Something went wrong processing your purchase. Please try again.', embeds: [], components: [] }).catch(() => {});
            }
            return;
        }

    }
};
