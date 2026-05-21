'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { MATERIAL_NAMES, CONSUMABLES, BLAST_PACKS, PICKAXE_BY_TIER } = require('../../data/mineData');
const { ensureMineData, pickaxeStatusEmoji, durabilityBar } = require('../../services/mineService');

module.exports = {
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('mineinv')
        .setDescription('Manage your mining inventory and pickaxes')
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('View your pickaxes, charges, consumables, and materials'))
        .addSubcommand(sub =>
            sub.setName('equip')
                .setDescription('Equip a pickaxe from your inventory')
                .addIntegerOption(o =>
                    o.setName('slot')
                        .setDescription('Pickaxe slot number (use /mineinv view to see slots)')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(10))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        const currency = guildSettings?.economy?.currency ?? '💰';

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );
        ensureMineData(user);
        const m = user.mining;

        // ── VIEW ───────────────────────────────────────────────────────────
        if (sub === 'view') {
            const embed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle(`⛏️ ${interaction.user.username}'s Mining Inventory`)
                .setTimestamp();

            // Pickaxes
            if (!m.pickaxes.length) {
                embed.addFields({ name: '🪓 Pickaxes', value: 'None — buy one with `/mineshop pickaxe`', inline: false });
            } else {
                const lines = m.pickaxes.map((p, i) => {
                    const isEquipped = i === m.equippedPickaxeIndex;
                    const bar = durabilityBar(p.currentDurability, p.maxDurability);
                    const upgradeStr = p.upgrade ? ` [${p.upgrade.replace(/_/g, ' ')}]` : '';
                    return `**Slot ${i + 1}**${isEquipped ? ' *(equipped)*' : ''} — ${p.name}${upgradeStr} ${pickaxeStatusEmoji(p.status)}\n> ${bar} ${p.currentDurability}/${p.maxDurability}`;
                });
                embed.addFields({ name: '🪓 Pickaxes', value: lines.join('\n'), inline: false });
            }

            // Blast charges
            const chargeLines = BLAST_PACKS.map(b => {
                const stock = m.charges[b.chargeType] ?? 0;
                return `${b.emoji} ${b.chargeType.replace(/_/g, ' ')}: **${stock}**`;
            }).filter((_, i) => (m.charges[BLAST_PACKS[i].chargeType] ?? 0) > 0);

            embed.addFields({
                name: '💥 Blast Charges',
                value: chargeLines.length ? chargeLines.join('\n') : 'None',
                inline: true
            });

            // Consumables
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

            // Active buffs
            const buffs = [];
            if (m.activeMagnet)   buffs.push(`🧲 ${m.activeMagnet.replace(/_/g, ' ')} (${m.activeMagnetMinesLeft} mines left)`);
            if (m.activeLamp)     buffs.push(`🪔 Miner's Lamp (${m.activeLampMinesLeft} mines left)`);
            if (m.activeInstinct) buffs.push(`🎯 Miner's Instinct (queued)`);
            if (m.activeXpScroll) buffs.push(`📜 XP Scroll (queued)`);
            embed.addFields({ name: '🔋 Active Buffs', value: buffs.length ? buffs.join('\n') : 'None', inline: false });

            // Materials
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

        // ── EQUIP ──────────────────────────────────────────────────────────
        if (sub === 'equip') {
            const slot  = interaction.options.getInteger('slot') - 1;

            if (!m.pickaxes[slot]) {
                return interaction.reply({ content: `No pickaxe in slot ${slot + 1}.`, ephemeral: true });
            }

            const pickaxe = m.pickaxes[slot];
            if (pickaxe.status === 'broken') {
                return interaction.reply({ content: `**${pickaxe.name}** is broken and can't be equipped. Repair it first with \`/mineshop repair\`.`, ephemeral: true });
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
    }
};
