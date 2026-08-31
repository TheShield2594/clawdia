'use strict';

// `/fish shop rod` — buying a rod, and equipping it on the way out.

const {
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User = require('../../../../models/User');
const { attachGrind } = require('../../../../utils/grindProfile');
const { ensureFishingData } = require('../../../../services/fishService');
const { ROD_BY_SLUG } = require('../../../../data/fishData');
const { getItemImageAttachment } = require('../../../../utils/itemImageHelper');
const COLORS = require('../../../../utils/embedColors');

async function handleBuyRod(interaction, user, currency) {
    const slug    = interaction.options.getString('type');
    const rodData = ROD_BY_SLUG[slug];

    if (!rodData) {
        return interaction.reply({ content: 'Unknown rod type.', flags: MessageFlags.Ephemeral });
    }
    if (user.balance < rodData.cost) {
        return interaction.reply({
            content: `You need **${currency}${rodData.cost.toLocaleString()}** to buy the **${rodData.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`${rodData.emoji} Purchase ${rodData.name}?`)
        .setDescription(rodData.description)
        .addFields(
            { name: 'Cost',         value: `${currency}${rodData.cost.toLocaleString()}`,                                               inline: true },
            { name: 'Durability',   value: `${rodData.baseDurability}`,                                                                  inline: true },
            { name: 'Success Rate', value: `${Math.round(rodData.successRate * 100)}%`,                                                  inline: true },
            { name: 'Rarity Boost', value: rodData.rarityBoost > 0 ? `+${Math.round(rodData.rarityBoost * 100)}%` : 'None',             inline: true },
            { name: 'Bait Type',    value: rodData.requiresBait ? rodData.baitType.replace(/_/g, ' ') : 'No bait needed',               inline: true },
            { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`,                                               inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    const rodImg = await getItemImageAttachment(`fish:${rodData.slug || rodData.id}`, interaction.guild.id, { label: rodData.name }).catch(() => null);
    if (rodImg) confirmEmbed.setThumbnail(rodImg.url);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buyrod_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('buyrod_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const fishConfirmPayload = { embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true };
    if (rodImg) fishConfirmPayload.files = [rodImg.attachment];
    const reply = await interaction.reply(fishConfirmPayload);
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'buyrod_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        await attachGrind(freshUser);
        ensureFishingData(freshUser);

        // The charge is a guarded atomic debit, not `balance -= cost` followed by
        // a save. This runs in a button callback up to 30 seconds after the
        // confirmation was drawn, and `save()` writes balance as an absolute
        // `$set` — long enough for a casino bet in another channel to be wiped by
        // a rod purchase. The lock the command holds does not help: casino takes
        // a different key.
        const debited = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: rodData.cost } },
            { $inc: { balance: -rodData.cost } },
            { new: true, projection: { balance: 1 } },
        );
        if (!debited) {
            return btn.update({ content: `Insufficient funds. You need ${currency}${rodData.cost.toLocaleString()}.`, embeds: [], components: [] });
        }

        // Take the authoritative balance and keep the save off that path.
        freshUser.balance = debited.balance;
        freshUser.unmarkModified('balance');
        freshUser.fishing.rods.push({
            name:              rodData.name,
            tier:              rodData.tier,
            slug:              rodData.slug,
            currentDurability: rodData.baseDurability,
            maxDurability:     rodData.baseDurability,
            baseDurability:    rodData.baseDurability,
            repairCount:       0,
            upgrade:           null,
            status:            'good'
        });
        freshUser.markModified('fishing');

        try {
            await freshUser.save();
        } catch (err) {
            console.error('[fishshop rod] save error:', err);
            // The coins are already gone; hand them back rather than charging for
            // a rod that was never added.
            await User.updateOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: rodData.cost } },
            ).catch(refundErr => console.error('[fishshop rod] refund after failed save:', refundErr));
            return btn.update({ content: 'Something went wrong and your coins were refunded. Please try again.', embeds: [], components: [] });
        }

        const rodIndex = freshUser.fishing.rods.length;
        return btn.update({
            embeds: [
                new EmbedBuilder()
                    .setColor(COLORS.SUCCESS)
                    .setTitle(`${rodData.emoji} ${rodData.name} Purchased!`)
                    .setDescription(`You now own a **${rodData.name}**. Equip it with \`/fish inv equip ${rodIndex}\`.`)
                    .addFields(
                        { name: 'Spent',   value: `${currency}${rodData.cost.toLocaleString()}`,      inline: true },
                        { name: 'Balance', value: `${currency}${freshUser.balance.toLocaleString()}`, inline: true }
                    )
            ],
            components: []
        });
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

module.exports = { handleBuyRod };
