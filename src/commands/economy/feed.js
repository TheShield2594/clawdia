'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const Guild  = require('../../models/Guild');
const BigWin = require('../../models/BigWin');

const SOURCE_LABELS = {
    hunt:         '🏹 Hunt',
    fish:         '🎣 Fish',
    mine:         '⛏️ Mine',
    casino_slots: '🎰 Slots',
    casino_crash: '💥 Crash',
    casino_keno:  '🎱 Keno',
    duel:         '⚔️ Duel',
};

function relativeTime(date) {
    const secs = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (secs < 60)   return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('feed')
        .setDescription('See the last 20 big wins in this server (50k+ coins or legendary drops).'),

    cooldown: 10,

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const currency = guildSettings?.economy?.currency ?? '💰';

        const wins = await BigWin.find({ guildId: interaction.guild.id })
            .sort({ createdAt: -1 })
            .limit(20)
            .lean();

        if (!wins.length) {
            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor('#888888')
                        .setTitle('📡 Big Win Feed')
                        .setDescription('No big wins recorded yet. Hit 50,000+ coins or land a Legendary to appear here!')
                ],
            });
        }

        const lines = wins.map((w, i) => {
            const src    = SOURCE_LABELS[w.source] ?? w.source;
            const detail = w.details ? ` — ${w.details}` : '';
            const time   = relativeTime(w.createdAt);
            return `**${i + 1}.** <@${w.userId}> · ${src}${detail}\n    ${currency}**${w.amount.toLocaleString()}** coins · _${time}_`;
        }).join('\n\n');

        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('📡 Big Win Feed')
            .setDescription(
                `The ${wins.length} most recent big wins on **${interaction.guild.name}**.\n` +
                `*(50k+ coins or Legendary drops)*\n\n` +
                lines
            )
            .setFooter({ text: 'Big wins are logged automatically. Cooldown: 10s.' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};
