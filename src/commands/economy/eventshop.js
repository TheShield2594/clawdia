const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { SEASONAL_EVENTS } = require('../../data/seasonalEvents');
const {
    hasActiveEvent,
    getEventCurrencyId,
    getEventCurrencyBalance,
} = require('../../services/seasonalEventService');
const { addEffect, resolveEffectType } = require('../../services/effectsService');
const { grantInventoryItem } = require('../../utils/inventoryGrant');
const { paginate, chunkArray } = require('../../utils/paginator');
const { fitDescription, truncate } = require('../../utils/embedFields');
const COLORS = require('../../utils/embedColors');

// Items that grant effects when purchased (grant via effectsService)
const EFFECT_ITEMS = new Set(['coin_booster_2x', 'xp_booster_2x', 'lucky_charm', 'lucky_streak', 'salary_raise']);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('eventshop')
        .setDescription('Browse and purchase items with your event currency')
        .addSubcommand(sub =>
            sub.setName('browse')
                .setDescription('View available event shop items'))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Purchase an item from the event shop')
                .addStringOption(o =>
                    o.setName('item')
                        .setDescription('Item ID or name to buy')
                        .setRequired(true))
                .addIntegerOption(o =>
                    o.setName('quantity')
                        .setDescription('How many to buy (default: 1)')
                        .setMinValue(1)
                        .setMaxValue(10)
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('balance')
                .setDescription('Check your event currency balance')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (!hasActiveEvent(guildSettings)) {
            return interaction.reply({
                content: '🛒 There is no active event on this server. Check back during an event!',
                flags: MessageFlags.Ephemeral
            });
        }

        const ev = guildSettings.activeEvent;
        const def = SEASONAL_EVENTS[ev.type];
        const currencyId = getEventCurrencyId(guildSettings);
        const currency = def?.currency ?? { id: currencyId, name: 'Event Currency', emoji: '🪙' };

        if (sub === 'balance') return handleBalance(interaction, guildSettings, currency);
        if (sub === 'browse')  return handleBrowse(interaction, ev, def, currency);
        if (sub === 'buy')     return handleBuy(interaction, ev, def, currency, currencyId);
    }
};

async function handleBalance(interaction, guildSettings, currency) {
    const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
    const currencyId = getEventCurrencyId(guildSettings);
    const balance = getEventCurrencyBalance(user, currencyId);

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle(`${currency.emoji} Event Currency Balance`)
            .setDescription(`You have **${balance.toLocaleString()} ${currency.name}** ${currency.emoji}`)
            .setFooter({ text: 'Earn more through event mini-games and activities!' })
            .setTimestamp()],
        flags: MessageFlags.Ephemeral
    });
}

const BROWSE_PAGE_SIZE = 5;

async function handleBrowse(interaction, ev, def, currency) {
    const shop = ev.eventShop ?? [];

    if (!shop.length) {
        return interaction.reply({
            content: '🛒 The event shop is empty right now.',
            flags: MessageFlags.Ephemeral
        });
    }

    const chunks = chunkArray(shop, BROWSE_PAGE_SIZE);
    const totalItems = shop.length;

    // An event shop item's name and description are whatever an admin typed
    // into the dashboard, with no length cap on either — five of them joined
    // ran past the 4,096 a description allows, and discord.js throws rather
    // than truncating, so one long blurb took the whole page down. Cut each
    // entry to a readable length instead of losing items off the end: they are
    // bought by name, and a name the page never printed cannot be typed.
    const ITEM_NAME = 100;
    const ITEM_BLURB = 400;
    const pages = chunks.map((chunk, pageIndex) => {
        const offset = pageIndex * BROWSE_PAGE_SIZE;
        const lines = chunk.map((item, i) => {
            const stockStr = item.stock === -1 ? '∞' : item.stock.toLocaleString();
            return `**${offset + i + 1}.** ${item.emoji || '•'} **${truncate(item.name, ITEM_NAME)}** — \`${item.cost} ${currency.emoji}\`\n` +
                   `   ${truncate(item.description || '', ITEM_BLURB)}  •  Stock: ${stockStr}`;
        });

        return new EmbedBuilder()
            .setColor(ev.color ?? '#5865F2')
            .setTitle(`${ev.emoji ?? '🛒'} ${ev.name} — Event Shop`)
            .setDescription(fitDescription(lines, { separator: '\n\n' }).text)
            .addFields({
                name: `${currency.emoji} Your Balance`,
                value: 'Use `/eventshop balance` to check your balance',
                inline: false
            })
            .setFooter({ text: `Use /eventshop buy <item name> to purchase  •  ${totalItems} items total` })
            .setTimestamp();
    });

    return paginate(interaction, pages);
}

