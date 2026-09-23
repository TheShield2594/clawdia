'use strict';

const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle, ComponentType, MessageFlags,
} = require('discord.js');
const User = require('../../models/User');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { describeItem } = require('../../utils/itemDisplay');
const { ownedBy } = require('../../utils/collectorOwner');
const { isSoulbound } = require('../../data/soulboundItems');
const { resolveEffectType, isActiveEffect } = require('../../services/effectsService');
const { accountAgeRefusal, frozenRefusal } = require('../../utils/coinTransfer');
const { giftLimits } = require('../../utils/giftCaps');
const { settleTrade, checkTradeBudgets } = require('../../utils/tradeEscrow');
const COLORS = require('../../utils/embedColors');

const WINDOW_MS = 2 * 60_000;

/** An empty side of a trade. */
const emptySide = () => ({ coins: 0, item: null });

/**
 * Resolve a typed item against a user's current inventory for committing to a
 * trade, applying the same refusals `/gift` does: it must be held in a single
 * stack that covers the quantity, not soulbound, and not currently equipped as
 * an effect. Case-insensitive, and the canonical id is taken from the stack that
 * would actually be debited — so the soulbound check sees the real id (#1010).
 *
 * @returns {{item: {itemId, quantity, value, name, emoji}} | {error: string}}
 */
function resolveItemForTrade(userDoc, typedItem, quantity, { shopItems = [], aiItem = null } = {}) {
    const wanted = String(typedItem).trim().toLowerCase();
    const owned = (userDoc?.inventory ?? []).filter(i => i.itemId.toLowerCase() === wanted && i.quantity > 0);
    if (!owned.length) return { error: `You don't have **${typedItem}** in your inventory.` };

    const slot = owned.find(i => i.quantity >= quantity);
    const itemId = (slot ?? owned[0]).itemId;
    const meta = describeItem(itemId, { shopItems, aiItem });
    const label = `${meta.emoji} **${meta.name}**`;

    if (isSoulbound(itemId)) return { error: `${label} is soulbound and cannot be traded.` };
    if (!slot) {
        const held = owned.reduce((n, i) => n + i.quantity, 0);
        return { error: `You only have **${held}×** ${label} in a single stack — not enough to trade ${quantity}.` };
    }
    const effectType = resolveEffectType(itemId);
    if (effectType && (userDoc.activeEffects || []).some(e => e.type === effectType && isActiveEffect(e))) {
        return { error: `You can't trade ${label} while it's active as an effect.` };
    }
    return { item: { itemId, quantity, value: Math.max(0, meta.value ?? 0) * quantity, name: meta.name, emoji: meta.emoji } };
}

/** True when a side has committed nothing at all. */
const sideEmpty = side => !side.coins && !side.item;

/** One side's committed offer, for the shared embed. */
function describeSide(side, currency) {
    if (sideEmpty(side)) return '*nothing yet*';
    const parts = [];
    if (side.coins) parts.push(`${currency}${side.coins.toLocaleString()}`);
    if (side.item) parts.push(`${side.item.quantity}× ${side.item.emoji ?? ''} ${side.item.name ?? side.item.itemId}`.trim());
    return parts.join('\n');
}

/** The shared trade embed for the current state. */
function buildTradeEmbed({ a, b, aSide, bSide, confirmed, currency, status }) {
    const tick = id => (confirmed[id] ? '✅' : '⬜');
    return new EmbedBuilder()
        .setColor(status === 'done' ? COLORS.SUCCESS : status === 'cancelled' ? COLORS.ERROR : COLORS.INFO)
        .setTitle('🤝 Trade')
        .setDescription(status
            ? { done: 'Trade complete.', cancelled: 'Trade cancelled — nothing was exchanged.', expired: 'Trade expired — nothing was exchanged.' }[status]
            : 'Both sides add coins and/or an item, then both confirm. Changing an offer clears both confirmations. Expires after two minutes idle.')
        .addFields(
            { name: `${tick(a.id)} ${a.username}`, value: describeSide(aSide, currency), inline: true },
            { name: `${tick(b.id)} ${b.username}`, value: describeSide(bSide, currency), inline: true },
        );
}

/**
 * Run a confirmed trade to completion: check the daily caps against freshly-read
 * documents, settle the escrow, and record the caps that were spent. Separated
 * from the collector so the money path can be driven directly in tests (#1010).
 *
 * @returns {Promise<{ok: boolean, message?: string, delivered?: boolean, owed?: boolean, reason?: string}>}
 */
