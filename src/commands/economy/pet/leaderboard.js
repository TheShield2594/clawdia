'use strict';

const { EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { heartBar, getPetDisplay } = require('../../../services/petService');
const COLORS = require('../../../utils/embedColors');

async function executeLeaderboard(interaction) {
    await interaction.deferReply();

    const sortType = interaction.options.getString('type') ?? 'bonds';

    let sortStage, addFieldsStage, titleLabel, lineBuilder;

    if (sortType === 'level') {
        addFieldsStage = { $addFields: { petLevel: '$pets.level' } };
        sortStage = { $sort: { petLevel: -1 } };
        titleLabel = 'Highest Level Pets';
        lineBuilder = (e, rank) => {
            const { emoji, titledName } = getPetDisplay(e.pet);
            // Stars for the stage, as the status card shows it. This used to be
            // 🌟 for an Apex pet, the same mark the footer uses for Pet of the Week.
            const stars = '⭐'.repeat(e.pet.evolutionStage ?? 1);
            return `${rank} ${emoji} **${titledName}** ${stars} — Lv**${e.pet.level ?? 1}** — <@${e.userId}>`;
        };
    } else if (sortType === 'wins') {
        // PvP only: wild wins are a count of time spent grinding, and anyone
        // can rack them up. Fewer losses breaks a tie in wins.
        addFieldsStage = { $addFields: { petWins: { $ifNull: ['$pets.pvpWins', 0] }, petLosses: { $ifNull: ['$pets.pvpLosses', 0] } } };
        sortStage = { $sort: { petWins: -1, petLosses: 1 } };
        titleLabel = 'Most PvP Wins';
        lineBuilder = (e, rank) => {
            const { emoji, titledName } = getPetDisplay(e.pet);
            return `${rank} ${emoji} **${titledName}** — ⚔️ ${e.pet.pvpWins ?? 0}W / ${e.pet.pvpLosses ?? 0}L vs members — <@${e.userId}>`;
        };
    } else {
        // Default: bond days
        addFieldsStage = { $addFields: { bondDays: { $toInt: { $divide: [{ $subtract: [new Date(), '$pets.adoptedAt'] }, 86400000] } } } };
        sortStage = { $sort: { bondDays: -1 } };
        titleLabel = 'Most Bonded Pets';
        lineBuilder = (e, rank) => {
            const { emoji, titledName } = getPetDisplay(e.pet);
            const potw = e.pet.potw ? ' 🌟' : '';
            return `${rank} ${emoji} **${titledName}**${potw} — ${heartBar(e.bondDays)} ${e.bondDays}d — <@${e.userId}>`;
        };
    }

    const top = await User.aggregate([
        { $match: { guildId: interaction.guild.id, 'pets.0': { $exists: true } } },
        { $unwind: '$pets' },
        addFieldsStage,
        sortStage,
        { $limit: 10 },
        { $project: { _id: 0, userId: 1, pet: '$pets', bondDays: 1, petLevel: 1, petWins: 1, petLosses: 1 } },
    ]);

    const medals = ['🥇', '🥈', '🥉'];
    const lines  = top.map((e, i) => lineBuilder(e, medals[i] ?? `${i + 1}.`));

    const embed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`🐾 Pet Leaderboard — ${titleLabel}`)
        .setDescription(lines.length > 0 ? lines.join('\n') : '*No pets in this server yet!*')
        .setFooter({ text: 'Pet of the Week is chosen weekly by most interactions • 🌟 = current POTW' })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

module.exports = { executeLeaderboard };
