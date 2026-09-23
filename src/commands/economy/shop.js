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
const { ensureDefaultShopItems, getItemLore, getItemRarity, defaultItemIdByName, isPrestigeItem, isBlackMarketItem, isP8BlackMarketItem, RARITY_ORDER } = require('../../data/defaultShopItems');
const { getItemImageAttachment } = require('../../utils/itemImageHelper');
const { hasDefaultItemImage } = require('../../utils/defaultItemImages');
const { runShopBrowse } = require('../../utils/shopBrowse');
const { logTransaction } = require('../../utils/logTransaction');
const { creditCoinsOrOwe, grantItemsOrOwe } = require('../../utils/creditOrOwe');
const { serverShopGrantPayoutKey, serverShopRefundPayoutKey } = require('../../utils/payoutKey');
const { shopRefundMessage } = require('../../utils/grindShop');
const { ensurePricingFields, trendBucket } = require('../../utils/dynamicPricing');
const { hasUnlock } = require('../../utils/prestige');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');
// The grind shops expose their browse pages so /shop can host them as sections
// of one storefront (the game commands keep their own /X shop list shortcut).
const { attachGrind } = require('../../utils/grindProfile');
const { ensureHuntData } = require('../../services/huntService');
const { ensureFishingData } = require('../../services/fishService');
const { ensureMineData } = require('../../services/mineService');
const { buildHuntShopPages } = require('./hunt/shop/list');
const { buildFishShopPages } = require('./fish/shop/list');
const { buildMineShopPages } = require('./mine/shop/list');

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

// The id to look an item's artwork up under. Normally its stored itemId, but a
// guild seeded before the `itemId` field existed carries default items with a
// null id, so their baked icon never resolves and the shop view shows the emoji
// glyph instead of the catalogue art. Recover the catalogue id from the display
// name — the one field those old rows still have — but only when there is no
// stored id to protect, so a custom item that named itself after a default and
// uploaded its own image is never shadowed by the bundled one.
function shopIconId(item) {
    if (item.itemId && hasDefaultItemImage(item.itemId)) return item.itemId;
    if (!item.itemId) {
        const byName = defaultItemIdByName(item.name);
        if (byName) return byName;
    }
    return item.itemId;
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

    // Present every page's items in A→Z order rather than raw shop-array order.
    const byName = (a, b) => a.name.localeCompare(b.name);
    for (const rarity of Object.keys(standardByRarity)) standardByRarity[rarity].sort(byName);
    prestigeItems.sort(byName);
    blackMarketItems.sort(byName);

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
                buyId:   item.name,
                imageId: shopIconId(item),
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
            activity: `shop_${rarity.toLowerCase()}`,
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
                buyId:   item.name,
                imageId: shopIconId(item),
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
            activity: 'shop_mythic',
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
                buyId:   item.name,
                imageId: shopIconId(item),
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
            activity: 'shop_common',
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
        .setDescription('Browse and buy items from the server, hunt, fish and mine shops')
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('Browse the server shop plus hunt, fish and mine gear'))
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
            // "Pet Food" ahead of "Carpet". With no input, fall back to a plain
            // alphabetical list so the shop always reads in A→Z order.
            const ranked = focused
                ? [...matches].sort((a, b) => {
                    const aPre = a.name.toLowerCase().startsWith(focused) ? 0 : 1;
                    const bPre = b.name.toLowerCase().startsWith(focused) ? 0 : 1;
                    return aPre - bPre || a.name.localeCompare(b.name);
                })
                : [...matches].sort((a, b) => a.name.localeCompare(b.name));

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
            // One storefront, four shops behind a section select: the server shop
            // plus Hunt / Fish / Mine, each still reachable from its own
            // /X shop list. The event shop stays separate — it spends a different
            // currency and isn't always running.
            const sections = [];

            const serverPages = guildSettings.shop.length
                ? await buildShopPages(guildSettings, currency, viewerPrestigeRank)
                : [];
            if (serverPages.length) {
                // Buy straight from the view. Re-read settings at click time so
                // stock and dynamic prices are current — the message can sit open
                // for minutes — and keep the purchase ephemeral so a public
                // storefront doesn't fill with each viewer's receipts.
                for (const page of serverPages) {
                    page.onBuy = async (btn, buyId) => {
                        const fresh = await getGuildSettings(interaction.guild.id).catch(() => null);
                        return buyShopItem(btn, {
                            guildSettings: fresh ?? guildSettings,
                            currency,
                            viewerPrestigeRank,
                            rawName:       buyId,
                            quantity:      1,
                            privateReply:  true,
                        });
                    };
                }
                sections.push({
                    id: 'shop', label: 'Server Shop', emoji: '🛒', activity: 'shop_common',
                    title: `${interaction.guild.name} Shop`, pages: serverPages,
                });
            }

            // Grind gear is worth browsing only where it can be funded, so skip
            // the game sections when the economy is off (their own commands
            // already refuse there too).
            const economyOn = guildSettings.economy?.enabled !== false;
            let userData = null;
            if (economyOn) {
                const grindUser = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
                    { upsert: true, new: true }
                );
                await attachGrind(grindUser);
                ensureHuntData(grindUser);
                ensureFishingData(grindUser);
                ensureMineData(grindUser);
                userData = grindUser;

                sections.push({ id: 'hunt', label: 'Hunt',    emoji: '🏹', activity: 'hunt', title: 'Hunt Shop',    pages: buildHuntShopPages(grindUser, currency) });
                sections.push({ id: 'fish', label: 'Fishing', emoji: '🎣', activity: 'fish', title: 'Fishing Shop', pages: buildFishShopPages(grindUser, currency) });
                sections.push({ id: 'mine', label: 'Mining',  emoji: '⛏️', activity: 'mine', title: 'Mining Shop',  pages: buildMineShopPages(grindUser, currency) });
            }

            const usable = sections.filter(s => s.pages && s.pages.length);
            if (!usable.length) {
                return interaction.reply({ content: 'The shop is empty. Admins can add items via the dashboard.', flags: MessageFlags.Ephemeral });
            }

            if (!userData) {
                userData = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            }
            const userBalance = userData?.balance ?? 0;
            const balanceFooter = `Balance: ${currency}${userBalance.toLocaleString()} · Buy from the menu or /shop buy <item> [qty]`;

            return runShopBrowse(interaction, {
                title:    `${interaction.guild.name} Shop`,
                currency,
                footer:   balanceFooter,
                guildId:  interaction.guild.id,
                sections: usable,
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
            const quantity = interaction.options.getInteger('quantity') ?? 1;
            return buyShopItem(interaction, { guildSettings, currency, viewerPrestigeRank, rawName, quantity });
        }

    }
};

