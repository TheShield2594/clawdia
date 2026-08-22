'use strict';

// /hunt zone — where the player hunts, and switching between the zones they
// have unlocked.

const Guild = require('../../../models/Guild');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { ensureHuntData } = require('../../../services/huntService');
const { ZONE_LIST, ZONES } = require('../../../data/huntData');

// ═══════════════════════════════════════════════════════════════════════════════
// ZONE (was /huntzone)
// ═══════════════════════════════════════════════════════════════════════════════

async function executeZone(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureHuntData(user);
    const h = user.hunt;

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

            const diffStr = zone.difficultyMod !== 0 ? ` · ${Math.round(zone.difficultyMod * 100)}% success` : '';
            const payStr  = zone.payoutBonus > 0 ? ` · +${Math.round(zone.payoutBonus * 100)}% payout` : '';

            return `${zone.emoji} **${zone.name}** — ${statusLine}\n> ${zone.description}\n> Loot: ${tierStr}${diffStr}${payStr}`;
        });

        const embed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle('🗺️ Hunting Zones')
            .setDescription(lines.join('\n\n'))
            .setFooter({ text: `Unlock new zones with /hunt shop unlock • Active zone: ${ZONES[h.activeZone]?.name ?? 'Unknown'} • Your level: ${h.level}` });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'set') {
        const zoneId = interaction.options.getString('zone');
        const zone   = ZONES[zoneId];

        if (!zone) {
            return interaction.reply({ content: 'Unknown zone.', flags: MessageFlags.Ephemeral });
        }
        if (!h.unlockedZones.includes(zoneId)) {
            return interaction.reply({
                content: `**${zone.name}** is locked. Unlock it with \`/hunt shop unlock\`.`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (h.level < zone.unlockLevel) {
            return interaction.reply({
                content: `You need Hunter Level **${zone.unlockLevel}** to hunt in **${zone.name}**. You're currently Level ${h.level}.`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (h.activeZone === zoneId) {
            return interaction.reply({ content: `You're already hunting in **${zone.name}**.`, flags: MessageFlags.Ephemeral });
        }

        const oldZone = ZONES[h.activeZone];
        h.activeZone  = zoneId;
        user.markModified('hunt');
        await user.save();

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle('🗺️ Zone Changed')
                    .setDescription(`Switched from **${oldZone?.emoji} ${oldZone?.name}** → **${zone.emoji} ${zone.name}**`)
                    .addFields(
                        { name: 'Difficulty',   value: zone.difficultyMod < 0 ? `${Math.round(zone.difficultyMod * 100)}% success` : 'No penalty', inline: true },
                        { name: 'Payout Bonus', value: zone.payoutBonus > 0 ? `+${Math.round(zone.payoutBonus * 100)}%` : 'Standard',              inline: true }
                    )
                    .setFooter({ text: 'Your next /hunt start will use this zone' })
            ]
        });
    }
}

module.exports = {
    executeZone,
};
