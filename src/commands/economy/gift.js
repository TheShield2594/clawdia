const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const User  = require('../../models/User');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { logTransaction } = require('../../utils/logTransaction');
const { grantInventoryItem } = require('../../utils/inventoryGrant');
const { getItemImageAttachment } = require('../../utils/itemImageHelper');
const { describeItem } = require('../../utils/itemDisplay');
const { ownedBy } = require('../../utils/collectorOwner');
const {
    BUDGETS, giftLimits, budgetState, spendBudget, spendBudgetPipeline,
    refundBudgetPipeline,
} = require('../../utils/giftCaps');
const {
    accountAgeRefusal, coinBudgets, commitCoinTransfer, transferRefusal,
} = require('../../utils/coinTransfer');
const { isSoulbound } = require('../../data/soulboundItems');
const { resolveEffectType } = require('../../services/effectsService');
const COLORS = require('../../utils/embedColors');

// Add `qty` of `itemId` to a user's inventory without reading it first. The
// three-step bump/guarded-push/bump dance this used to spell out is now one
// atomic pipeline update shared with every other credit site. `options` is
// passed through so a budget can be spent in the same write.
const addInventoryItem = (userId, guildId, itemId, qty, options = {}) =>
    grantInventoryItem(userId, guildId, itemId, qty, options);

/**
 * Load the AiItem rows for whichever of `itemIds` are forged (`ai_`) ids.
 *
 * Returns a plain `itemId -> doc` map, `{}` when there is nothing to look up or
 * the query fails. A missing name is cosmetic — `describeItem` falls back to the
 * id — so this must never be the reason a gift is refused.
 */
async function loadAiItems(itemIds) {
    const forged = [...new Set(itemIds.filter(id => id.startsWith('ai_')))];
    if (!forged.length) return {};
    try {
        const AiItem = require('../../models/AiItem');
        const docs = await AiItem.find({ itemId: { $in: forged } }, 'itemId name emoji rarity lore').lean();
        return Object.fromEntries(docs.map(d => [d.itemId, d]));
    } catch (err) {
        console.error('[gift] AiItem lookup failed:', err);
        return {};
    }
}

/**
 * Every inventory entry the sender is actually allowed to hand over, described
 * for display.
 *
 * The three exclusions are the same ones `execute` enforces, kept together so
 * the autocomplete list and the command agree: an item offered in the dropdown
 * and then refused on submit is worse than one that was never offered.
 */
function giftableEntries(user, { shopItems = [], aiItems = {} } = {}) {
    const activeTypes = new Set((user?.activeEffects ?? []).map(e => e.type));
    return (user?.inventory ?? [])
        .filter(e => e.quantity > 0)
        .filter(e => !isSoulbound(e.itemId))
        .filter(e => {
            const type = resolveEffectType(e.itemId);
            return !(type && activeTypes.has(type));
        })
        .map(e => ({
            quantity: e.quantity,
            ...describeItem(e.itemId, { shopItems, aiItem: aiItems[e.itemId] }),
        }));
}

/** `Name (3 held)` → an autocomplete choice, both halves clipped to Discord's 100. */
function toChoice(item) {
    const rarity = item.rarity ? ` · ${item.rarityEmoji} ${item.rarity}` : '';
    return {
        name: `${item.emoji} ${item.name} — ${item.quantity} held${rarity}`.slice(0, 100),
        value: item.itemId.slice(0, 100),
    };
}

/** `💰1,234`, or `no limit` for a budget that is switched off. */
function formatRemaining(remaining, currency) {
    return Number.isFinite(remaining) ? `${currency}${remaining.toLocaleString()}` : 'no limit';
}

/**
 * Ask the sender to confirm before an irreversible transfer, on an interaction
 * that has already been deferred ephemerally.
 *
 * A gift has no undo and no counterparty to dispute it with — unlike a market
 * purchase, which at least prompts above 500 coins. Written against an already
 * deferred interaction rather than reusing `utils/confirmBet`, which sends its
 * own reply and so cannot be used once the interaction is acknowledged.
 *
 * Returns true only on an explicit confirmation; a cancel and a timeout both
 * leave the ephemeral message explaining what happened.
 */
