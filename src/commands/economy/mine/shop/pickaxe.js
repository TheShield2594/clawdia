'use strict';

// `/mine shop pickaxe` — buying a pickaxe, and equipping it on the way out.

const {
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User = require('../../../../models/User');
const { persistGrindIfNew } = require('../../../../utils/grindProfile');
const { PICKAXE_BY_SLUG } = require('../../../../data/mineData');
const { getItemImageAttachment } = require('../../../../utils/itemImageHelper');
const GrindProfile = require('../../../../models/GrindProfile');
const COLORS = require('../../../../utils/embedColors');
const { creditCoinsOrOwe } = require('../../../../utils/creditOrOwe');
const { shopRefundPayoutKey, shopGrantPayoutKey } = require('../../../../utils/payoutKey');
const { grantKeyPush, resolveShopGrant } = require('../../../../utils/shopGrant');

async function handleBuyPickaxe(interaction, user, currency) {
    const m = user.mining;

    const slug = interaction.options.getString('type');
    const autoEquip = interaction.options.getBoolean('equip') ?? true;
    const pickaxeData = PICKAXE_BY_SLUG[slug];

    if (!pickaxeData) return interaction.reply({ content: 'Unknown pickaxe type.', flags: MessageFlags.Ephemeral });

    if (user.balance < pickaxeData.cost) {
        return interaction.reply({
            content: `You need ${currency}${pickaxeData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`${pickaxeData.emoji} Purchase ${pickaxeData.name}?`)
        .addFields(
            { name: 'Cost',          value: `${currency}${pickaxeData.cost.toLocaleString()}`, inline: true },
            { name: 'Success Rate',  value: `${Math.round(pickaxeData.successRate * 100)}%`, inline: true },
            { name: 'Rarity Boost',  value: `+${Math.round(pickaxeData.rarityBoost * 100)}%`, inline: true },
            { name: 'Durability',    value: `${pickaxeData.baseDurability}`, inline: true },
            { name: 'Your Balance',  value: `${currency}${user.balance.toLocaleString()}`, inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    const pickaxeImg = await getItemImageAttachment(`mine:${pickaxeData.slug || pickaxeData.id}`, interaction.guild.id, { label: pickaxeData.name }).catch(() => null);
    if (pickaxeImg) confirmEmbed.setThumbnail(pickaxeImg.url);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('minepickaxe_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('minepickaxe_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const confirmPayload = { embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, withResponse: true };
    if (pickaxeImg) confirmPayload.files = [pickaxeImg.attachment];
    const response = await interaction.reply(confirmPayload);
    const reply = response.resource.message;
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    let actionPromise = null;
    collector.on('collect', btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }

        if (btn.customId === 'minepickaxe_cancel') {
            collector.stop();
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        actionPromise = (async () => {
        try {
            await btn.deferUpdate();

            const newPickaxe = {
                name: pickaxeData.name,
                tier: pickaxeData.tier,
                slug: pickaxeData.slug,
                currentDurability: pickaxeData.baseDurability,
                maxDurability: pickaxeData.baseDurability,
                baseDurability: pickaxeData.baseDurability,
                repairCount: 0,
                upgrade: null,
                status: 'good',
                acquiredAt: new Date()
            };

            // Before the debit, not after it: this write can throw, and thrown
            // after the charge it fell to the catch below with the coins gone and
            // no pickaxe and no refund.
            await persistGrindIfNew(user, 'mining');
            const updated = await User.findOneAndUpdate(
                { userId: user.userId, guildId: user.guildId, balance: { $gte: pickaxeData.cost } },
                { $inc: { balance: -pickaxeData.cost } },
                { new: true }
            );
            if (!updated) {
                return interaction.editReply({ content: `Insufficient funds. You need ${currency}${pickaxeData.cost.toLocaleString()} — check \`/balance\` and try again.`, embeds: [], components: [] });
            }

            // The grant stamps the purchase's key alongside the pickaxe (#1058):
            // a `$push` that committed but lost its response threw here and was
            // read as "never granted", so the debit was refunded over a pickaxe
            // the player kept. The key rides the same write, so a thrown grant's
            // outcome can be read back and the refund gated on a grant confirmed
            // absent.
            const grantKey = shopGrantPayoutKey(interaction.id);
            const identity = { userId: user.userId, guildId: user.guildId, system: 'mining' };
            let profUpdated = null, threw = false;
            try {
                profUpdated = await GrindProfile.findOneAndUpdate(
                    { ...identity },
                    { $push: { 'data.pickaxes': newPickaxe, ...grantKeyPush(grantKey) } },
                    { new: true }
                );
            } catch (err) {
                console.error('[mineshop pickaxe] profile push error:', err);
                threw = true;
            }

            const state = await resolveShopGrant({ result: profUpdated, threw, identity, key: grantKey });
            if (state === 'unresolved') {
                // The grant threw and its outcome could not be read back either.
                // The pickaxe may have been granted, so refunding risks handing
                // back the coins over a kept pickaxe — the over-credit this guards
                // against. Left for an admin rather than auto-refunded.
                return interaction.editReply({
                    content: `Purchase failed and its outcome could not be confirmed. You have **not** been refunded automatically: if the ${currency}${pickaxeData.cost.toLocaleString()} was charged without the ${pickaxeData.name} arriving, contact a server admin to sort it out.`,
                    embeds: [], components: [],
                });
            }
            if (state === 'absent') {
                // Refund the debit — the pickaxe was never granted — through
                // creditCoinsOrOwe (keyed) so a refund that will not land is
                // recorded for replay rather than lost under a message that says
                // it worked (#873).
                const refund = await creditCoinsOrOwe(
                    { userId: user.userId, guildId: user.guildId },
                    pickaxeData.cost,
                    { payoutKey: shopRefundPayoutKey(interaction.id), service: 'mine', jobName: 'pickaxeRefund' },
                );
                return interaction.editReply({
                    content: refund.credited
                        ? 'Purchase failed — your coins were refunded. Please try again.'
                        : refund.owed
                            ? `Purchase failed, and the ${currency}${pickaxeData.cost.toLocaleString()} charged could not be returned automatically — it has been recorded as owed and will be paid back once the problem clears. Tell an admin if it does not.`
                            : `Purchase failed, and the ${currency}${pickaxeData.cost.toLocaleString()} charged could not be returned or recorded — please contact a server admin.`,
                    embeds: [], components: [],
                });
            }

            // Grant applied; on a recovered lost-response grant `profUpdated` is
            // null, so fall back to appending in memory.
            m.pickaxes = profUpdated?.data.pickaxes ?? [...(m.pickaxes ?? []), newPickaxe];
            const newIndex = m.pickaxes.length - 1;

            if (autoEquip) {
                const oldIndex = m.equippedPickaxeIndex;
                m.equippedPickaxeIndex = newIndex;
                try {
                    await GrindProfile.updateOne(
                        { userId: user.userId, guildId: user.guildId, system: 'mining' },
                        { $set: { 'data.equippedPickaxeIndex': newIndex } }
                    );
                } catch (err) {
                    console.error('[mineshop pickaxe] equip update error:', err);
                    m.equippedPickaxeIndex = oldIndex;
                }
            }

            const equipped = m.equippedPickaxeIndex === newIndex;
            const embed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle(`${pickaxeData.emoji} Pickaxe Purchased!`)
                .setDescription(`You bought a **${pickaxeData.name}**!${equipped ? ' It has been equipped.' : ' Use `/mine equip` to equip it.'}`)
                .addFields(
                    { name: 'Success Rate',  value: `${Math.round(pickaxeData.successRate * 100)}%`, inline: true },
                    { name: 'Rarity Boost',  value: `+${Math.round(pickaxeData.rarityBoost * 100)}%`, inline: true },
                    { name: 'Durability',    value: `${pickaxeData.baseDurability}`, inline: true },
                    { name: 'Balance',       value: `${currency}${updated.balance.toLocaleString()}`, inline: true }
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [embed], components: [] });
        } catch (err) {
            console.error('[mineshop pickaxe] purchase error:', err);
            interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
        }
        })();

        collector.stop();
    });

    return new Promise(resolve => {
        collector.on('end', async (_, reason) => {
            if (reason === 'time') {
                interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
            }
            if (actionPromise) await actionPromise.catch(() => {});
            resolve();
        });
    });
}

module.exports = { handleBuyPickaxe };
