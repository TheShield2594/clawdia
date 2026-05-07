'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { WEAPON_BY_TIER, CONSUMABLES } = require('../../data/huntData');
const { ensureHuntData, applyRepair, weaponStatusEmoji, durabilityBar } = require('../../services/huntService');

module.exports = {
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('huntrepair')
        .setDescription('Repair your equipped weapon')
        .addSubcommand(sub =>
            sub.setName('gun')
                .setDescription('Repair your equipped weapon at the shop')
                .addIntegerOption(o =>
                    o.setName('amount')
                        .setDescription('Durability to restore (multiples of 20; defaults to full repair)')
                        .setRequired(false)
                        .setMinValue(20)))
        .addSubcommand(sub =>
            sub.setName('kit')
                .setDescription('Use a repair kit from your inventory on your equipped weapon')
                .addStringOption(o =>
                    o.setName('size')
                        .setDescription('Repair kit size')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Small (+20 durability)', value: 'repair_kit_small' },
                            { name: 'Large (+50 durability)', value: 'repair_kit_large' }
                        ))),

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
        ensureHuntData(user);
        const h = user.hunt;

        if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
            return interaction.reply({ content: 'No weapon equipped. Buy one with `/huntbuygun` first.', ephemeral: true });
        }

        const weapon = h.weapons[h.equippedWeaponIndex];

        // ── REPAIR KIT ─────────────────────────────────────────────────────
        if (sub === 'kit') {
            const kitId  = interaction.options.getString('size');
            const kitDef = CONSUMABLES[kitId];
            const stock  = h.consumables[kitId] ?? 0;

            if (stock <= 0) {
                return interaction.reply({
                    content: `You don't have any **${kitDef.name}**. Buy them with \`/huntshop buy ${kitId}\`.`,
                    ephemeral: true
                });
            }

            if (weapon.status === 'condemned') {
                return interaction.reply({ content: 'This weapon is condemned and cannot be repaired. Replace it with `/huntbuygun`.', ephemeral: true });
            }

            if (weapon.currentDurability >= weapon.maxDurability) {
                return interaction.reply({ content: `Your **${weapon.name}** is already at full durability.`, ephemeral: true });
            }

            const before = weapon.currentDurability;
            weapon.currentDurability = Math.min(weapon.maxDurability, weapon.currentDurability + kitDef.durabilityRestore);
            if (weapon.status === 'broken') weapon.status = 'good';
            h.consumables[kitId] -= 1;
            user.markModified('hunt');
            await user.save();

            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${kitDef.emoji} Repair Kit Used`)
                .setDescription(`Your **${weapon.name}** has been field-repaired.`)
                .addFields(
                    { name: 'Before', value: `${before}/${weapon.maxDurability}`,                              inline: true },
                    { name: 'After',  value: `${weapon.currentDurability}/${weapon.maxDurability}`,            inline: true },
                    { name: 'Kits Remaining', value: `${h.consumables[kitId]} × ${kitDef.name}`,             inline: true },
                    { name: 'Durability Bar', value: durabilityBar(weapon.currentDurability, weapon.maxDurability) + ` ${weapon.currentDurability}/${weapon.maxDurability}` }
                )
                .setFooter({ text: 'Field repairs do not degrade max durability' });

            return interaction.reply({ embeds: [embed] });
        }

        // ── SHOP REPAIR ────────────────────────────────────────────────────
        if (sub === 'gun') {
            if (weapon.status === 'condemned') {
                return interaction.reply({ content: 'This weapon is **condemned** and cannot be repaired. Replace it with `/huntbuygun`.', ephemeral: true });
            }

            if (weapon.currentDurability >= weapon.maxDurability && weapon.status !== 'broken') {
                return interaction.reply({ content: `Your **${weapon.name}** is already at full durability (${weapon.currentDurability}/${weapon.maxDurability}).`, ephemeral: true });
            }

            const weaponData = WEAPON_BY_TIER[weapon.tier];
            const needed     = weapon.maxDurability - weapon.currentDurability;

            let requestedAmt = interaction.options.getInteger('amount');
            if (!requestedAmt || requestedAmt > needed) requestedAmt = needed;
            // Round up to nearest 20
            requestedAmt = Math.ceil(requestedAmt / 20) * 20;

            const result = applyRepair(weapon, requestedAmt);

            if (result.error) {
                return interaction.reply({ content: result.error, ephemeral: true });
            }

            if (user.balance < result.cost) {
                return interaction.reply({
                    content: `Repair costs ${currency}${result.cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`,
                    ephemeral: true
                });
            }

            user.balance -= result.cost;
            user.markModified('hunt');
            await user.save();

            const statusIcon = weaponStatusEmoji(result.newStatus);
            const embed = new EmbedBuilder()
                .setColor(result.condemned ? '#e74c3c' : '#2ecc71')
                .setTitle('🔧 Weapon Repaired')
                .setDescription(`Your **${weapon.name}** has been repaired.`)
                .addFields(
                    { name: 'Durability Restored', value: `+${result.restoredAmount}`,                          inline: true },
                    { name: 'New Durability',       value: `${weapon.currentDurability}/${weapon.maxDurability}`, inline: true },
                    { name: 'Weapon Status',        value: `${statusIcon} ${result.newStatus}`,                  inline: true },
                    { name: 'Repair Cost',          value: `${currency}${result.cost.toLocaleString()}`,         inline: true },
                    { name: 'New Balance',          value: `${currency}${user.balance.toLocaleString()}`,        inline: true },
                    { name: 'Repair Count',         value: `${weapon.repairCount} (max dur -10% per repair)`,   inline: true },
                    { name: 'Durability Bar', value: durabilityBar(weapon.currentDurability, weapon.maxDurability) + ` ${weapon.currentDurability}/${weapon.maxDurability}` }
                );

            if (result.condemned) {
                embed.addFields({ name: '⚠️ Condemned!', value: 'Max durability has dropped too low. This weapon **cannot be repaired again**. Consider replacing it.' });
            } else if (result.newStatus === 'degraded') {
                embed.addFields({ name: '⚠️ Degraded', value: `Max durability is below 50% of original. Performance is reduced.` });
            }

            embed.setFooter({ text: `Each shop repair permanently reduces max durability by 10% • Use repair kits (/huntrepair kit) to avoid degradation` });

            return interaction.reply({ embeds: [embed] });
        }
    }
};
