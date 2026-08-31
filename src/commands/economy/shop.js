const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageFlags,
} = require('discord.js');
const Guild = require('../../models/Guild');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const { ensureDefaultShopItems, getItemLore, getItemRarity, isPrestigeItem, isBlackMarketItem, isP8BlackMarketItem, RARITY_ORDER } = require('../../data/defaultShopItems');
const { getItemImageAttachment } = require('../../utils/itemImageHelper');
const { runShopBrowse } = require('../../utils/shopBrowse');
const { logTransaction } = require('../../utils/logTransaction');
const { grantInventoryItem } = require('../../utils/inventoryGrant');
const { ensurePricingFields, trendBucket } = require('../../utils/dynamicPricing');
const { hasUnlock } = require('../../utils/prestige');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');

const CONFIRM_THRESHOLD = 500;
const NEW_ITEM_TTL_MS   = 48 * 3_600_000; // 48 hours

// Upper bound on a single /shop buy. Matches the cap the hunt shop uses so the
// two storefronts behave the same way.
const MAX_BUY_QUANTITY = 20;

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

// Returns effective price for an item — currentPrice if dynamic pricing is enabled and set,
// otherwise the static price.
function effectivePrice(item, dynamicEnabled) {
    if (dynamicEnabled && item.currentPrice != null) return item.currentPrice;
    return item.price;
}

