const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { SEASONAL_EVENTS } = require('../../data/seasonalEvents');
const {
    hasActiveEvent,
    getEventCurrencyId,
    getEventCurrencyBalance,
} = require('../../services/seasonalEventService');
const { activateEffect, hasEffect, resolveEffectType, EFFECT_CONFIGS } = require('../../services/effectsService');
const { grantInventoryItem } = require('../../utils/inventoryGrant');
const { creditEventCurrencyOrOwe } = require('../../utils/creditOrOwe');
const { eventShopRefundPayoutKey } = require('../../utils/payoutKey');
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

        const guildSettings = await getGuildSettings(interaction.guild.id);

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
    // An effect item starts on purchase, and effects do not stack — a second
    // copy replaces the first. Buying five charged for five and ran one (#873,
    // pass 14), so an effect is sold one at a time, and not while it is already
    // running; both are refused before anything is charged.
    const effectType = EFFECT_ITEMS.has(shopItem.itemId)
        ? (resolveEffectType(shopItem.name) ?? shopItem.itemId)
        : null;
    if (effectType && qty > 1) {
        return interaction.editReply({
            content: `🛒 **${shopItem.name}** starts as soon as you buy it and doesn't stack, so it can only be bought one at a time.`,
        });
    }

    const userPre = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
    if (effectType && userPre && hasEffect(userPre, effectType)) {
        const cfg = EFFECT_CONFIGS[effectType];
        return interaction.editReply({
            content: `🛒 **${cfg?.label ?? shopItem.name}** is already active on you. Buy another once it runs out.`,
        });
    }
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

    // Step 2: Atomically deduct currency; revert stock if this fails.
    //
    // `$elemMatch`, not two dotted conditions (#873, pass 14). Written as
    // `'eventCurrency.currencyId': id, 'eventCurrency.amount': { $gte: cost }`,
    // each condition could be met by a *different* entry, so a player holding
    // enough of an earlier event's currency passed the balance guard for this
    // one — the check read above was the only thing stopping an overdraft, and
    // two purchases racing past it could both land and drive the balance
    // negative. Bound to one element, the guard is about the currency spent,
    // and the positional `$` names that element unambiguously.
    const charged = await User.findOneAndUpdate(
        {
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            eventCurrency: { $elemMatch: { currencyId, amount: { $gte: totalCost } } },
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

    // Hand the currency and any stock back when the grant cannot land. The
    // currency refund is keyed and recoverable (#873, pass 8): the bare `$inc`
    // with `.catch(() => {})` it replaces read nothing back, so a refund that
    // failed lost the currency with nothing written down while the player was
    // told only that the purchase failed — the pass-3 `/market` unwind shape, on
    // the currency the keyed helpers did not cover. The stock revert stays a
    // best-effort `$inc`: it is guild inventory, not player value, and mis-counting
    // one shelf by `qty` is not a coin-integrity failure.
    const revertPurchase = async () => {
        const refund = await creditEventCurrencyOrOwe(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            currencyId, totalCost,
            { payoutKey: eventShopRefundPayoutKey(interaction.id), service: 'eventshop', jobName: 'purchaseRefund' },
        );
        if (stockLimited) {
            await Guild.findOneAndUpdate(
                { guildId: interaction.guild.id, 'activeEvent.eventShop': { $elemMatch: { itemId: shopItem.itemId } } },
                { $inc: { 'activeEvent.eventShop.$.stock': qty } }
            ).catch(() => {});
        }
        return refund;
    };

    if (effectType) {
        // One guarded write rather than addEffect + save(): the save wrote the
        // whole activeEffects array back from the snapshot read at the charge,
        // over any effect a concurrent command consumed or started in between
        // (#873, pass 14). A refusal here means the effect started since the
        // check above — a double-click — so the purchase is unwound.
        try {
            const activation = await activateEffect(
                User, { userId: interaction.user.id, guildId: interaction.guild.id }, effectType,
            );
            if (activation.status !== 'activated') throw new Error(`effect ${effectType} not activated (${activation.status})`);
        } catch (err) {
            console.error('[eventshop] effect grant failed:', err.message);
            return interaction.editReply({ content: purchaseFailedMessage(await revertPurchase(), currency) });
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
            return interaction.editReply({ content: purchaseFailedMessage(await revertPurchase(), currency) });
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

// What to tell a buyer whose grant failed, worded from what the refund actually
// did — the three-way the rest of the economy uses. A refund that could not even
// be recorded must not read like one the player will get back automatically.
function purchaseFailedMessage(refund, currency) {
    if (refund.credited) {
        return `❌ Purchase failed due to a server error — your **${currency.name}** ${currency.emoji} has been refunded. Please try again.`;
    }
    if (refund.owed) {
        return `❌ Purchase failed. Your **${currency.name}** ${currency.emoji} couldn't be refunded just now and has been recorded as owed — it'll be restored once the problem clears. Tell an admin if it doesn't.`;
    }
    return `❌ Purchase failed and your **${currency.name}** ${currency.emoji} could not be refunded — please contact a server admin.`;
}