async function finalizeTrade({ tradeId, guildId, a, b, aSide, bSide, limits, currency, Model = User }) {
    if (sideEmpty(aSide) && sideEmpty(bSide)) {
        return { ok: false, message: 'Nobody has offered anything to trade.' };
    }

    const [aDoc, bDoc] = await Promise.all([
        Model.findOne({ userId: a.id, guildId }).lean(),
        Model.findOne({ userId: b.id, guildId }).lean(),
    ]);

    const offer = {
        tradeId, guildId,
        a: { userId: a.id, coins: aSide.coins, item: aSide.item },
        b: { userId: b.id, coins: bSide.coins, item: bSide.item },
    };

    // Friendly pre-flight for a clear message; the load-bearing enforcement is
    // the guarded reservation settleTrade does in the take phase, which also
    // catches a cap reached by a concurrent trade between this read and the swap.
    const capRefusal = checkTradeBudgets(offer, { aDoc, bDoc, limits, currency });
    if (capRefusal) return { ok: false, message: capRefusal };

    const result = await settleTrade(offer, { limits, aDoc, bDoc, Model });
    if (!result.success) {
        if (result.reason?.startsWith('budget:')) {
            return { ok: false, reason: result.reason, message: 'That would put one of you over a daily transfer cap — adjust the amounts and try again.' };
        }
        const short = result.reason?.startsWith('short:') || result.reason?.startsWith('item:');
        return {
            ok: false,
            reason: result.reason,
            message: short
                ? 'One side no longer has what they offered — the trade was called off and nothing changed hands.'
                : 'The trade could not be completed and has been called off. Anything taken was returned.',
        };
    }

    return { ok: true, delivered: result.delivered, owed: result.owed };
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('trade')
        .setDescription('Trade coins and/or an item with another member — both sides confirm before anything moves.')
        .addUserOption(o => o.setName('user').setDescription('Who to trade with.').setRequired(true)),

    async execute(interaction) {
        const guildId = interaction.guild.id;
        const guildSettings = await getGuildSettings(guildId);
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const a = interaction.user;
        const b = interaction.options.getUser('user');
        if (b.id === a.id) return interaction.reply({ content: "You can't trade with yourself.", flags: MessageFlags.Ephemeral });
        if (b.bot) return interaction.reply({ content: "You can't trade with a bot.", flags: MessageFlags.Ephemeral });

        const tooNew = accountAgeRefusal(a, b, { noun: 'trades' });
        if (tooNew) return interaction.reply({ content: tooNew, flags: MessageFlags.Ephemeral });

        const [aDoc, bDoc] = await Promise.all([
            User.findOne({ userId: a.id, guildId }).lean(),
            User.findOne({ userId: b.id, guildId }).lean(),
        ]);
        const frozen = frozenRefusal(aDoc, bDoc, { mention: `<@${b.id}>` });
        if (frozen) return interaction.reply({ content: frozen, flags: MessageFlags.Ephemeral });

        const currency = guildSettings?.economy?.currency || '💰';
        const limits = giftLimits(guildSettings);
        const shopItems = guildSettings?.shop ?? [];
        const tradeId = `${a.id}_${b.id}_${Date.now()}`;

        const sides = { [a.id]: emptySide(), [b.id]: emptySide() };
        const confirmed = { [a.id]: false, [b.id]: false };
        let settling = false;
        // Cleared when the collector ends (timeout/settle/cancel). A modal can
        // outlive it — opened before the window closed, submitted after — and
        // its handler checks this before touching anything.
        let active = true;

        const cid = suffix => `trade_${suffix}_${tradeId}`;
        const controls = () => [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(cid('coins')).setLabel('Set coins').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(cid('item')).setLabel('Set item').setStyle(ButtonStyle.Secondary),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(cid('confirm')).setLabel('Confirm').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(cid('cancel')).setLabel('Cancel').setStyle(ButtonStyle.Danger),
            ),
        ];
        const render = (status = null) => buildTradeEmbed({
            a, b, aSide: sides[a.id], bSide: sides[b.id], confirmed, currency, status,
        });

        await interaction.reply({ content: `<@${b.id}>, you have been invited to trade.`, embeds: [render()], components: controls() });
        const message = await interaction.fetchReply();

        const participants = [a.id, b.id];
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: ownedBy(participants, i => i.customId.endsWith(tradeId), 'This trade is between two other people.'),
            time: WINDOW_MS,
        });

        // Reading a fresh document each time a member sets coins/item, so the
        // dropdown of what they hold and the wallet the amount is checked against
        // are current — the load-bearing checks are still the keyed debits at
        // settle time.
        const freshDoc = userId => User.findOne({ userId, guildId }).lean();

        const resetConfirms = () => { confirmed[a.id] = false; confirmed[b.id] = false; };

        // A submit is only allowed to change the offer while the trade is still
        // open and not already settling. Editing clears both confirmations, so
        // a change can never ride a confirmation the other side gave against the
        // old offer.
        const staleSubmit = () => settling || !active;

        const askCoins = async btn => {
            // Reset before the modal opens: while it is open the offer is being
            // changed, so neither prior confirmation still stands.
            resetConfirms();
            await interaction.editReply({ embeds: [render()], components: controls() }).catch(() => {});
            const modal = new ModalBuilder().setCustomId(`${cid('coinsm')}`).setTitle('Set coins to offer');
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('amount').setLabel('Coins (0 to clear)').setStyle(TextInputStyle.Short).setRequired(true),
            ));
            await btn.showModal(modal);
            const submit = await btn.awaitModalSubmit({ time: 60_000, filter: i => i.user.id === btn.user.id && i.customId === cid('coinsm') }).catch(() => null);
            if (!submit) return;
            if (staleSubmit()) return submit.deferUpdate().catch(() => {});
            const raw = Number(submit.fields.getTextInputValue('amount'));
            if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
                return submit.reply({ content: 'Enter a whole number of coins (0 or more).', flags: MessageFlags.Ephemeral });
            }
            const doc = await freshDoc(btn.user.id);
            if (raw > (doc?.balance ?? 0)) {
                return submit.reply({ content: `You only have ${currency}${(doc?.balance ?? 0).toLocaleString()}.`, flags: MessageFlags.Ephemeral });
            }
            sides[btn.user.id].coins = raw;
            resetConfirms();
            await submit.deferUpdate().catch(() => {});
            await interaction.editReply({ embeds: [render()], components: controls() }).catch(() => {});
        };

        const askItem = async btn => {
            resetConfirms();
            await interaction.editReply({ embeds: [render()], components: controls() }).catch(() => {});
            const modal = new ModalBuilder().setCustomId(`${cid('itemm')}`).setTitle('Set an item to offer');
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('item').setLabel('Item name (blank to clear)').setStyle(TextInputStyle.Short).setRequired(false),
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('qty').setLabel('Quantity').setStyle(TextInputStyle.Short).setRequired(false).setValue('1'),
                ),
            );
            await btn.showModal(modal);
            const submit = await btn.awaitModalSubmit({ time: 60_000, filter: i => i.user.id === btn.user.id && i.customId === cid('itemm') }).catch(() => null);
            if (!submit) return;
            if (staleSubmit()) return submit.deferUpdate().catch(() => {});
            const typed = submit.fields.getTextInputValue('item').trim();
            if (!typed) {
                sides[btn.user.id].item = null;
                resetConfirms();
                await submit.deferUpdate().catch(() => {});
                return interaction.editReply({ embeds: [render()], components: controls() }).catch(() => {});
            }
            const qty = Math.max(1, Math.floor(Number(submit.fields.getTextInputValue('qty')) || 1));
            const doc = await freshDoc(btn.user.id);
            const resolved = resolveItemForTrade(doc, typed, qty, { shopItems });
            if (resolved.error) return submit.reply({ content: resolved.error, flags: MessageFlags.Ephemeral });
            sides[btn.user.id].item = resolved.item;
            resetConfirms();
            await submit.deferUpdate().catch(() => {});
            await interaction.editReply({ embeds: [render()], components: controls() }).catch(() => {});
        };

        collector.on('collect', async btn => {
            try {
                const action = btn.customId.slice('trade_'.length, btn.customId.length - tradeId.length - 1);
                if (action === 'coins') return void await askCoins(btn);
                if (action === 'item') return void await askItem(btn);

                if (action === 'cancel') {
                    await btn.update({ embeds: [render('cancelled')], components: [] }).catch(() => {});
                    return collector.stop('cancelled');
                }

                if (action === 'confirm') {
                    confirmed[btn.user.id] = true;
                    if (!(confirmed[a.id] && confirmed[b.id])) {
                        return void await btn.update({ embeds: [render()], components: controls() }).catch(() => {});
                    }
                    // Both confirmed. Latch so a second confirm racing the settle
                    // cannot start it twice.
                    if (settling) return void await btn.deferUpdate().catch(() => {});
                    settling = true;
                    await btn.update({ embeds: [render()], components: [] }).catch(() => {});

                    // Snapshot both offers as they stand at the moment both sides
                    // confirmed, so a modal submit landing during finalize's
                    // database reads cannot change what settles. Editing has
                    // already cleared confirmations, so this is only defence in
                    // depth — but it is the values both parties agreed to.
                    const snapshot = side => ({ coins: side.coins, item: side.item });
                    const outcome = await finalizeTrade({
                        tradeId, guildId, a, b, aSide: snapshot(sides[a.id]), bSide: snapshot(sides[b.id]), limits, currency,
                    });

                    if (!outcome.ok) {
                        settling = false;
                        resetConfirms();
                        await interaction.followUp({ content: `⚠️ ${outcome.message} You can adjust and try again.`, flags: MessageFlags.Ephemeral }).catch(() => {});
                        await interaction.editReply({ embeds: [render()], components: controls() }).catch(() => {});
                        return;
                    }

                    const note = outcome.delivered
                        ? 'Everything changed hands.'
                        : 'Some of it could not be delivered and has been recorded for an admin to settle.';
                    await interaction.editReply({ embeds: [render('done').setDescription(`Trade complete. ${note}`)], components: [] }).catch(() => {});
                    return collector.stop('done');
                }
            } catch (err) {
                console.error('[trade] collector error:', err);
            }
        });

        collector.on('end', async (_collected, reason) => {
            active = false;
            if (['done', 'cancelled'].includes(reason)) return;
            await interaction.editReply({ embeds: [render('expired')], components: [] }).catch(() => {});
        });
    },

    // Seams for tests — the money path without the Discord collector (#1010).
    __test__: { resolveItemForTrade, finalizeTrade, buildTradeEmbed, describeSide, sideEmpty },
};