// Build the runShopBrowse page descriptors from the guild's shop items
async function buildShopPages(guildSettings, currency, viewerPrestigeRank = 0) {
    const trending = await getTrendingItemIds(guildSettings.guildId);
    const now = Date.now();
    const dynamicEnabled = !!guildSettings.dynamicPricing?.enabled;
    const showBlackMarket   = hasUnlock(viewerPrestigeRank, 'black_market');
    const showP8BlackMarket = hasUnlock(viewerPrestigeRank, 'p8_black_market');

    // Group items by rarity
    const byRarity = {};
    for (const item of guildSettings.shop) {
        // Hide black-market items from users who haven't unlocked them yet
        if (isBlackMarketItem(item.itemId) && !showBlackMarket) continue;
        if (isP8BlackMarketItem(item.itemId) && !showP8BlackMarket) continue;
        const ep = effectivePrice(item, dynamicEnabled);
        const rarity = getItemRarity(item.itemId, ep);
        if (!byRarity[rarity]) byRarity[rarity] = [];
        byRarity[rarity].push(item);
    }

    // Separate prestige + black-market items into their own pages
    const prestigeItems = [];
    const blackMarketItems = [];
    const standardByRarity = {};
    for (const rarity of RARITY_ORDER) {
        const items = byRarity[rarity];
        if (!items) continue;
        for (const item of items) {
            if (isBlackMarketItem(item.itemId) || isP8BlackMarketItem(item.itemId)) {
                blackMarketItems.push(item);
            } else if (isPrestigeItem(item.itemId)) {
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
            const ep = effectivePrice(item, dynamicEnabled);
            const trendStr = dynamicEnabled ? ` ${trendBucket(item).arrow}` : '';
            return {
                name:    item.name,
                imageId: item.itemId,
                emoji:   extractEmoji(item.description),
                price:   ep,
                badge,
                subline: `Stock: ${stock}${item.roleId ? ' · Role reward' : ''}${trendStr}`,
            };
        });

        const listText = items.map((item, i) => {
            const stock = item.stock === -1 ? '∞' : item.stock;
            const ep = effectivePrice(item, dynamicEnabled);
            const trendStr = dynamicEnabled ? ` ${trendBucket(item).arrow}` : '';
            return `**${i + 1}. ${item.name}** — ${currency}${ep.toLocaleString()}${trendStr} (Stock: ${stock})`;
        }).join('\n') + `\n\n*Use /shop buy <item name> [quantity] to purchase*`;

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
            const ep = effectivePrice(item, dynamicEnabled);
            return {
                name:    item.name,
                imageId: item.itemId,
                emoji:   extractEmoji(item.description),
                price:   ep,
                badge,
                subline: `Stock: ${stock} · Prestige`,
            };
        });
        const listText =
            `**✨ Prestige items** — high-cost purchases that flex your wealth and unlock server perks.\n` +
            `*Save up and make a statement.*\n\n` +
            prestigeItems.map((item, i) => {
                const stock = item.stock === -1 ? '∞' : item.stock;
                const ep = effectivePrice(item, dynamicEnabled);
                return `**${i + 1}. ${item.name}** — ${currency}${ep.toLocaleString()} (Stock: ${stock})`;
            }).join('\n') +
            `\n\n*Use /shop buy <item name> [quantity] to purchase*`;

        pages.push({
            id:       'prestige',
            label:    'Prestige',
            emoji:    '✨',
            subtitle: `${prestigeItems.length} aspirational item${prestigeItems.length !== 1 ? 's' : ''}`,
            items:    pageItems,
            listText,
        });
    }

    // Black market — only visible to viewers with the unlock
    if (blackMarketItems.length > 0) {
        const pageItems = blackMarketItems.map(item => {
            const stock = item.stock === -1 ? '∞' : String(item.stock);
            const ep = effectivePrice(item, dynamicEnabled);
            const reqLabel = isP8BlackMarketItem(item.itemId) ? 'Prestige VIII+ only' : 'Prestige I+ only';
            return {
                name:    item.name,
                imageId: item.itemId,
                emoji:   extractEmoji(item.description),
                price:   ep,
                badge:   'BLACK MARKET',
                subline: `Stock: ${stock} · ${reqLabel}`,
            };
        });
        const listText =
            `**🏴 Black Market** — exclusive contraband only available to prestige holders.\n` +
            `*No questions asked. No receipts given.*\n\n` +
            blackMarketItems.map((item, i) => {
                const stock = item.stock === -1 ? '∞' : item.stock;
                const ep = effectivePrice(item, dynamicEnabled);
                return `**${i + 1}. ${item.name}** — ${currency}${ep.toLocaleString()} (Stock: ${stock})`;
            }).join('\n') +
            `\n\n*Use /shop buy <item name> [quantity] to purchase*`;

        pages.push({
            id:       'black_market',
            label:    'Black Market',
            emoji:    '🏴',
            subtitle: `${blackMarketItems.length} contraband item${blackMarketItems.length !== 1 ? 's' : ''}`,
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
                .addStringOption(o => o.setName('item').setDescription('Item to buy').setRequired(true).setAutocomplete(true))
                .addIntegerOption(o =>
                    o.setName('quantity')
                        .setDescription(`How many to buy (default: 1, max: ${MAX_BUY_QUANTITY})`)
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(MAX_BUY_QUANTITY)))
        .addSubcommand(sub =>
            sub.setName('trends')
                .setDescription('Show price movement on shop items (dynamic pricing must be enabled).'))
        .setDefaultMemberPermissions(null),

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused()?.toLowerCase() ?? '';
            const [guildSettings, viewer] = await Promise.all([
                getGuildSettings(interaction.guild.id),
                User.findOne(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    'accountPrestige'
                ).lean(),
            ]);

            const rank = viewer?.accountPrestige?.rank ?? 0;
            const currency = guildSettings?.economy?.currency ?? '';
            const dynamicEnabled = !!guildSettings?.dynamicPricing?.enabled;

            // Don't advertise items the buyer can't purchase yet.
            const items = (guildSettings?.shop ?? []).filter(i => {
                if (isBlackMarketItem(i.itemId)   && !hasUnlock(rank, 'black_market'))    return false;
                if (isP8BlackMarketItem(i.itemId) && !hasUnlock(rank, 'p8_black_market')) return false;
                return true;
            });

            const matches = focused
                ? items.filter(i => i.name.toLowerCase().includes(focused))
                : items;

            // Prefix matches first, then substring matches, so typing "pet" surfaces
            // "Pet Food" ahead of "Carpet".
            const ranked = focused
                ? [...matches].sort((a, b) => {
                    const aPre = a.name.toLowerCase().startsWith(focused) ? 0 : 1;
                    const bPre = b.name.toLowerCase().startsWith(focused) ? 0 : 1;
                    return aPre - bPre || a.name.localeCompare(b.name);
                })
                : matches;

            await interaction.respond(
                ranked.slice(0, 25).map(i => {
                    const price = effectivePrice(i, dynamicEnabled);
                    const stock = i.stock === 0 ? ' · out of stock' : (i.stock > 0 ? ` · ${i.stock} left` : '');
                    return {
                        name:  `${i.name} — ${currency}${price.toLocaleString()}${stock}`.slice(0, 100),
                        value: i.name,
                    };
                })
            );
        } catch (err) {
            console.error('[shop] autocomplete error:', err);
            await interaction.respond([]).catch(() => {});
        }
    },

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $setOnInsert: { name: interaction.guild.name } },
            { upsert: true, new: true }
        );

        const seededDefaults = ensureDefaultShopItems(guildSettings);
        const seededPrices   = ensurePricingFields(guildSettings.shop);
        if (seededDefaults || seededPrices) {
            await guildSettings.save();
        }

        const currency = guildSettings.economy.currency;

        // Viewer's prestige rank (used to gate Black Market and other unlock-tabs)
        const viewer = await User.findOne(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            'accountPrestige'
        ).lean();
        const viewerPrestigeRank = viewer?.accountPrestige?.rank ?? 0;

        // ── VIEW ──────────────────────────────────────────────────────────────
        if (sub === 'view') {
            if (!guildSettings.shop.length) {
                return interaction.reply({ content: 'The shop is empty. Admins can add items via the dashboard.', flags: MessageFlags.Ephemeral });
            }

            const pages = await buildShopPages(guildSettings, currency, viewerPrestigeRank);
            if (!pages.length) {
                return interaction.reply({ content: 'The shop is empty.', flags: MessageFlags.Ephemeral });
            }

            const userData = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            const userBalance = userData?.balance ?? 0;
            const balanceFooter = `Balance: ${currency}${userBalance.toLocaleString()} · Use /shop buy <item name> [quantity]`;

            return runShopBrowse(interaction, {
                activity: pages[0].id.replace('rarity_', 'shop_'),
                title:    `${interaction.guild.name} Shop`,
                currency,
                footer:   balanceFooter,
                guildId:  interaction.guild.id,
                pages,
            });
        }

        // ── TRENDS ────────────────────────────────────────────────────────────
        if (sub === 'trends') {
            if (!guildSettings.dynamicPricing?.enabled) {
                return interaction.reply({ content: 'Dynamic pricing is disabled on this server.', flags: MessageFlags.Ephemeral });
            }
            const movers = guildSettings.shop
                .filter(item => !isBlackMarketItem(item.itemId) || hasUnlock(viewerPrestigeRank, 'black_market'))
                .filter(item => !isP8BlackMarketItem(item.itemId) || hasUnlock(viewerPrestigeRank, 'p8_black_market'))
                .map(item => {
                    const tb = trendBucket(item);
                    return { item, pct: tb.pct, arrow: tb.arrow };
                })
                .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
                .slice(0, 12);

            const lines = movers.map(({ item, pct, arrow }) => {
                const base = item.basePrice ?? item.price;
                const cur  = item.currentPrice ?? base;
                const sign = pct >= 0 ? '+' : '';
                return `${arrow} **${item.name}** — ${currency}${cur.toLocaleString()} (base ${currency}${base.toLocaleString()}, ${sign}${pct.toFixed(1)}%)`;
            });

            const lastRecalc = guildSettings.dynamicPricing.lastRecalcAt;
            const recalcStr = lastRecalc
                ? `Last recalc <t:${Math.floor(new Date(lastRecalc).getTime() / 1000)}:R>`
                : 'No recalcs yet — pricing will adjust on the next scheduled run.';

            const embed = new EmbedBuilder()
                .setColor(COLORS.INFO)
                .setTitle('📊 Market Trends')
                .setDescription(lines.length ? lines.join('\n') : 'No price movement yet.')
                .setFooter({ text: `${recalcStr} · Volatility: ${guildSettings.dynamicPricing.volatility}` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        // ── BUY ───────────────────────────────────────────────────────────────
        if (sub === 'buy') {
            const rawName  = interaction.options.getString('item');
            const itemName = rawName.toLowerCase();
            const quantity = interaction.options.getInteger('quantity') ?? 1;

            // Exact matches win — display name first (what autocomplete sends), then
            // canonical itemId. Only then fall back to a partial name match, so a
            // hand-typed itemId can never be shadowed by some other item that merely
            // contains it in its display name.
            const item = guildSettings.shop.find(i => i.name.toLowerCase() === itemName)
                ?? guildSettings.shop.find(i => (i.itemId ?? '').toLowerCase() === itemName)
                ?? guildSettings.shop.find(i => i.name.toLowerCase().includes(itemName));

            if (!item) {
                return interaction.reply({ content: `Item \`${rawName}\` not found. Use \`/shop view\` to see available items.`, flags: MessageFlags.Ephemeral });
            }

            // Resolved name is what every later lookup keys off, so a partial match
            // can't drift onto a different item mid-purchase.
            const matchedName = item.name.toLowerCase();

            // Gate Black Market behind prestige unlock
            if (isBlackMarketItem(item.itemId) && !hasUnlock(viewerPrestigeRank, 'black_market')) {
                return interaction.reply({
                    content: 'That item is sold on the Black Market — reach **Prestige I** to unlock it.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Gate P8 Black Market exclusives behind the higher prestige unlock
            if (isP8BlackMarketItem(item.itemId) && !hasUnlock(viewerPrestigeRank, 'p8_black_market')) {
                return interaction.reply({
                    content: 'That item is sold in the deep Black Market — reach **Prestige VIII** to unlock it.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (item.stock === 0) {
                return interaction.reply({ content: 'That item is out of stock!', flags: MessageFlags.Ephemeral });
            }

            // A role reward is granted once — buying ten of them would just charge
            // ten times for the same role.
            if (item.roleId && quantity > 1) {
                return interaction.reply({
                    content: `**${item.name}** grants a role, so it can only be bought one at a time.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (item.stock > 0 && item.stock < quantity) {
                return interaction.reply({
                    content: `Only **${item.stock}× ${item.name}** left in stock — you asked for ${quantity}.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const dynamicEnabled = !!guildSettings.dynamicPricing?.enabled;
            const itemPrice = effectivePrice(item, dynamicEnabled);
            const totalCost = itemPrice * quantity;

            const userData = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
                { upsert: true, new: true }
            );

            if (userData.balance < totalCost) {
                // With dynamic pricing the unit price isn't obvious from /shop view,
                // so spell out how many they could actually afford.
                const affordable = itemPrice > 0 ? Math.floor(userData.balance / itemPrice) : 0;
                const hint = quantity > 1 && affordable > 0
                    ? ` You can afford **${affordable}** at ${currency}${itemPrice.toLocaleString()} each.`
                    : '';
                const wanted = quantity > 1 ? ` for ${quantity}× **${item.name}**` : '';
                return interaction.reply({
                    content: `You need ${currency}${totalCost.toLocaleString()}${wanted} but only have ${currency}${userData.balance.toLocaleString()}.${hint}`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const doPurchase = async (reply) => {
                // Re-fetch to catch any changes since the pre-check (stock sold out, balance changed)
                const [freshGuild, freshUser] = await Promise.all([
                    getGuildSettings(interaction.guild.id),
                    User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id })
                ]);

                const freshItem = freshGuild?.shop.find(i => i.name.toLowerCase() === matchedName);
                if (!freshItem || freshItem.stock === 0) {
                    return reply({ content: 'That item is no longer available.', embeds: [], components: [] });
                }
                if (freshItem.stock > 0 && freshItem.stock < quantity) {
                    return reply({
                        content: `Only **${freshItem.stock}× ${freshItem.name}** left in stock — you asked for ${quantity}. Nothing was charged.`,
                        embeds: [], components: []
                    });
                }
                const freshPrice = effectivePrice(freshItem, !!freshGuild.dynamicPricing?.enabled);
                const freshTotal = freshPrice * quantity;

                // A dynamic-pricing recalc can land between the quote and the charge.
                // Never debit more than the buyer was shown — bail out and make them
                // re-run so the new total gets quoted (and re-checked against
                // CONFIRM_THRESHOLD) before any coins move. A price *drop* is safe to
                // honour: they pay less than they agreed to.
                if (freshTotal > totalCost) {
                    return reply({
                        content:
                            `The price of **${freshItem.name}** changed while you were deciding — ` +
                            `${quantity > 1 ? `${quantity}× ` : ''}now costs ${currency}${freshTotal.toLocaleString()}, ` +
                            `not ${currency}${totalCost.toLocaleString()}. Nothing was charged; ` +
                            `run \`/shop buy\` again to accept the new price.`,
                        embeds: [], components: []
                    });
                }

                if (!freshUser || freshUser.balance < freshTotal) {
                    const wanted = quantity > 1 ? ` for ${quantity}× **${freshItem.name}**` : '';
                    return reply({
                        content: `You need ${currency}${freshTotal.toLocaleString()}${wanted} but only have ${currency}${(freshUser?.balance ?? 0).toLocaleString()}.`,
                        embeds: [], components: []
                    });
                }

                // Atomically deduct balance — prevents double-spend if balance changed between checks
                const chargedUser = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: freshTotal } },
                    { $inc: { balance: -freshTotal } },
                    { new: true }
                );
                if (!chargedUser) {
                    return reply({ content: `You no longer have enough ${currency} for this purchase.`, embeds: [], components: [] });
                }

                // Atomically decrement stock if limited; refund on sell-out race.
                // $elemMatch binds both predicates to the SAME array element so
                // the positional update can't accidentally decrement a different
                // item just because some other item happens to have stock > 0.
                // Guarding on `>= quantity` makes the whole batch all-or-nothing —
                // a concurrent buyer can't leave this one partially filled.
                if (freshItem.stock > 0) {
                    const stockResult = await Guild.findOneAndUpdate(
                        {
                            guildId: interaction.guild.id,
                            shop: { $elemMatch: { _id: freshItem._id, stock: { $gte: quantity } } },
                        },
                        { $inc: { 'shop.$.stock': -quantity } }
                    );
                    if (!stockResult) {
                        try {
                            await User.findOneAndUpdate(
                                { userId: interaction.user.id, guildId: interaction.guild.id },
                                { $inc: { balance: freshTotal } }
                            );
                            return reply({
                                content: quantity > 1
                                    ? `There aren't ${quantity} left in stock anymore. Your coins have been refunded.`
                                    : 'That item just sold out. Your coins have been refunded.',
                                embeds: [], components: []
                            });
                        } catch (refundErr) {
                            console.error('[shop] refund failed after sell-out:', refundErr);
                            return reply({ content: 'That item just sold out and the automatic refund failed — please contact support.', embeds: [], components: [] });
                        }
                    }
                }

                // Bump demand score so the next price recalc moves this item's price up.
                // Scaled by quantity so a bulk buy moves the market like the same
                // number of single buys would.
                if (freshGuild.dynamicPricing?.enabled) {
                    await Guild.updateOne(
                        { guildId: interaction.guild.id, 'shop._id': freshItem._id },
                        { $inc: { 'shop.$.demandScore': quantity } }
                    ).catch(err => console.error('[shop] demand bump failed:', err));
                }

                // Use the item's canonical itemId if set, otherwise fall back to its name
                const inventoryId = freshItem.itemId || freshItem.name;

                // Inventory upsert in a single atomic aggregation-pipeline update:
                // when the itemId exists, bump its quantity by the amount bought;
                // otherwise append a new entry. Done in one call so concurrent buys
                // can't race between an unsuccessful $inc and a guarded $push and
                // lose units.
                const stockedUser = await grantInventoryItem(
                    interaction.user.id, interaction.guild.id, inventoryId, quantity
                ).catch(err => {
                    console.error('[shop] inventory grant failed:', err);
                    return null;
                });

                if (!stockedUser) {
                    // Roll back the charge and the stock we just took so the buyer
                    // isn't left paying for items they never received.
                    await User.updateOne(
                        { userId: interaction.user.id, guildId: interaction.guild.id },
                        { $inc: { balance: freshTotal } }
                    ).catch(err => console.error('[shop] refund after failed grant:', err));
                    if (freshItem.stock > 0) {
                        await Guild.updateOne(
                            { guildId: interaction.guild.id, 'shop._id': freshItem._id },
                            { $inc: { 'shop.$.stock': quantity } }
                        ).catch(err => console.error('[shop] stock restore after failed grant:', err));
                    }
                    return reply({ content: 'Purchase failed — your coins have been refunded. Please try again.', embeds: [], components: [] });
                }

                const ownedNow = stockedUser.inventory?.find(s => s.itemId === inventoryId)?.quantity ?? quantity;

                if (freshItem.roleId) {
                    await interaction.member.roles.add(freshItem.roleId).catch(console.error);
                }

                logTransaction({
                    userId:  interaction.user.id,
                    guildId: interaction.guild.id,
                    type:    'shop_buy',
                    amount:  -freshTotal,
                    balance: chargedUser.balance,
                    note:    inventoryId,
                });

                const boughtLabel = quantity > 1 ? `${quantity}× **${freshItem.name}**` : `**${freshItem.name}**`;
                const successLore = getItemLore(freshItem.itemId);
                const successDesc = successLore
                    ? `You bought ${boughtLabel} for ${currency}${freshTotal.toLocaleString()}.\n\n*${successLore}*`
                    : `You bought ${boughtLabel} for ${currency}${freshTotal.toLocaleString()}.`;
                const successEmbed = new EmbedBuilder()
                    .setColor(COLORS.SUCCESS)
                    .setTitle('Purchase Successful')
                    .setDescription(successDesc)
                    .addFields({ name: 'New Balance', value: `${currency}${chargedUser.balance.toLocaleString()}`, inline: true });

                if (quantity > 1) {
                    successEmbed.addFields({ name: 'Unit Price', value: `${currency}${freshPrice.toLocaleString()}`, inline: true });
                }
                successEmbed.addFields({ name: 'In Inventory', value: `${ownedNow.toLocaleString()}× ${freshItem.name}`, inline: true });

                if (freshItem.roleId) {
                    successEmbed.addFields({ name: 'Role Granted', value: `<@&${freshItem.roleId}>`, inline: true });
                }

                const successImg = await getItemImageAttachment(freshItem.itemId, interaction.guildId, { label: freshItem.name }).catch(() => null);
                if (successImg) successEmbed.setThumbnail(successImg.url);
                const successPayload = { embeds: [successEmbed], components: [] };
                if (successImg) successPayload.files = [successImg.attachment];
                return reply(successPayload);
            };

            // Threshold is checked against the total, so a bulk buy of cheap items
            // still asks for confirmation before it drains a wallet.
            if (totalCost >= CONFIRM_THRESHOLD) {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('shop_confirm').setLabel('Confirm Purchase').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('shop_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                );

                const buyLabel = quantity > 1 ? `${quantity}× **${item.name}**` : `**${item.name}**`;
                const confirmLore = getItemLore(item.itemId);
                const confirmDesc = confirmLore
                    ? `Buy ${buyLabel} for **${currency}${totalCost.toLocaleString()}**?\n\n*${confirmLore}*`
                    : `Buy ${buyLabel} for **${currency}${totalCost.toLocaleString()}**?`;
                const confirmEmbed = new EmbedBuilder()
                    .setColor(COLORS.WARN)
                    .setTitle('Confirm Purchase')
                    .setDescription(confirmDesc);

                if (quantity > 1) {
                    confirmEmbed.addFields(
                        { name: 'Quantity',   value: `${quantity}× ${item.name}`,                  inline: true },
                        { name: 'Unit Price', value: `${currency}${itemPrice.toLocaleString()}`,   inline: true },
                        { name: 'Total Cost', value: `${currency}${totalCost.toLocaleString()}`,   inline: true }
                    );
                }

                confirmEmbed
                    .addFields(
                        { name: 'Your Balance', value: `${currency}${userData.balance.toLocaleString()}`, inline: true },
                        { name: 'After Purchase', value: `${currency}${(userData.balance - totalCost).toLocaleString()}`, inline: true }
                    )
                    .setFooter({ text: 'This confirmation expires in 30 seconds' });

                const confirmImg = await getItemImageAttachment(item.itemId, interaction.guildId, { label: item.name }).catch(() => null);
                if (confirmImg) confirmEmbed.setThumbnail(confirmImg.url);
                const confirmPayload = { embeds: [confirmEmbed], components: [row], fetchReply: true };
                if (confirmImg) confirmPayload.files = [confirmImg.attachment];
                const msg = await interaction.reply(confirmPayload);

                const collector = msg.createMessageComponentCollector({
                    componentType: ComponentType.Button,
                    filter: ownedBy(interaction.user.id, "This isn't your purchase."),
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
