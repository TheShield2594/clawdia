'use strict';

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { PRESTIGE_BONUSES } = require('../../data/fishData');
const { ensureFishingData, getMaxStamina } = require('../../services/fishService');

const MAX_PRESTIGE = PRESTIGE_BONUSES.length - 1; // 5

const PRESTIGE_LABELS = [
    null,
    '🥉 Bronze Angler',
    '🥈 Silver Angler',
    '🥇 Gold Angler',
    '🏆 Champion Angler',
    '💎 Diamond Angler'
];

function formatBonuses(bonus) {
    const lines = [];
    if (bonus.critBonus    > 0) lines.push(`+${Math.round(bonus.critBonus    * 100)}% crit chance`);
    if (bonus.staminaBonus > 0) lines.push(`+${bonus.staminaBonus} max stamina`);
    if (bonus.payoutBonus  > 0) lines.push(`+${Math.round(bonus.payoutBonus  * 100)}% all payouts`);
    if (bonus.rarityBonus  > 0) lines.push(`+${Math.round(bonus.rarityBonus  * 100)}% rarity boost`);
    return lines.length ? lines.join('\n') : 'None';
}

module.exports = {
    cooldown: 10,

    data: new SlashCommandBuilder()
        .setName('fishprestige')
        .setDescription('Reset your fisher level for permanent prestige bonuses (requires Level 50)'),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );
        ensureFishingData(user);
        const f = user.fishing;

        if (f.level < 50) {
            return interaction.reply({
                content: `You need Fisher Level **50** to prestige. You are currently Level **${f.level}**.`,
                ephemeral: true
            });
        }

        const currentPrestige = f.prestige ?? 0;
        if (currentPrestige >= MAX_PRESTIGE) {
            return interaction.reply({
                content: `You have already reached the maximum prestige (**P${MAX_PRESTIGE} — Diamond Angler**). You are a true legend of the sea! 💎`,
                ephemeral: true
            });
        }

        const nextPrestige   = currentPrestige + 1;
        const currentBonuses = PRESTIGE_BONUSES[currentPrestige];
        const nextBonuses    = PRESTIGE_BONUSES[nextPrestige];

        const confirmEmbed = new EmbedBuilder()
            .setColor('#f39c12')
            .setTitle('⚠️ Fishing Prestige Confirmation')
            .setDescription(
                `You are about to prestige from **P${currentPrestige}** → **P${nextPrestige}** (${PRESTIGE_LABELS[nextPrestige]}).\n\n` +
                `**Your fisher level and XP will reset to 1.**\n` +
                `Rods, bait, materials, balance, location unlocks, and trophies are all kept.`
            )
            .addFields(
                { name: `Current Bonuses (P${currentPrestige})`, value: formatBonuses(currentBonuses), inline: true },
                { name: `New Bonuses (P${nextPrestige})`,        value: formatBonuses(nextBonuses),    inline: true }
            )
            .setFooter({ text: 'This action cannot be undone! You have 30 seconds to confirm.' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('fishprestige_confirm')
                .setLabel('Prestige Now!')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('fishprestige_cancel')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({ embeds: [confirmEmbed], components: [row] });

        const collector = interaction.channel.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id &&
                         ['fishprestige_confirm', 'fishprestige_cancel'].includes(i.customId),
            time:   30_000,
            max:    1
        });

        collector.on('collect', async i => {
            if (i.customId === 'fishprestige_cancel') {
                await i.update({ content: 'Prestige cancelled.', embeds: [], components: [] });
                return;
            }

            // Re-fetch for safety against concurrent requests
            const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            ensureFishingData(freshUser);
            const ff = freshUser.fishing;

            if (ff.level < 50 || (ff.prestige ?? 0) >= MAX_PRESTIGE) {
                await i.update({
                    content: 'Prestige conditions are no longer met (level changed, or already prestiged).',
                    embeds: [], components: []
                });
                return;
            }

            // Apply prestige reset — level and XP only; everything else preserved
            ff.prestige = (ff.prestige ?? 0) + 1;
            ff.level    = 1;
            ff.xp       = 0;

            // Award prestige trophy
            if (!Array.isArray(ff.trophies)) ff.trophies = [];
            const trophy = PRESTIGE_LABELS[ff.prestige];
            if (trophy && !ff.trophies.includes(trophy)) {
                ff.trophies.push(trophy);
            }

            freshUser.markModified('fishing');

            try {
                await freshUser.save();
            } catch (err) {
                console.error('[fishprestige] save error:', err);
                await i.update({ content: 'Something went wrong saving your prestige. Please try again.', embeds: [], components: [] });
                return;
            }

            const resultEmbed = new EmbedBuilder()
                .setColor('#f39c12')
                .setTitle(`✨ Fishing Prestige ${ff.prestige} Achieved!`)
                .setDescription(
                    `You are now **${PRESTIGE_LABELS[ff.prestige]}**!\n\n` +
                    `Your fisher level has been reset to **1**. Prove yourself again from the water's edge.`
                )
                .addFields(
                    { name: 'Prestige Bonuses', value: formatBonuses(PRESTIGE_BONUSES[ff.prestige]), inline: false },
                    { name: '🏆 Trophy Earned', value: trophy,                                        inline: true  },
                    { name: '⚡ Max Stamina',   value: `${getMaxStamina(freshUser)}`,                 inline: true  }
                )
                .setFooter({ text: 'Use /fishprofile to see your updated stats' })
                .setTimestamp();

            await i.update({ embeds: [resultEmbed], components: [] });
        });

        collector.on('end', collected => {
            if (collected.size === 0) {
                interaction.editReply({ content: 'Prestige timed out. No changes were made.', embeds: [], components: [] })
                    .catch(() => {});
            }
        });
    }
};
