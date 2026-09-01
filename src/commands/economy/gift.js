const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { logTransaction } = require('../../utils/logTransaction');
const { grantInventoryItem } = require('../../utils/inventoryGrant');
const { describeItem } = require('../../utils/itemDisplay');
const { isSoulbound } = require('../../data/soulboundItems');
const { resolveEffectType } = require('../../services/effectsService');
const COLORS = require('../../utils/embedColors');

const DAILY_COIN_CAP = 10_000;
// Incoming cap is higher than the outgoing cap (several friends can legitimately
// gift one person) but low enough that funneling from a farm of alts is capped.
const DAILY_RECEIVE_CAP = 25_000;
// Fresh Discord accounts can't send gifts — blocks throwaway-alt funnels.
const MIN_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

// Add `qty` of `itemId` to a user's inventory without reading it first. The
// three-step bump/guarded-push/bump dance this used to spell out is now one
// atomic pipeline update shared with every other credit site.
// Returns the updated document, or null if the user document does not exist.
const addInventoryItem = (userId, guildId, itemId, qty) =>
    grantInventoryItem(userId, guildId, itemId, qty);

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
        const guildSettings = await getGuildSettings(interaction.guild.id);
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const currency = guildSettings?.economy?.currency || '💰';
        const target   = interaction.options.getUser('user');
        const type     = interaction.options.getString('type');

        if (target.id === interaction.user.id) {
            return interaction.reply({ content: "You can't gift yourself.", flags: MessageFlags.Ephemeral });
        }
        if (target.bot) {
            return interaction.reply({ content: "You can't gift a bot.", flags: MessageFlags.Ephemeral });
        }
        if (Date.now() - interaction.user.createdTimestamp < MIN_ACCOUNT_AGE_MS) {
            return interaction.reply({
                content: 'Your Discord account is too new to send gifts. Try again in a few days.',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (Date.now() - target.createdTimestamp < MIN_ACCOUNT_AGE_MS) {
            return interaction.reply({
                content: `${target.username}'s Discord account is too new to receive gifts.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        // The two halves of this command each ignore the other's options, and
        // silently: `/gift type:item amount:500` used to move nothing and say
        // nothing about the 500. Say so instead of guessing which one was meant.
        const mismatched = type === 'coins'
            ? (interaction.options.getString('item')   ? 'item'   : null)
            : (interaction.options.getInteger('amount') ? 'amount' : null);
        if (mismatched) {
            const wanted = type === 'coins' ? 'amount' : 'item';
            return interaction.reply({
                content: `You picked **${type}** but filled in \`${mismatched}\`. Use \`${wanted}\` for that, or switch \`type\`.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        if (type === 'coins') {
            const amount  = interaction.options.getInteger('amount');
            const guildId = interaction.guild.id;

            if (!amount) {
                return interaction.reply({ content: 'Specify an `amount` when gifting coins.', flags: MessageFlags.Ephemeral });
            }

            // Read current state to provide user-facing balance/cap feedback before the atomic update
            const senderNow = await User.findOne({ userId: interaction.user.id, guildId });
            if (!senderNow || senderNow.balance < amount) {
                return interaction.reply({
                    content: `You only have **${currency}${(senderNow?.balance ?? 0).toLocaleString()}** in your wallet.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const capResetAge = senderNow.dailyGiftReset
                ? Date.now() - new Date(senderNow.dailyGiftReset).getTime()
                : Infinity;
            const currentSent = capResetAge >= DAY_MS ? 0 : (senderNow.dailyGiftSent ?? 0);
            const remaining   = DAILY_COIN_CAP - currentSent;

            if (amount > remaining) {
                return interaction.reply({
                    content: `Daily gift cap reached. You can still gift up to **${currency}${remaining.toLocaleString()}** today.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Receiver-side daily cap — limits how much one account can be funneled per day
            const receiverNow  = await User.findOne({ userId: target.id, guildId });
            const rxResetAge   = receiverNow?.dailyGiftReceivedReset
                ? Date.now() - new Date(receiverNow.dailyGiftReceivedReset).getTime()
                : Infinity;
            const currentReceived = rxResetAge >= DAY_MS ? 0 : (receiverNow?.dailyGiftReceived ?? 0);
            if (currentReceived + amount > DAILY_RECEIVE_CAP) {
                return interaction.reply({
                    content: `<@${target.id}> has reached their daily gift-receiving cap. They can receive up to **${currency}${Math.max(0, DAILY_RECEIVE_CAP - currentReceived).toLocaleString()}** more today.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Atomic deduction: filter enforces balance and daily cap atomically so concurrent
            // gifts can't race past either check. Reset cap counter if the 24h window expired.
            const capFilter = capResetAge >= DAY_MS
                ? {}
                : { $expr: { $lte: [{ $add: ['$dailyGiftSent', amount] }, DAILY_COIN_CAP] } };

            const capUpdate = capResetAge >= DAY_MS
                ? { $inc: { balance: -amount }, $set: { dailyGiftSent: amount, dailyGiftReset: new Date() } }
                : { $inc: { balance: -amount, dailyGiftSent: amount } };

            const deducted = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId, balance: { $gte: amount }, ...capFilter },
                capUpdate,
                { new: true }
            );
            if (!deducted) {
                return interaction.reply({
                    content: 'Could not complete the transfer — your balance or daily gift cap may have changed.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Ensure the receiver document exists, then credit with the receive-cap
            // enforced atomically (no upsert here — an unmatched conditional upsert
            // would try to insert a duplicate userId+guildId document).
            await User.updateOne({ userId: target.id, guildId }, {}, { upsert: true });

            const rxCapFilter = rxResetAge >= DAY_MS
                ? {}
                : { $expr: { $lte: [{ $add: [{ $ifNull: ['$dailyGiftReceived', 0] }, amount] }, DAILY_RECEIVE_CAP] } };
            const rxCapUpdate = rxResetAge >= DAY_MS
                ? { $inc: { balance: amount }, $set: { dailyGiftReceived: amount, dailyGiftReceivedReset: new Date() } }
                : { $inc: { balance: amount, dailyGiftReceived: amount } };

            const credited = await User.findOneAndUpdate(
                { userId: target.id, guildId, ...rxCapFilter },
                rxCapUpdate,
                { new: true }
            );
            if (!credited) {
                // Receiver hit their cap in a race — roll the sender back
                try {
                    await User.updateOne(
                        { userId: interaction.user.id, guildId },
                        { $inc: { balance: amount, dailyGiftSent: -amount } }
                    );
                } catch (rollbackErr) {
                    console.error(`[gift] CRITICAL: sender rollback failed — sender=${interaction.user.id} guild=${guildId} amount=${amount}:`, rollbackErr);
                    return interaction.reply({
                        content: 'Something went wrong returning your coins — please contact a server admin.',
                        flags: MessageFlags.Ephemeral,
                    });
                }
                return interaction.reply({
                    content: `Could not complete the transfer — <@${target.id}> just reached their daily gift-receiving cap. Your coins were returned.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            logTransaction({ userId: interaction.user.id, guildId, type: 'gift_send',    amount: -amount, balance: deducted.balance, relatedUserId: target.id, note: 'Coin gift' });
            logTransaction({ userId: target.id,           guildId, type: 'gift_receive', amount,          balance: credited.balance, relatedUserId: interaction.user.id, note: 'Coin gift' });

            const newRemaining = Math.max(0, DAILY_COIN_CAP - (deducted.dailyGiftSent ?? 0));

            // One message, not two. The gift used to post a "Gift Sent!" embed
            // and then immediately follow it with a near-identical "You Received
            // a Gift!" embed, so every gift cost the channel two posts saying the
            // same thing. The recipient still gets pinged — that is what the
            // `content` mention is for — and everything either side wanted to
            // know is in the one embed.
            const embed = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setAuthor({
                    name: `${interaction.user.username} → ${target.username}`,
                    iconURL: interaction.user.displayAvatarURL(),
                })
                .setTitle('🎁 Gift Delivered')
                .setDescription(`<@${target.id}> received **${currency}${amount.toLocaleString()}** from <@${interaction.user.id}>.`)
                .setThumbnail(target.displayAvatarURL())
                .setFooter({ text: `Your wallet: ${currency}${deducted.balance.toLocaleString()} · Daily gift cap left: ${currency}${newRemaining.toLocaleString()}` })
                .setTimestamp();

            return interaction.reply({ content: `<@${target.id}>`, embeds: [embed] });
        }

        // ── Gift an item ──────────────────────────────────────────────────────
        const typedItem = interaction.options.getString('item');
        const qty       = interaction.options.getInteger('quantity') ?? 1;
        const guildId   = interaction.guild.id;

        if (!typedItem) {
            return interaction.reply({ content: 'Specify an `item` when gifting an item — start typing and pick from your inventory.', flags: MessageFlags.Ephemeral });
        }

        // Both documents must exist before the transfer; the sender doc is also
        // read here for the pre-flight checks below.
        const [sender] = await Promise.all([
            User.findOneAndUpdate({ userId: interaction.user.id, guildId }, {}, { upsert: true, new: true }),
            User.updateOne({ userId: target.id, guildId }, {}, { upsert: true }),
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
            return interaction.reply({
                content: `You don't have **${typedItem}** in your inventory. Start typing in the \`item\` box to pick from what you're holding.`,
                flags: MessageFlags.Ephemeral,
            });
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
            return interaction.reply({ content: `${label} is soulbound and cannot be gifted.`, flags: MessageFlags.Ephemeral });
        }

        if (!slot) {
            // Both halves of this are true statements about the same bag: with
            // one stack the total is the answer, and with several the total is
            // not, because a gift comes out of a single stack.
            const biggest = owned.reduce((n, i) => Math.max(n, i.quantity), 0);
            return interaction.reply({
                content: owned.length > 1
                    ? `You have **${heldTotal}×** ${label}, but no single stack holds ${qty} — the largest holds **${biggest}×**.`
                    : `You only have **${heldTotal}×** ${label} — not enough to gift ${qty}.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        // Cannot gift actively equipped effects
        const effectType = resolveEffectType(itemId);
        if (effectType && (sender.activeEffects || []).some(e => e.type === effectType)) {
            return interaction.reply({
                content: `You can't gift ${label} while it's active as an effect. Wait for it to expire first.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        // Debit the sender atomically first, then credit the recipient and roll
        // the debit back if the credit fails — the same shape as the coin path
        // above. Saving both documents in parallel would duplicate the item
        // whenever the sender's write lost and the recipient's won.
        const debited = await User.findOneAndUpdate(
            {
                userId: interaction.user.id,
                guildId,
                inventory: { $elemMatch: { itemId, quantity: { $gte: qty } } },
            },
            // Positional `$`, not an arrayFilter: `$[slot]` would decrement
            // every slot carrying this itemId, and duplicate slots are
            // reachable — several writers $push without checking for one.
            { $inc: { 'inventory.$.quantity': -qty } },
            { new: true }
        );
        if (!debited) {
            return interaction.reply({
                content: `You don't have ${qty}× ${label} in your inventory.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        // Drop the slot once it is empty so inventory listings stay clean. A
        // failure here leaves a zero-quantity slot, which is cosmetic only.
        await User.updateOne(
            { userId: interaction.user.id, guildId },
            { $pull: { inventory: { itemId, quantity: { $lte: 0 } } } }
        ).catch(() => null);

        let credited = null;
        try {
            credited = await addInventoryItem(target.id, guildId, itemId, qty);
        } catch (creditErr) {
            console.error(`[gift] item credit failed — recipient=${target.id} guild=${guildId} item=${itemId} qty=${qty}:`, creditErr);
        }
        if (!credited) {
            try {
                await addInventoryItem(interaction.user.id, guildId, itemId, qty);
            } catch (rollbackErr) {
                console.error(`[gift] CRITICAL: item rollback failed — sender=${interaction.user.id} guild=${guildId} item=${itemId} qty=${qty}:`, rollbackErr);
                return interaction.reply({
                    content: 'Something went wrong returning your item — please contact a server admin.',
                    flags: MessageFlags.Ephemeral,
                });
            }
            return interaction.reply({
                content: 'Could not complete the transfer — your item was returned.',
                flags: MessageFlags.Ephemeral,
            });
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
            .setThumbnail(target.displayAvatarURL())
            .setTimestamp();

        if (meta.rarity) {
            embed.addFields({ name: 'Rarity', value: `${meta.rarityEmoji} ${meta.rarity}`, inline: true });
        }
        embed.addFields({ name: 'You have left', value: `${senderLeft}×`, inline: true });

        return interaction.reply({ content: `<@${target.id}>`, embeds: [embed] });
    },
};
