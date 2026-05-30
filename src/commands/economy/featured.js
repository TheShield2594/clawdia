'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS, FEATURED_RARE_BONUS } = require('../../data/featuredRotation');
const { getTimeBand } = require('../../utils/timeBand');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('featured')
        .setDescription("Today's featured rotation — +25% payout and +10% rare chance on each highlighted option."),

    cooldown: 5,

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }

        const featured = getDailyFeatured(interaction.guild.id);
        const timeBand = getTimeBand();
        const payoutPct = Math.round(FEATURED_PAYOUT_BONUS * 100);
        const rarePct   = Math.round(FEATURED_RARE_BONUS * 100);

        const div = '━━━━━━━━━━━━━━━━━━━━━━━━━━';

        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle(`🌟 Today's Featured Rotation`)
            .setDescription(
                `Active until midnight UTC · **+${payoutPct}% payout** and **+${rarePct}% rare chance** on each featured pick.\n\n` +
                div + '\n' +
                `${featured.crime.emoji}  **Crime — ${featured.crime.displayName}**\n` +
                `> Use \`/crime\` — this job appears in the rotation with the featured buff.\n\n` +
                `${featured.huntZone.emoji}  **Hunt Zone — ${featured.huntZone.name}**\n` +
                `> Hunt here with \`/hunt start zone:${featured.huntZone.id}\` for the bonus.\n\n` +
                `${featured.fishSpot.emoji}  **Fishing Spot — ${featured.fishSpot.name}**\n` +
                `> Cast at this location with \`/fish cast location:${featured.fishSpot.id}\`.\n\n` +
                `${featured.mineDepth.emoji}  **Mine Depth — ${featured.mineDepth.name}**\n` +
                `> Dig here with \`/mine dig depth:${featured.mineDepth.id}\` for the bonus.\n` +
                div
            )
            .setFooter({ text: `${timeBand.emoji} ${timeBand.label} • Resets daily at midnight UTC` })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};
