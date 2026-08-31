'use strict';

// `/hunt shop weapon` — buying a weapon, and the confirmation step a
// cross-economy price puts in front of it.

const {
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User = require('../../../../models/User');
const { persistGrindIfNew } = require('../../../../utils/grindProfile');
const { projectWeaponLifetime } = require('../../../../services/huntService');
const { LIMITS, WEAPON_BY_SLUG } = require('../../../../data/huntData');
const { getItemImageAttachment } = require('../../../../utils/itemImageHelper');
const GrindProfile = require('../../../../models/GrindProfile');
const COLORS = require('../../../../utils/embedColors');
const { isCrossEconomyWeapon, huntingDaysLabel } = require('./pricing');

async function handleBuyWeapon(interaction, user, currency) {
    const slug       = interaction.options.getString('type');
    const autoEquip  = interaction.options.getBoolean('equip') ?? true;
    const weaponData = WEAPON_BY_SLUG[slug];

    if (!weaponData) {
        return interaction.reply({ content: 'Unknown weapon type.', flags: MessageFlags.Ephemeral });
    }
    if (user.balance < weaponData.cost) {
        return interaction.reply({
            content: `You need **${currency}${weaponData.cost.toLocaleString()}** to buy the **${weaponData.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const ammoValue = weaponData.requiresAmmo
        ? `${weaponData.ammoType.replace(/_/g, ' ')} (${currency}${weaponData.ammoCost}/hunt)`
        : 'None required';

    const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`${weaponData.emoji} Purchase ${weaponData.name}?`)
        .setDescription(weaponData.description)
        .addFields(
            { name: 'Cost',         value: `${currency}${weaponData.cost.toLocaleString()}`,                         inline: true },
            { name: 'Durability',   value: `${weaponData.baseDurability}`,                                            inline: true },
            { name: 'Success Rate', value: `${Math.round(weaponData.successRate * 100)}%`,                            inline: true },
            { name: 'Rarity Boost', value: weaponData.rarityBoost > 0 ? `+${Math.round(weaponData.rarityBoost * 100)}%` : 'None', inline: true },
            { name: 'Ammo',         value: ammoValue,                                                                 inline: true },
            { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`,                             inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    // The one place a hunter commits to the number, so it is the place to say
    // what the number means. A weapon is a consumable — every shop repair drops
    // maxDurability by 10% of base, so the top tiers cost their purchase price
    // again several times over before they are condemned — and at the top of
    // the ladder none of it is fundable from hunting alone.
    if (isCrossEconomyWeapon(weaponData)) {
        const { repairs, maintenance, lifetimeCost, firstRepairCost } = projectWeaponLifetime(weaponData);
        confirmEmbed.addFields({
            name: '🌐 A whole-economy purchase',
            value: [
                `Hunting is capped at ${currency}${LIMITS.DAILY_SOFT_CAP.toLocaleString()} a day before payouts halve, so the sticker price alone is about **${huntingDaysLabel(weaponData.cost)} days** of hunting.`,
                `The sticker price is the down payment. A full repair runs ${currency}${firstRepairCost.toLocaleString()}, it has **${repairs}** of them before the wear condemns it, and keeping it in the field costs ${currency}${maintenance.toLocaleString()} over that life.`,
                `**Total cost of ownership: ${currency}${lifetimeCost.toLocaleString()}** — about **${huntingDaysLabel(lifetimeCost)} days** of hunting.`,
                `It is priced for a wallet fed by everything you do: casino, work, crime, heists and the rest all pay into the same balance.`,
            ].join('\n'),
            inline: false,
        });
    }

    const weaponImg = await getItemImageAttachment(`hunt:${weaponData.slug || weaponData.id}`, interaction.guild.id, { label: weaponData.name }).catch(() => null);
    if (weaponImg) confirmEmbed.setThumbnail(weaponImg.url);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buygun_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('buygun_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const huntConfirmPayload = { embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true };
    if (weaponImg) huntConfirmPayload.files = [weaponImg.attachment];
    const reply = await interaction.reply(huntConfirmPayload);
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'buygun_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        try {
            await btn.deferUpdate();
            await completePurchase(btn, user, weaponData, autoEquip, currency);
        } catch (err) {
            console.error('[huntshop weapon] purchase error:', err);
            btn.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
        }
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

async function completePurchase(interactionOrBtn, user, weaponData, autoEquip, currency) {
    const newWeapon = {
        name:              weaponData.name,
        tier:              weaponData.tier,
        slug:              weaponData.slug,
        currentDurability: weaponData.baseDurability,
        maxDurability:     weaponData.baseDurability,
        baseDurability:    weaponData.baseDurability,
        repairCount:       0,
        upgrade:           null,
        status:            'good',
        acquiredAt:        new Date()
    };

    const updated = await User.findOneAndUpdate(
        { userId: user.userId, guildId: user.guildId, balance: { $gte: weaponData.cost } },
        { $inc: { balance: -weaponData.cost } },
        { new: true }
    );

    if (!updated) {
        const reply = { content: `Insufficient funds. You need ${currency}${weaponData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`, embeds: [], components: [] };
        return interactionOrBtn.editReply ? interactionOrBtn.editReply(reply) : interactionOrBtn.update(reply);
    }

    await persistGrindIfNew(user, 'hunt');
    const profUpdated = await GrindProfile.findOneAndUpdate(
        { userId: user.userId, guildId: user.guildId, system: 'hunt' },
        { $push: { 'data.weapons': newWeapon } },
        { new: true }
    ).catch(err => { console.error('[huntshop weapon] profile push error:', err); return null; });

    if (!profUpdated) {
        // Refund the debit — the weapon was never granted
        await User.updateOne({ userId: user.userId, guildId: user.guildId }, { $inc: { balance: weaponData.cost } }).catch(() => {});
        const reply = { content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] };
        return interactionOrBtn.editReply ? interactionOrBtn.editReply(reply) : interactionOrBtn.update(reply);
    }

    // Sync the in-memory profile so any later save doesn't clobber the purchase
    user.hunt.weapons = profUpdated.data.weapons;
    const h = user.hunt;
    const newIndex = h.weapons.length - 1;

    if (autoEquip) {
        const oldIndex = h.equippedWeaponIndex;
        h.equippedWeaponIndex = newIndex;
        try {
            await GrindProfile.updateOne(
                { userId: user.userId, guildId: user.guildId, system: 'hunt' },
                { $set: { 'data.equippedWeaponIndex': newIndex } }
            );
        } catch (err) {
            console.error('[huntshop weapon] equip update error:', err);
            h.equippedWeaponIndex = oldIndex;
        }
    }

    const equipped = h.equippedWeaponIndex === newIndex;
    const embed = new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle(`${weaponData.emoji} ${weaponData.name} Purchased!`)
        .setDescription(weaponData.description)
        .addFields(
            { name: 'Durability',   value: `${weaponData.baseDurability}/${weaponData.baseDurability}`,                                                               inline: true },
            { name: 'Success Rate', value: `${Math.round(weaponData.successRate * 100)}%`,                                                                            inline: true },
            { name: 'Rarity Boost', value: `+${Math.round(weaponData.rarityBoost * 100)}%`,                                                                          inline: true },
            { name: 'Ammo',         value: weaponData.requiresAmmo ? `${weaponData.ammoType.replace(/_/g, ' ')} (${currency}${weaponData.ammoCost}/hunt)` : 'None required', inline: true },
            { name: 'Weapon #',     value: `#${newIndex + 1} in inventory`,                                                                                           inline: true },
            { name: 'Status',       value: equipped ? '✅ Equipped' : `Use \`/hunt inv equip ${newIndex + 1}\``,                                                       inline: true }
        )
        .addFields({ name: 'New Balance', value: `${currency}${updated.balance.toLocaleString()}` })
        .setFooter({ text: equipped ? 'Ready to hunt! Use /hunt start' : `Equip with /hunt inv equip ${newIndex + 1}` });

    const reply = { embeds: [embed], components: [] };
    if (interactionOrBtn.editReply) return interactionOrBtn.editReply(reply);
    return interactionOrBtn.update(reply);
}

module.exports = { handleBuyWeapon, completePurchase };
