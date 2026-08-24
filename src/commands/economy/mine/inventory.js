'use strict';

// The /mine inv group — pickaxes, consumables and ore.

const Guild = require('../../../models/Guild');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { ensureMineData, durabilityBar, pickaxeStatusEmoji } = require('../../../services/mineService');
const { packFieldsCapped } = require('../../../utils/embedFields');
const { BLAST_PACKS, CONSUMABLES, MATERIAL_NAMES } = require('../../../data/mineData');
const COLORS = require('../../../utils/embedColors');

// ─── INV ──────────────────────────────────────────────────────────────────────

async function handleInv(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureMineData(user);
    const m = user.mining;

    if (sub === 'view') {
        const embed = new EmbedBuilder()
            .setColor('#b5651d')
            .setTitle(`⛏️ ${interaction.user.username}'s Mining Inventory`)
            .setTimestamp();

        if (!m.pickaxes.length) {
            embed.addFields({ name: '🪓 Pickaxes', value: 'None — buy one with `/mine shop pickaxe`', inline: false });
        } else {
            const lines = m.pickaxes.map((p, i) => {
                const isEquipped = i === m.equippedPickaxeIndex;
                const bar = durabilityBar(p.currentDurability, p.maxDurability);
                const upgradeStr = p.upgrade ? ` [${p.upgrade.replace(/_/g, ' ')}]` : '';
                return `**Slot ${i + 1}**${isEquipped ? ' *(equipped)*' : ''} — ${p.name}${upgradeStr} ${pickaxeStatusEmoji(p.status)}\n> ${bar} ${p.currentDurability}/${p.maxDurability}`;
            });
            // Nothing caps how many pickaxes a miner accumulates and each entry runs
            // ~85 characters, so a single field ran out of room around the twelfth one
            // and Discord rejected the whole embed. Spill into continuation fields —
            // but only so many: an embed also has a 6,000-character budget across all
            // of its fields, which unbounded spilling would eventually blow instead.
            const PICKAXE_FIELDS = 3;
            const { fields, omitted } = packFieldsCapped('🪓 Pickaxes', lines, { maxFields: PICKAXE_FIELDS });
            embed.addFields(...fields);
            if (omitted > 0) {
                embed.addFields({
                    name: '…and more',
                    value: `${omitted} further pickaxe(s) not shown. \`/mine inv discard\` clears broken and condemned ones.`,
                    inline: false
                });
            }

            const junk = m.pickaxes.filter(p => p.status === 'broken' || p.status === 'condemned').length;
            if (junk > 0) {
                embed.addFields({
                    name: '🗑️ Unusable',
                    value: `${junk} pickaxe${junk === 1 ? ' is' : 's are'} broken or condemned — clear ${junk === 1 ? 'it' : 'them'} out with \`/mine inv discard\`.`,
                    inline: false
                });
            }
        }

        const chargeLines = BLAST_PACKS.map(b => {
            const stock = m.charges[b.chargeType] ?? 0;
            return `${b.emoji} ${b.chargeType.replace(/_/g, ' ')}: **${stock}**`;
        }).filter((_, i) => (m.charges[BLAST_PACKS[i].chargeType] ?? 0) > 0);

        embed.addFields({
            name: '💥 Blast Charges',
            value: chargeLines.length ? chargeLines.join('\n') : 'None',
            inline: true
        });

        const consumableLines = Object.entries(m.consumables ?? {})
            .filter(([, qty]) => qty > 0)
            .map(([id, qty]) => {
                const def = CONSUMABLES[id];
                return def ? `${def.emoji} ${def.name}: **${qty}**` : `${id}: **${qty}**`;
            });

        embed.addFields({
            name: '🎒 Consumables',
            value: consumableLines.length ? consumableLines.join('\n') : 'None',
            inline: true
        });

        const buffs = [];
        if (m.activeMagnet)   buffs.push(`🧲 ${m.activeMagnet.replace(/_/g, ' ')} (${m.activeMagnetMinesLeft} mines left)`);
        if (m.activeLamp)     buffs.push(`🪔 Miner's Lamp (${m.activeLampMinesLeft} mines left)`);
        if (m.activeInstinct) buffs.push(`🎯 Miner's Instinct (queued)`);
        if (m.activeXpScroll) buffs.push(`📜 XP Scroll (queued)`);
        embed.addFields({ name: '🔋 Active Buffs', value: buffs.length ? buffs.join('\n') : 'None', inline: false });

        const matLines = Object.entries(m.materials ?? {})
            .filter(([, qty]) => qty > 0)
            .map(([id, qty]) => `${MATERIAL_NAMES[id] ?? id}: **${qty}**`);

        embed.addFields({
            name: '🪨 Materials',
            value: matLines.length ? matLines.join('\n') : 'None — find them by mining rare ores',
            inline: false
        });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'equip') {
        const slot = interaction.options.getInteger('slot') - 1;

        if (!m.pickaxes[slot]) {
            return interaction.reply({ content: `No pickaxe in slot ${slot + 1}.`, flags: MessageFlags.Ephemeral });
        }

        const pickaxe = m.pickaxes[slot];
        if (pickaxe.status === 'broken') {
            return interaction.reply({ content: `**${pickaxe.name}** is broken and can't be equipped. Repair it first with \`/mine shop repair\`.`, flags: MessageFlags.Ephemeral });
        }

        m.equippedPickaxeIndex = slot;
        user.markModified('mining');
        await user.save();

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#b5651d')
                    .setTitle('⛏️ Pickaxe Equipped')
                    .setDescription(`You equipped **${pickaxe.name}**.`)
                    .addFields(
                        { name: 'Durability', value: `${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
                        { name: 'Status',     value: `${pickaxeStatusEmoji(pickaxe.status)} ${pickaxe.status}`, inline: true },
                        { name: 'Upgrade',    value: pickaxe.upgrade ? pickaxe.upgrade.replace(/_/g, ' ') : 'None', inline: true }
                    )
                    .setTimestamp()
            ]
        });
    }

    if (sub === 'discard') {
        const index = interaction.options.getInteger('slot') - 1;

        if (index < 0 || index >= m.pickaxes.length) {
            return interaction.reply({
                content: `No pickaxe in slot ${index + 1}. You have ${m.pickaxes.length} pickaxe(s).`,
                flags: MessageFlags.Ephemeral
            });
        }

        const pickaxe = m.pickaxes[index];
        if (pickaxe.status !== 'broken' && pickaxe.status !== 'condemned') {
            return interaction.reply({
                content: `**${pickaxe.name}** is not broken or condemned. You can only discard unusable pickaxes.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Splicing shifts every later slot down by one, so the equipped index has to
        // move with it or the miner silently ends up wielding a different pickaxe.
        const wasEquipped = m.equippedPickaxeIndex === index;
        m.pickaxes.splice(index, 1);

        if (wasEquipped) {
            m.equippedPickaxeIndex = m.pickaxes.length > 0 ? 0 : -1;
        } else if (m.equippedPickaxeIndex > index) {
            m.equippedPickaxeIndex -= 1;
        }

        user.markModified('mining');
        await user.save();

        const nowEquipped = m.pickaxes[m.equippedPickaxeIndex];
        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(COLORS.ERROR)
                    .setTitle('🗑️ Pickaxe Discarded')
                    .setDescription(
                        `**${pickaxe.name}** has been discarded.` +
                        (wasEquipped && nowEquipped ? `\nYou are now wielding **${nowEquipped.name}**.` : '')
                    )
                    .setFooter({ text: m.pickaxes.length === 0
                        ? 'Buy a new pickaxe with /mine shop pickaxe'
                        : 'Use /mine inv view to see your remaining pickaxes' })
                    .setTimestamp()
            ]
        });
    }
}

module.exports = {
    handleInv,
};