async function confirmGift(interaction, { description, footer }) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('gift_confirm').setLabel('Send it').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('gift_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
    );
    const embed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle('⚠️ Confirm this gift')
        .setDescription(description)
        .setFooter({ text: footer ?? 'Gifts cannot be reversed. This prompt expires in 30 seconds.' });

    const prompt = await interaction.editReply({ content: '', embeds: [embed], components: [row] });

    try {
        const press = await prompt.awaitMessageComponent({
            time: 30_000,
            filter: ownedBy(interaction.user.id, "This isn't your gift."),
        });
        if (press.customId === 'gift_confirm') {
            await press.update({ content: '✅ Confirmed — sending…', embeds: [], components: [] });
            return true;
        }
        await press.update({ content: '❌ Gift cancelled. Nothing was sent.', embeds: [], components: [] });
        return false;
    } catch {
        await interaction
            .editReply({ content: '⏱️ Confirmation timed out. Nothing was sent.', embeds: [], components: [] })
            .catch(() => {});
        return false;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('gift')
        .setDescription('Send coins or an item from your inventory to another user.')
        .addUserOption(o =>
            o.setName('user')
                .setDescription('The recipient.')
                .setRequired(true))
        .addStringOption(o =>
            o.setName('type')
                .setDescription('What to gift: coins or an item.')
                .setRequired(true)
                .addChoices(
                    { name: 'Coins', value: 'coins' },
                    { name: 'Item',  value: 'item'  }
                ))
        .addIntegerOption(o =>
            o.setName('amount')
                .setDescription('Amount of coins (if gifting coins).')
                .setMinValue(1))
        .addStringOption(o =>
            o.setName('item')
                // Autocompleted from what you are holding right now — nobody
                // should have to know that the Pet Slot Expansion is spelled
                // `pet_slot_expansion`, or retype a relic's name exactly.
                .setDescription('Item to gift — start typing to pick from your inventory.')
                .setAutocomplete(true))
        .addIntegerOption(o =>
            o.setName('quantity')
                .setDescription('How many of the item to gift (default 1).')
                .setMinValue(1)),

    async autocomplete(interaction) {
        try {
            if (interaction.options.getFocused(true)?.name !== 'item') {
                return interaction.respond([]);
            }
            const focused = interaction.options.getFocused()?.toLowerCase() ?? '';

            const [user, guildSettings] = await Promise.all([
                User.findOne(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    'inventory activeEffects'
                ).lean(),
                getGuildSettings(interaction.guild.id),
            ]);

            const inventory = (user?.inventory ?? []).filter(e => e.quantity > 0);
            const aiItems = await loadAiItems(inventory.map(e => e.itemId));
            const items = giftableEntries(user, { shopItems: guildSettings?.shop ?? [], aiItems });

            // Matched on the display name *and* the raw id: a player who knows
            // the id can still type it, and one who only knows the label gets
            // there too.
            const matches = focused
                ? items.filter(i => i.name.toLowerCase().includes(focused) || i.itemId.toLowerCase().includes(focused))
                : items;

            // Prefix matches first, then substring — same ranking /shop buy uses,
            // so typing "pet" surfaces "Pet Food" ahead of "Carpet".
            const ranked = focused
                ? [...matches].sort((a, b) => {
                    const aPre = a.name.toLowerCase().startsWith(focused) ? 0 : 1;
                    const bPre = b.name.toLowerCase().startsWith(focused) ? 0 : 1;
                    return aPre - bPre || a.name.localeCompare(b.name);
                })
                : [...matches].sort((a, b) => a.name.localeCompare(b.name));

            await interaction.respond(ranked.slice(0, 25).map(toChoice));
        } catch (err) {
            console.error('[gift] autocomplete error:', err);
            await interaction.respond([]).catch(() => {});
        }
    },

    async execute(interaction) {
        // Deferred before anything else, and ephemerally.
        //
        // Everything below is database work — up to four reads and three writes
        // on the item path — against Discord's three-second acknowledgement
        // window, and a slow database turned that into "the application did not
        // respond" with the gift already half applied. Ephemeral because most of
        // what this reply carries is a refusal or the sender's own wallet;
        // the gift itself is announced publicly by a followUp at the end.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const deny = content => interaction.editReply({ content, embeds: [], components: [] });

        const guildSettings = await getGuildSettings(interaction.guild.id);
        if (guildSettings?.economy?.enabled === false) {
            return deny('The economy is disabled on this server.');
        }

        const currency = guildSettings?.economy?.currency || '💰';
        const limits   = giftLimits(guildSettings);
        const target   = interaction.options.getUser('user');
        const type     = interaction.options.getString('type');
        const guildId  = interaction.guild.id;

        if (target.id === interaction.user.id) return deny("You can't gift yourself.");
        if (target.bot)                        return deny("You can't gift a bot.");
        const tooNew = accountAgeRefusal(interaction.user, target, { noun: 'gifts' });
        if (tooNew) return deny(tooNew);

        // The two halves of this command each ignore the other's options, and
        // silently: `/gift type:item amount:500` used to move nothing and say
        // nothing about the 500. Say so instead of guessing which one was meant.
        const mismatched = type === 'coins'
            ? (interaction.options.getString('item')   ? 'item'   : null)
            : (interaction.options.getInteger('amount') ? 'amount' : null);
        if (mismatched) {
            const wanted = type === 'coins' ? 'amount' : 'item';
            return deny(`You picked **${type}** but filled in \`${mismatched}\`. Use \`${wanted}\` for that, or switch \`type\`.`);
        }

        if (type === 'coins') {
            const amount = interaction.options.getInteger('amount');
            if (!amount) return deny('Specify an `amount` when gifting coins.');

            // Read both sides for the user-facing balance and cap feedback. The
            // atomic filters below are what actually enforce either.
            const [senderNow, receiverNow] = await Promise.all([
                User.findOne({ userId: interaction.user.id, guildId }),
                User.findOne({ userId: target.id, guildId }),
            ]);

            if (!senderNow || senderNow.balance < amount) {
                return deny(`You only have **${currency}${(senderNow?.balance ?? 0).toLocaleString()}** in your wallet.`);
            }

            const budgets = coinBudgets(senderNow, receiverNow, limits);

            if (amount > budgets.send.remaining) {
                return deny(`Daily gift cap reached. You can still gift up to **${currency}${budgets.send.remaining.toLocaleString()}** today.`);
            }
            if (amount > budgets.receive.remaining) {
                return deny(`<@${target.id}> has reached their daily gift-receiving cap. They can receive up to **${currency}${budgets.receive.remaining.toLocaleString()}** more today.`);
            }

            // A gift is irreversible, so a large one asks first — the same
            // courtesy /market buy extends above 500 coins.
            if (limits.confirmThreshold > 0 && amount >= limits.confirmThreshold) {
                const pct = senderNow.balance > 0 ? Math.round((amount / senderNow.balance) * 100) : 100;
                const ok = await confirmGift(interaction, {
                    description: [
                        `You're about to send **${currency}${amount.toLocaleString()}** to <@${target.id}>.`,
                        `That is **${pct}%** of your wallet, and it cannot be taken back.`,
                    ].join('\n'),
                });
                if (!ok) return;
            }

            // The move itself, and every guard on it, in utils/coinTransfer.js —
            // shared with `/bank transfer`, which used to do the same thing with
            // none of them (#897).
            const moved = await commitCoinTransfer({
                senderId: interaction.user.id, receiverId: target.id, guildId,
                amount, limits, budgets,
                refundKey: interaction.id, service: 'gift', jobName: 'giftCoins',
            });

            const refusal = transferRefusal(moved, {
                mention: `<@${target.id}>`, currency, amount,
                sendCapLabel: 'daily gift cap', receiveCapLabel: 'daily gift-receiving cap',
            });
            if (refusal) return deny(refusal);

            const { sender: deducted, receiver: credited } = moved;

            logTransaction({ userId: interaction.user.id, guildId, type: 'gift_send',    amount: -amount, balance: deducted.balance, relatedUserId: target.id, note: 'Coin gift' });
            logTransaction({ userId: target.id,           guildId, type: 'gift_receive', amount,          balance: credited.balance, relatedUserId: interaction.user.id, note: 'Coin gift' });

            const capLeft = limits.coinSend
                ? Math.max(0, limits.coinSend - (deducted.dailyGiftSent ?? 0))
                : Infinity;

            // One public message, not two. The gift used to post a "Gift Sent!"
            // embed and then immediately follow it with a near-identical "You
            // Received a Gift!", so every gift cost the channel two posts saying
            // the same thing. The recipient is still pinged; the sender's own
            // numbers stay in the ephemeral receipt below, where only they need
            // them.
            const embed = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setAuthor({
                    name: `${interaction.user.username} → ${target.username}`,
                    iconURL: interaction.user.displayAvatarURL(),
                })
                .setTitle('🎁 Gift Delivered')
                .setDescription(`<@${target.id}> received **${currency}${amount.toLocaleString()}** from <@${interaction.user.id}>.`)
                .setThumbnail(target.displayAvatarURL())
                .setTimestamp();

            await interaction.editReply({
                content: `✅ Sent **${currency}${amount.toLocaleString()}** to **${target.username}**.\n`
                       + `Wallet: **${currency}${deducted.balance.toLocaleString()}** · `
                       + `Daily coin gift cap left: **${formatRemaining(capLeft, currency)}**`,
                embeds: [],
                components: [],
            });
            return interaction.followUp({ content: `<@${target.id}>`, embeds: [embed] });
        }

        // ── Gift an item ──────────────────────────────────────────────────────
        const typedItem = interaction.options.getString('item');
        const qty       = interaction.options.getInteger('quantity') ?? 1;

        if (!typedItem) {
            return deny('Specify an `item` when gifting an item — start typing and pick from your inventory.');
        }

        // Both documents must exist before the transfer; the sender doc is also
        // read here for the pre-flight checks below, and the receiver for theirs.
        const [sender, , receiver] = await Promise.all([
            User.findOneAndUpdate({ userId: interaction.user.id, guildId }, {}, { upsert: true, new: true }),
            User.updateOne({ userId: target.id, guildId }, {}, { upsert: true }),
            User.findOne({ userId: target.id, guildId }),
        ]);

        // Resolve what was typed against the inventory before anything is checked
        // against it. Ids are not uniformly cased — a custom shop item is stored
        // under its display name and relics under theirs ("The Tenth Owl") — so
        // an exact `===` refused half of a player's bag unless they matched the
        // capitalisation exactly. Matching the way /use does also means the
        // soulbound test below sees the canonical id: `Lifesaver` used to slip
        // past `SOULBOUND_ITEMS.has()` and only fail later, with the wrong error.
        const wanted = typedItem.trim().toLowerCase();
        const owned  = (sender.inventory ?? []).filter(i => i.itemId.toLowerCase() === wanted && i.quantity > 0);
        // Same predicate as the atomic debit below — a `find` on itemId alone
        // would reject on a small duplicate slot while a later one can cover it.
        const slot   = owned.find(i => i.quantity >= qty);
        const heldTotal = owned.reduce((n, i) => n + i.quantity, 0);

        if (!owned.length) {
            return deny(`You don't have **${typedItem}** in your inventory. Start typing in the \`item\` box to pick from what you're holding.`);
        }

        // Canonical casing, for every DB match and every label from here down.
        // Taken from the stack that will actually be debited, not merely the
        // first match: two stacks of one item can be stored under different
        // casings, and an id read off a stack too small to cover the gift would
        // not match the stack the `$elemMatch` below settles on.
        const itemId  = (slot ?? owned[0]).itemId;
        const aiItems = await loadAiItems([itemId]);
        const meta    = describeItem(itemId, { shopItems: guildSettings?.shop ?? [], aiItem: aiItems[itemId] });
        const label   = `${meta.emoji} **${meta.name}**`;

        if (isSoulbound(itemId)) {
            return deny(`${label} is soulbound and cannot be gifted.`);
        }

        if (!slot) {
            // Both halves of this are true statements about the same bag: with
            // one stack the total is the answer, and with several the total is
            // not, because a gift comes out of a single stack.
            const biggest = owned.reduce((n, i) => Math.max(n, i.quantity), 0);
            return deny(owned.length > 1
                ? `You have **${heldTotal}×** ${label}, but no single stack holds ${qty} — the largest holds **${biggest}×**.`
                : `You only have **${heldTotal}×** ${label} — not enough to gift ${qty}.`);
        }

        // Cannot gift actively equipped effects
        const effectType = resolveEffectType(itemId);
        if (effectType && (sender.activeEffects || []).some(e => e.type === effectType)) {
            return deny(`You can't gift ${label} while it's active as an effect. Wait for it to expire first.`);
        }

        // Items move value, and the coin caps did not see any of it — so "buy the
        // item, gift the item, sell it on the market" was the coin cap with one
        // extra step. Valued at what the guild's own shop charges (or the relic
        // payout, or what the rarity cost to forge).
        const giftValue    = Math.max(0, meta.value ?? 0) * qty;
        const sendState    = budgetState(sender,   { ...BUDGETS.itemValueSend,    cap: limits.itemValueSend });
        const rxValueState = budgetState(receiver, { ...BUDGETS.itemValueReceive, cap: limits.itemValueReceive });

        if (giftValue > sendState.remaining) {
            return deny(
                `That's **${currency}${giftValue.toLocaleString()}** of items, and you can still gift `
                + `**${currency}${sendState.remaining.toLocaleString()}** worth today. `
                + `${sendState.used > 0 ? 'The window resets 24 hours after your first item gift of the day.' : 'A single item over the cap can never be gifted — ask an admin to raise it.'}`
            );
        }
        if (giftValue > rxValueState.remaining) {
            return deny(
                `<@${target.id}> can only receive **${currency}${rxValueState.remaining.toLocaleString()}** more in item value today, `
                + `and this gift is worth **${currency}${giftValue.toLocaleString()}**.`
            );
        }

        // High-value items get the same confirmation coins do. The threshold is
        // read against the item's worth, not its count, so ten pet foods do not
        // prompt and one Prestige Accelerator does.
        if (limits.confirmThreshold > 0 && giftValue >= limits.confirmThreshold) {
            const ok = await confirmGift(interaction, {
                description: [
                    `You're about to send **${qty}× ${meta.emoji} ${meta.name}** to <@${target.id}>.`,
                    `That's worth about **${currency}${giftValue.toLocaleString()}**, and it cannot be taken back.`,
                ].join('\n'),
            });
            if (!ok) return;
        }

        // Debit the sender atomically first, then credit the recipient and roll
        // the debit back if the credit fails — the same shape as the coin path
        // above. Saving both documents in parallel would duplicate the item
        // whenever the sender's write lost and the recipient's won.
        const sendSpend = spendBudget({ ...BUDGETS.itemValueSend, cap: limits.itemValueSend, expired: sendState.expired, amount: giftValue });
        const debited = await User.findOneAndUpdate(
            {
                userId: interaction.user.id,
                guildId,
                inventory: { $elemMatch: { itemId, quantity: { $gte: qty } } },
                ...sendSpend.filter,
            },
            // Positional `$`, not an arrayFilter: `$[slot]` would decrement
            // every slot carrying this itemId, and duplicate slots are
            // reachable — several writers $push without checking for one.
            {
                $inc: { 'inventory.$.quantity': -qty, ...sendSpend.inc },
                ...(Object.keys(sendSpend.set).length ? { $set: sendSpend.set } : {}),
            },
            { new: true }
        );
        if (!debited) {
            return deny(`You don't have ${qty}× ${label} in your inventory, or your daily item-gift value would be exceeded.`);
        }
        // Drop the slot once it is empty so inventory listings stay clean. A
        // failure here leaves a zero-quantity slot, which is cosmetic only.
        await User.updateOne(
            { userId: interaction.user.id, guildId },
            { $pull: { inventory: { itemId, quantity: { $lte: 0 } } } }
        ).catch(() => null);

        const rxSpend = spendBudgetPipeline({ ...BUDGETS.itemValueReceive, cap: limits.itemValueReceive, expired: rxValueState.expired, amount: giftValue });

        let credited = null;
        try {
            credited = await addInventoryItem(target.id, guildId, itemId, qty, {
                guard:    rxSpend.filter,
                extraSet: rxSpend.set,
            });
        } catch (creditErr) {
            console.error(`[gift] item credit failed — recipient=${target.id} guild=${guildId} item=${itemId} qty=${qty}:`, creditErr);
        }
        if (!credited) {
            try {
                await addInventoryItem(interaction.user.id, guildId, itemId, qty, {
                    extraSet: refundBudgetPipeline({ ...BUDGETS.itemValueSend, cap: limits.itemValueSend, amount: giftValue }),
                });
            } catch (rollbackErr) {
                console.error(`[gift] CRITICAL: item rollback failed — sender=${interaction.user.id} guild=${guildId} item=${itemId} qty=${qty}:`, rollbackErr);
                return deny('Something went wrong returning your item — please contact a server admin.');
            }
            return deny(`Could not complete the transfer — <@${target.id}> may have reached their daily item-gift cap. Your item was returned.`);
        }

        logTransaction({ userId: interaction.user.id, guildId, type: 'gift_item_send',    amount: 0, balance: debited.balance,  relatedUserId: target.id,           note: `Gifted ${qty}x ${itemId}` });
        logTransaction({ userId: target.id,           guildId, type: 'gift_item_receive', amount: 0, balance: credited.balance, relatedUserId: interaction.user.id, note: `Received ${qty}x ${itemId}` });

        const senderLeft = (debited.inventory ?? [])
            .filter(i => i.itemId === itemId)
            .reduce((n, i) => n + Math.max(0, i.quantity), 0);

        const embed = new EmbedBuilder()
            // Coloured by what was sent, so a Mythic hand-me-down doesn't look
            // like a stack of pet food.
            .setColor(meta.color ?? COLORS.PRIZE)
            .setAuthor({
                name: `${interaction.user.username} → ${target.username}`,
                iconURL: interaction.user.displayAvatarURL(),
            })
            .setTitle('🎁 Gift Delivered')
            .setDescription(
                `<@${target.id}> received **${qty}× ${meta.emoji} ${meta.name}** from <@${interaction.user.id}>.`
                + (meta.lore ? `\n\n> *${meta.lore}*` : '')
            )
            .setTimestamp();

        if (meta.rarity) {
            embed.addFields({ name: 'Rarity', value: `${meta.rarityEmoji} ${meta.rarity}`, inline: true });
        }

        // The item's own artwork where the server has uploaded some — /shop
        // already shows it on a purchase, and a gift is the other moment an item
        // changes hands. The recipient's avatar keeps the slot otherwise, so the
        // embed is never left with an empty corner.
        const art = await getItemImageAttachment(itemId, guildId, { label: meta.name }).catch(() => null);
        embed.setThumbnail(art ? art.url : target.displayAvatarURL());

        const valueLeft = limits.itemValueSend
            ? Math.max(0, limits.itemValueSend - (debited.dailyGiftItemValueSent ?? 0))
            : Infinity;

        await interaction.editReply({
            content: `✅ Sent **${qty}× ${meta.name}** to **${target.username}**.\n`
                   + `You have **${senderLeft}×** left · `
                   + `Daily item gift value left: **${formatRemaining(valueLeft, currency)}**`,
            embeds: [],
            components: [],
        });
        return interaction.followUp({
            content: `<@${target.id}>`,
            embeds: [embed],
            ...(art ? { files: [art.attachment] } : {}),
        });
    },
};
