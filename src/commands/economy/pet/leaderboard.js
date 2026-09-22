'use strict';

const { EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { PET_DEFINITIONS, heartBar } = require('../../../services/petService');
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
            const def  = PET_DEFINITIONS[e.pet.petId];
            const name = e.pet.name || def?.name || e.pet.petId;
            const stage = e.pet.evolutionStage ?? 1;
            const stageEmoji = stage >= 3 ? '🌟' : stage >= 2 ? '✨' : '';
            return `${rank} ${def?.emoji ?? '🐾'} **${name}** ${stageEmoji} — Lv**${e.pet.level ?? 1}** — <@${e.userId}>`;
        };
    } else if (sortType === 'wins') {
        addFieldsStage = { $addFields: { petWins: '$pets.battleWins' } };
        sortStage = { $sort: { petWins: -1 } };
        titleLabel = 'Most Battle Wins';
        lineBuilder = (e, rank) => {
            const def  = PET_DEFINITIONS[e.pet.petId];
            const name = e.pet.name || def?.name || e.pet.petId;
            const wins   = e.pet.battleWins   ?? 0;
            const losses = e.pet.battleLosses ?? 0;
            return `${rank} ${def?.emoji ?? '🐾'} **${name}** — ⚔️ ${wins}W / ${losses}L — <@${e.userId}>`;
        };
    } else {
        // Default: bond days
        addFieldsStage = { $addFields: { bondDays: { $toInt: { $divide: [{ $subtract: [new Date(), '$pets.adoptedAt'] }, 86400000] } } } };
        sortStage = { $sort: { bondDays: -1 } };
        titleLabel = 'Most Bonded Pets';
        lineBuilder = (e, rank) => {
            const def  = PET_DEFINITIONS[e.pet.petId];
            const name = e.pet.name || def?.name || e.pet.petId;
            const potw = e.pet.potw ? ' 🌟' : '';
            return `${rank} ${def?.emoji ?? '🐾'} **${name}**${potw} — ${heartBar(e.bondDays)} ${e.bondDays}d — <@${e.userId}>`;
        };
    }

    const top = await User.aggregate([
        { $match: { guildId: interaction.guild.id, 'pets.0': { $exists: true } } },
        { $unwind: '$pets' },
        addFieldsStage,
        sortStage,
        { $limit: 10 },
        { $project: { _id: 0, userId: 1, pet: '$pets', bondDays: 1, petLevel: 1, petWins: 1 } },
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
