'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { ZONES, ZONE_LIST } = require('../../data/huntData');
const { ensureHuntData } = require('../../services/huntService');

const ZONE_CHOICES = ZONE_LIST.map(z => ({ name: z.name, value: z.id }));

module.exports = {
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('huntzone')
        .setDescription('Manage your hunting zones')
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('View all zones and their unlock status'))
        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription('Switch your active hunting zone')
                .addStringOption(o =>
                    o.setName('zone')
                        .setDescription('Zone to switch to')
                        .setRequired(true)
                        .addChoices(...ZONE_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('unlock')
                .setDescription('Pay to unlock a new hunting zone')
                .addStringOption(o =>
                    o.setName('zone')
                        .setDescription('Zone to unlock')
                        .setRequired(true)
                        .addChoices(...ZONE_CHOICES))),

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

        // ── LIST ───────────────────────────────────────────────────────────
        if (sub === 'list') {
            const lines = ZONE_LIST.map(zone => {
                const unlocked = h.unlockedZones.includes(zone.id);
                const isActive = h.activeZone === zone.id;
                const tierStr  = Object.entries(zone.tierWeights)
                    .filter(([, w]) => w > 0)
                    .map(([t, w]) => `${t}: ${w}%`)
                    .join(' · ');

                const statusLine = unlocked
                    ? (isActive ? '✅ **ACTIVE**' : '✅ Unlocked')
                    : `🔒 Level ${zone.unlockLevel}${zone.unlockCost > 0 ? ` · ${currency}${zone.unlockCost.toLocaleString()}` : ' · Free'}`;

                const diffStr = zone.difficultyMod !== 0
                    ? ` · ${Math.round(zone.difficultyMod * 100)}% success`
                    : '';
                const payStr = zone.payoutBonus > 0
                    ? ` · +${Math.round(zone.payoutBonus * 100)}% payout`
                    : '';

                return `${zone.emoji} **${zone.name}** — ${statusLine}\n> ${zone.description}\n> Loot: ${tierStr}${diffStr}${payStr}`;
            });

            const embed = new EmbedBuilder()
                .setColor('#3498db')
                .setTitle('🗺️ Hunting Zones')
                .setDescription(lines.join('\n\n'))
                .setFooter({ text: `Active zone: ${ZONES[h.activeZone]?.name ?? 'Unknown'} • Your level: ${h.level}` });

            return interaction.reply({ embeds: [embed] });
        }

        // ── SET ────────────────────────────────────────────────────────────
        if (sub === 'set') {
            const zoneId = interaction.options.getString('zone');
            const zone   = ZONES[zoneId];

            if (!zone) {
                return interaction.reply({ content: 'Unknown zone.', ephemeral: true });
            }
            if (!h.unlockedZones.includes(zoneId)) {
                const costStr = zone.unlockCost > 0 ? ` for ${currency}${zone.unlockCost.toLocaleString()}` : '';
                return interaction.reply({
                    content: `**${zone.name}** is locked. Use \`/huntzone unlock ${zoneId}\`${costStr} to unlock it first.`,
                    ephemeral: true
                });
            }
            if (h.level < zone.unlockLevel) {
                return interaction.reply({
                    content: `You need Hunter Level **${zone.unlockLevel}** to hunt in **${zone.name}**. You're currently Level ${h.level}.`,
                    ephemeral: true
                });
            }
            if (h.activeZone === zoneId) {
                return interaction.reply({ content: `You're already hunting in **${zone.name}**.`, ephemeral: true });
            }

            const oldZone    = ZONES[h.activeZone];
            h.activeZone     = zoneId;
            user.markModified('hunt');
            await user.save();

            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle('🗺️ Zone Changed')
                .setDescription(`Switched from **${oldZone?.emoji} ${oldZone?.name}** → **${zone.emoji} ${zone.name}**`)
                .addFields(
                    { name: 'Difficulty',   value: zone.difficultyMod < 0 ? `${Math.round(zone.difficultyMod * 100)}% success` : 'No penalty', inline: true },
                    { name: 'Payout Bonus', value: zone.payoutBonus > 0 ? `+${Math.round(zone.payoutBonus * 100)}%` : 'Standard', inline: true }
                )
                .setFooter({ text: 'Your next /hunt will use this zone' });

            return interaction.reply({ embeds: [embed] });
        }

        // ── UNLOCK ─────────────────────────────────────────────────────────
        if (sub === 'unlock') {
            const zoneId = interaction.options.getString('zone');
            const zone   = ZONES[zoneId];

            if (!zone) {
                return interaction.reply({ content: 'Unknown zone.', ephemeral: true });
            }
            if (zone.defaultUnlocked || h.unlockedZones.includes(zoneId)) {
                return interaction.reply({ content: `**${zone.name}** is already unlocked.`, ephemeral: true });
            }
            if (h.level < zone.unlockLevel) {
                return interaction.reply({
                    content: `You need Hunter Level **${zone.unlockLevel}** to unlock **${zone.name}**. You're Level ${h.level}.`,
                    ephemeral: true
                });
            }
            if (user.balance < zone.unlockCost) {
                return interaction.reply({
                    content: `Unlocking **${zone.name}** costs ${currency}${zone.unlockCost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`,
                    ephemeral: true
                });
            }

            user.balance       -= zone.unlockCost;
            h.unlockedZones.push(zoneId);
            user.markModified('hunt');
            await user.save();

            const tierStr = Object.entries(zone.tierWeights)
                .filter(([, w]) => w > 0)
                .map(([t, w]) => `${t}: ${w}%`)
                .join(' · ');

            const embed = new EmbedBuilder()
                .setColor('#f39c12')
                .setTitle(`${zone.emoji} Zone Unlocked: ${zone.name}!`)
                .setDescription(zone.description)
                .addFields(
                    { name: 'Loot Table',   value: tierStr,                                            inline: false },
                    { name: 'Difficulty',   value: zone.difficultyMod < 0 ? `${Math.round(zone.difficultyMod * 100)}% success` : 'No penalty', inline: true },
                    { name: 'Payout Bonus', value: zone.payoutBonus > 0 ? `+${Math.round(zone.payoutBonus * 100)}%` : 'Standard', inline: true },
                    { name: 'Unlock Cost',  value: `${currency}${zone.unlockCost.toLocaleString()}`,   inline: true },
                    { name: 'New Balance',  value: `${currency}${user.balance.toLocaleString()}`,      inline: true }
                )
                .setFooter({ text: `Switch to it with /huntzone set ${zoneId}` });

            return interaction.reply({ embeds: [embed] });
        }
    }
};
