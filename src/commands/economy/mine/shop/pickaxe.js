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

            const updated = await User.findOneAndUpdate(
                { userId: user.userId, guildId: user.guildId, balance: { $gte: pickaxeData.cost } },
                { $inc: { balance: -pickaxeData.cost } },
                { new: true }
            );
            if (!updated) {
                return interaction.editReply({ content: `Insufficient funds. You need ${currency}${pickaxeData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`, embeds: [], components: [] });
            }

            await persistGrindIfNew(user, 'mining');
            const profUpdated = await GrindProfile.findOneAndUpdate(
                { userId: user.userId, guildId: user.guildId, system: 'mining' },
                { $push: { 'data.pickaxes': newPickaxe } },
                { new: true }
            ).catch(err => { console.error('[mineshop pickaxe] profile push error:', err); return null; });

            if (!profUpdated) {
                await User.updateOne({ userId: user.userId, guildId: user.guildId }, { $inc: { balance: pickaxeData.cost } }).catch(() => {});
                return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
            }

            m.pickaxes = profUpdated.data.pickaxes;
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
                .setDescription(`You bought a **${pickaxeData.name}**!${equipped ? ' It has been equipped.' : ' Use `/mine inv equip` to equip it.'}`)
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
