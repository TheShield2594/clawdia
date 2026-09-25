'use strict';

const { EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { heartBar, getPetDisplay, effectiveBond, bondTierFor } = require('../../../services/petService');
const COLORS = require('../../../utils/embedColors');
const { ratingLeaderboard } = require('../../../services/petLadderService');

/** The pet ladder (#1185): rated pets by rating, this season. */
async function ratingBoard(interaction) {
    const { seasonId, seasonEndsAt, rows } = await ratingLeaderboard(interaction.guild.id);
    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map((e, i) => {
        const { emoji, titledName } = getPetDisplay(e.pet);
        return `${medals[i] ?? `${i + 1}.`} ${emoji} **${titledName}** — ${e.tier.icon} **${e.rating}** · ${e.wins}W / ${e.losses}L — <@${e.userId}>`;
    });
    const ends = seasonEndsAt ? ` · ends <t:${Math.floor(new Date(seasonEndsAt).getTime() / 1000)}:R>` : '';
    const embed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`🐾 Pet Ladder — ${seasonId}`)
        .setDescription(lines.length > 0
            ? `${lines.join('\n')}\n\n*Season ${seasonId}${ends}*`
            : '*No rated battles this season yet — `/pet battle opponent:@member rated:True` starts one.*')
        .setFooter({ text: 'Rated battles are level-matched • top three pets earn a season title' })
        .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
}

async function executeLeaderboard(interaction) {
    await interaction.deferReply();

    const sortType = interaction.options.getString('type') ?? 'bonds';
    if (sortType === 'rating') return ratingBoard(interaction);

    let sortStage, addFieldsStage, titleLabel, lineBuilder;
    let rerank = rows => rows;
    let poolSize = 10;

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
        // Default: bond. It used to be days since adoption, which ranked pets
        // by age (#1186); it is now the care-earned bond, oldest pet first on a
        // tie so a long-kept pet still edges out a new one at the same bond.
        addFieldsStage = { $addFields: { petBond: { $ifNull: ['$pets.bond', 0] } } };
        sortStage = { $sort: { petBond: -1, 'pets.adoptedAt': 1 } };
        titleLabel = 'Most Bonded Pets';
        lineBuilder = (e, rank) => {
            const { emoji, titledName } = getPetDisplay(e.pet);
            const potw = e.pet.potw ? ' 🌟' : '';
            return `${rank} ${emoji} **${titledName}**${potw} — ${heartBar(e.bond)} ${bondTierFor(e.bond).title} ${Math.floor(e.bond)} — <@${e.userId}>`;
        };
        // The stored bond does not yet include the hungry-time drain owed by a
        // player who has not run a pet command since; the embed shows the
        // decay-aware value and re-sorts on it, from a slightly wider pool.
        poolSize = 25;
        rerank = rows => rows
            .map(e => ({ ...e, bond: effectiveBond(e.pet) }))
            .sort((a, b) => b.bond - a.bond)
            .slice(0, 10);
    }

    const top = await User.aggregate([
        { $match: { guildId: interaction.guild.id, 'pets.0': { $exists: true } } },
        { $unwind: '$pets' },
        addFieldsStage,
        sortStage,
        { $limit: poolSize },
        { $project: { _id: 0, userId: 1, pet: '$pets', petBond: 1, petLevel: 1, petWins: 1, petLosses: 1 } },
    ]).then(rerank);

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