// Purchase a single shop item, from either the `/shop buy` subcommand or the
// browse view's buy select. Everything the two share — the item lookup, the
// prestige/stock/role/balance guards, the confirm-over-threshold step and the
// race-safe charge/stock/inventory writes — lives here so the two entry points
// can never drift apart. `privateReply` keeps the browse-view purchase private
// to the shopper; the slash command stays public as before.
async function buyShopItem(interaction, { guildSettings, currency, viewerPrestigeRank, rawName, quantity = 1, privateReply = false }) {
    const privacy = privateReply ? { flags: MessageFlags.Ephemeral } : {};
    {
            const itemName = rawName.toLowerCase();

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

                // From here the buyer has paid. Every way out that does not end
                // with the item in their bag (or owed to them) has to give the
                // coins back, and has to say what the refund actually did (#873,
                // pass 14): each unwind below used to be a bare `$inc` that read
                // nothing back under a reply that said "refunded", and a throw
                // from the stock write or the grant skipped the refund entirely
                // and told a charged buyer to try again.
                const buyer = { userId: interaction.user.id, guildId: interaction.guild.id };
                const refundCharge = () => creditCoinsOrOwe(buyer, freshTotal, {
                    payoutKey: serverShopRefundPayoutKey(interaction.id),
                    service:   'shop',
                    jobName:   'purchaseRefund',
                });
                // Stock is guild inventory rather than player value, so putting
                // it back stays a best-effort `$inc` — a shelf mis-counted by
                // `quantity` is not a coin-integrity failure.
                const restoreStock = () => Guild.updateOne(
                    { guildId: interaction.guild.id, shop: { $elemMatch: { _id: freshItem._id } } },
                    { $inc: { 'shop.$.stock': quantity } }
                ).catch(err => console.error('[shop] stock restore failed:', err));

                // Atomically decrement stock if limited; refund on sell-out race.
                // $elemMatch binds both predicates to the SAME array element so
                // the positional update can't accidentally decrement a different
                // item just because some other item happens to have stock > 0.
                // Guarding on `>= quantity` makes the whole batch all-or-nothing —
                // a concurrent buyer can't leave this one partially filled.
                if (freshItem.stock > 0) {
                    let stockResult;
                    try {
                        stockResult = await Guild.findOneAndUpdate(
                            {
                                guildId: interaction.guild.id,
                                shop: { $elemMatch: { _id: freshItem._id, stock: { $gte: quantity } } },
                            },
                            { $inc: { 'shop.$.stock': -quantity } }
                        );
                    } catch (err) {
                        console.error('[shop] stock decrement failed:', err);
                        return reply({
                            content: shopRefundMessage(await refundCharge(), {
                                action: 'Purchase failed', currency, amount: freshTotal,
                            }),
                            embeds: [], components: [],
                        });
                    }
                    if (!stockResult) {
                        return reply({
                            content: shopRefundMessage(await refundCharge(), {
                                action: quantity > 1
                                    ? `There aren't ${quantity} left in stock anymore`
                                    : 'That item just sold out',
                                currency, amount: freshTotal,
                            }),
                            embeds: [], components: [],
                        });
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

                // Keyed and never throwing (#873, pass 14). The bare grant it
                // replaces could not tell a failure from a write that committed
                // and lost its response, so refunding after it risked paying the
                // buyer back for an item they had. Keyed, a retry is a no-op once
                // the grant has landed, and a grant that still will not land is
                // recorded as owed — the buyer keeps what they paid for rather
                // than being refunded over it.
                const grant = await grantItemsOrOwe(buyer, inventoryId, quantity, {
                    payoutKey: serverShopGrantPayoutKey(interaction.id),
                    service:   'shop',
                    jobName:   'purchaseGrant',
                    extra:     { itemName: freshItem.name, charged: freshTotal },
                });

                if (!grant.granted && !grant.owed) {
                    // Neither in the bag nor written down anywhere, so the charge
                    // is the only record of the purchase: give it back, and the
                    // stock with it.
                    const refund = await refundCharge();
                    if (freshItem.stock > 0) await restoreStock();
                    return reply({
                        content: shopRefundMessage(refund, { action: 'Purchase failed', currency, amount: freshTotal }),
                        embeds: [], components: [],
                    });
                }

                if (!grant.granted) {
                    // Owed: the item is recorded for `payouts:replay`, so the
                    // purchase stands — no refund, and the stock stays taken, so
                    // the ledger records it like any other purchase.
                    logTransaction({
                        userId:  interaction.user.id,
                        guildId: interaction.guild.id,
                        type:    'shop_buy',
                        amount:  -freshTotal,
                        balance: chargedUser.balance,
                        note:    inventoryId,
                    });
                    const boughtLabel = quantity > 1 ? `${quantity}× **${freshItem.name}**` : `**${freshItem.name}**`;
                    return reply({
                        content:
                            `You bought ${boughtLabel} for ${currency}${freshTotal.toLocaleString()}, but it couldn't be ` +
                            'added to your inventory just now. It has been recorded as owed and will arrive once the ' +
                            'problem clears — tell an admin if it does not.',
                        embeds: [], components: [],
                    });
                }

                const stockedUser = grant.doc;
                // `doc` is null when the grant turned out to have landed on an earlier
                // attempt, so the count falls back to what was bought.
                const ownedNow = stockedUser?.inventory?.find(s => s.itemId === inventoryId)?.quantity ?? quantity;

                // The item is in the bag either way, and `/use` grants its role,
                // so a failed add is recoverable — but the receipt must not say
                // "Role Granted" over a role that was not (#873, pass 14).
                let roleGranted = false;
                if (freshItem.roleId) {
                    roleGranted = await interaction.member.roles.add(freshItem.roleId)
                        .then(() => true)
                        .catch(err => { console.error('[shop] role grant failed:', err); return false; });
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

                if (roleGranted) {
                    successEmbed.addFields({ name: 'Role Granted', value: `<@&${freshItem.roleId}>`, inline: true });
                } else if (freshItem.roleId) {
                    successEmbed.addFields({
                        name:  'Role Not Granted Yet',
                        value: `The <@&${freshItem.roleId}> role couldn't be added just now. Run \`/use ${inventoryId}\` to try again, or ask an admin to check the bot's role permissions.`,
                    });
                }

                const successImg = await getItemImageAttachment(shopIconId(freshItem), interaction.guildId, { label: freshItem.name }).catch(() => null);
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

                const confirmImg = await getItemImageAttachment(shopIconId(item), interaction.guildId, { label: item.name }).catch(() => null);
                if (confirmImg) confirmEmbed.setThumbnail(confirmImg.url);
                const confirmPayload = { embeds: [confirmEmbed], components: [row], fetchReply: true, ...privacy };
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

            await interaction.deferReply(privacy);
            try {
                await doPurchase(opts => interaction.editReply(opts));
            } catch (err) {
                console.error(err);
                interaction.editReply({ content: 'Something went wrong processing your purchase. Please try again.', embeds: [], components: [] }).catch(() => {});
            }
            return;
    }
}
