'use strict';

// /fish tournament and /fish records — timed competitions and the standing
// world records they are measured against.

const {
    getActiveTournament,
    endTournament,
    announceTournamentEnd,
    buildWinnersEmbed,
    buildLeaderboardEmbed,
    startTournament
} = require('../../../services/tournamentService');
const { EmbedBuilder, MessageFlags } = require('discord.js');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const COLORS = require('../../../utils/embedColors');

// ═══════════════════════════════════════════════════════════════════════════════
// TOURNAMENT
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTournament(interaction, sub) {
    if (sub === 'status') return handleTournamentStatus(interaction);
    if (sub === 'start')  return handleTournamentStart(interaction);
}

async function handleTournamentStatus(interaction) {
    await interaction.deferReply();
    const tournament = await getActiveTournament(interaction.guild.id);
    if (!tournament) {
        return interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setColor(COLORS.NEUTRAL)
                    .setTitle('🎣 No Active Tournament')
                    .setDescription('There is no fishing tournament running right now.\n\nAdmins can start one with `/fish tournament start`.')
                    .setTimestamp()
            ]
        });
    }

    // Auto-end if expired
    if (new Date() > tournament.endsAt) {
        const ended = await endTournament(tournament._id);
        const guildSettings = await getGuildSettings(interaction.guild.id);
        const currency = guildSettings?.economy?.currency ?? '💰';
        const announceChannelId = ended.announceChannelId ?? guildSettings?.economy?.announcementChannelId ?? null;
        announceTournamentEnd(interaction.client, ended, interaction.guild.id, announceChannelId).catch(() => null);
        return interaction.editReply({ embeds: [buildWinnersEmbed(ended, currency)] });
    }

    return interaction.editReply({ embeds: [buildLeaderboardEmbed(tournament)] });
}

async function handleTournamentStart(interaction) {
    const member = interaction.guild.members.cache.get(interaction.user.id);
    if (!member?.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '❌ You need the **Manage Server** permission to start a tournament.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    const durationMins = interaction.options.getInteger('duration') ?? 60;
    const seedAmount   = interaction.options.getInteger('prize_pool') ?? 0;
    const entryFee     = interaction.options.getInteger('entry_fee') ?? 0;
    const guildSettings = await getGuildSettings(interaction.guild.id);
    const announceChannelId = guildSettings?.economy?.announcementChannelId ?? null;

    let tournament;
    try {
        tournament = await startTournament(interaction.guild.id, {
            durationMs: durationMins * 60_000,
            seedAmount,
            entryFee,
            announceChannelId
        });
    } catch (err) {
        return interaction.editReply({ content: `❌ ${err.message}` });
    }

    const currency = guildSettings?.economy?.currency ?? '💰';
    const announceEmbed = new EmbedBuilder()
        .setColor('#1e90ff')
        .setTitle('🎣 A Fishing Tournament Has Begun!')
        .setDescription(
            `**Duration:** ${durationMins} minutes\n` +
            `**Ends:** <t:${Math.floor(tournament.endsAt.getTime() / 1000)}:R>\n` +
            `**Goal:** Catch the highest-value single fish!\n` +
            (entryFee > 0 ? `**Entry Fee:** ${currency}${entryFee.toLocaleString()} (auto-deducted on first catch)\n` : `**Entry:** Free\n`) +
            (seedAmount > 0 ? `**Prize Pool:** ${currency}${seedAmount.toLocaleString()} to start\n` : '') +
            `\nUse \`/fish cast\` to participate. Use \`/fish tournament status\` to see the live leaderboard!\n\n` +
            `🐉 **Tip:** Boss encounters during the tournament give a score multiplier!`
        )
        .setTimestamp();

    // Announce in the announcement channel if configured
    if (announceChannelId) {
        const ch = interaction.guild.channels.cache.get(announceChannelId);
        if (ch?.isTextBased()) {
            ch.send({ embeds: [announceEmbed] }).catch(() => null);
        }
    }

    return interaction.editReply({ embeds: [announceEmbed] });
}

async function handleRecords(interaction) {
    await interaction.deferReply();

    const guildDoc = await getGuildSettings(interaction.guild.id).catch(() => null);
    const records  = (guildDoc?.fishingWorldRecords ?? [])
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 15);

    if (!records.length) {
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(COLORS.INFO)
                .setTitle('🐟 Server Fishing Records')
                .setDescription('No records yet — start fishing to claim the top spot!')
                .setTimestamp()]
        });
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines  = records.map((r, i) => {
        const medal = medals[i] ?? `**${i + 1}.**`;
        const date  = r.date ? `<t:${Math.floor(new Date(r.date).getTime() / 1000)}:d>` : '';
        return `${medal} **${r.fish}** — ${r.weight} lbs — <@${r.userId}>${date ? ` — ${date}` : ''}`;
    });

    return interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor('#1e90ff')
            .setTitle('🐟 Server Fishing Records')
            .setDescription(lines.join('\n'))
            .setFooter({ text: 'Heaviest catch per species · Records never reset' })
            .setTimestamp()]
    });
}

module.exports = {
    handleRecords,
    handleTournament,
    handleTournamentStart,
    handleTournamentStatus,
};