async function handleBuy(interaction, ev, def, currency, currencyId) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const itemQuery = interaction.options.getString('item').toLowerCase();
    const qty       = interaction.options.getInteger('quantity') ?? 1;

    const shop = ev.eventShop ?? [];
    const shopItem = shop.find(
        s => s.itemId.toLowerCase() === itemQuery || s.name.toLowerCase().includes(itemQuery)
    );

    if (!shopItem) {
        return interaction.editReply({ content: `🛒 No item matching **"${itemQuery}"** found in the event shop.` });
    }

    const totalCost = shopItem.cost * qty;

    // Fast pre-check on balance (stale read; the atomic step below is authoritative)
    const userPre = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
    const preBalance = getEventCurrencyBalance(userPre, currencyId);
    if (preBalance < totalCost) {
        return interaction.editReply({
            content: `❌ You need **${totalCost} ${currency.name}** ${currency.emoji} but only have **${preBalance}**.`
        });
    }

    // Step 1: Atomically decrement stock only if stock >= qty (eliminates check-then-act race).
    // $elemMatch ensures both conditions apply to the same array element so the positional
    // operator $ always targets the correct shop entry.
    const stockLimited = shopItem.stock !== -1;
    if (stockLimited) {
        const stockResult = await Guild.findOneAndUpdate(
            {
                guildId: interaction.guild.id,
                'activeEvent.eventShop': { $elemMatch: { itemId: shopItem.itemId, stock: { $gte: qty } } }
            },
            { $inc: { 'activeEvent.eventShop.$.stock': -qty } }
        );
        if (!stockResult) {
            return interaction.editReply({ content: `🛒 **${shopItem.name}** is out of stock.` });
        }
    }

    // Step 2: Atomically deduct currency; revert stock if this fails
    const charged = await User.findOneAndUpdate(
        {
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            'eventCurrency.currencyId': currencyId,
            'eventCurrency.amount': { $gte: totalCost }
        },
        { $inc: { 'eventCurrency.$.amount': -totalCost } },
        { new: true }
    );

    if (!charged) {
        if (stockLimited) {
            await Guild.findOneAndUpdate(
                { guildId: interaction.guild.id, 'activeEvent.eventShop.itemId': shopItem.itemId },
                { $inc: { 'activeEvent.eventShop.$.stock': qty } }
            ).catch(() => {});
        }
        return interaction.editReply({ content: `❌ Insufficient event currency. Please try again.` });
    }

    // Step 3: Grant item or effect (currency already secured above)
    const user = charged;

    // Hand the currency and any stock back when the grant cannot land.
    const revertPurchase = async () => {
        await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id, 'eventCurrency.currencyId': currencyId },
            { $inc: { 'eventCurrency.$.amount': totalCost } }
        ).catch(() => {});
        if (stockLimited) {
            await Guild.findOneAndUpdate(
                { guildId: interaction.guild.id, 'activeEvent.eventShop': { $elemMatch: { itemId: shopItem.itemId } } },
                { $inc: { 'activeEvent.eventShop.$.stock': qty } }
            ).catch(() => {});
        }
    };

    if (EFFECT_ITEMS.has(shopItem.itemId)) {
        const effectType = resolveEffectType(shopItem.name) ?? shopItem.itemId;
        for (let i = 0; i < qty; i++) addEffect(user, effectType);
        try {
            await user.save();
        } catch (err) {
            console.error('[eventshop] effect grant save failed:', err.message);
            await revertPurchase();
            return interaction.editReply({ content: '❌ Purchase failed due to a server error. Please try again.' });
        }
    } else {
        // One atomic upsert rather than mutate-then-save: the save would write
        // the whole inventory array as read a moment ago, flattening any credit
        // that landed in between, and two concurrent credits of the same item
        // could each push their own slot (src/utils/inventoryGrant.js).
        try {
            const granted = await grantInventoryItem(interaction.user.id, interaction.guild.id, shopItem.itemId, qty);
            if (!granted) throw new Error('user document not found');
        } catch (err) {
            console.error('[eventshop] item grant failed:', err.message);
            await revertPurchase();
            return interaction.editReply({ content: '❌ Purchase failed due to a server error. Please try again.' });
        }
    }

    const newBalance = getEventCurrencyBalance(user, currencyId);

    return interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor(ev.color ?? '#5865F2')
            .setTitle(`${shopItem.emoji || '🛒'} Purchase Successful!`)
            .setDescription(
                `You bought **${qty}x ${shopItem.name}** for **${totalCost} ${currency.name}** ${currency.emoji}!`
            )
            .addFields({ name: `${currency.emoji} Remaining Balance`, value: `${newBalance.toLocaleString()} ${currency.name}`, inline: true })
            .setTimestamp()]
    });
}
