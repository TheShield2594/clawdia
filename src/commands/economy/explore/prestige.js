'use strict';

// /explore prestige — walk off the edge of the map: reset Explorer Level for a
// permanent bonus stack.
//
// Exploration was the only grind system with nothing behind its ceiling (#750).
// Explorer Level stopped at 30 and kept banking XP into a counter nothing read;
// the relic case capped at ten of twenty-five relics, so the back half of a
// completed collection was worth nothing but trade value. Ascending resets the
// level for a permanent bonus stack, and each rank widens the case — so the
// reason to prestige and the reason to finish the collection are the same one.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const GrindProfile = require('../../../models/GrindProfile');
const {
    EXPLORER_LEVELS, EXPLORER_PRESTIGE, PRESTIGE_BADGES, RELIC_LIST, REGION_LIST,
    MAX_EXPLORER_LEVEL, MAX_EXPLORER_PRESTIGE,
} = require('../../../data/exploreData');
const {
    canPrestige, getExplorerTitle, getRelicCollection, relicCapacityForBonus,
} = require('../../../services/exploreService');
const { progressBar } = require('../../../utils/progressBar');
const { loadContext, prestigeBonusLines } = require('./shared');

async function handlePrestige(interaction) {
    const ctx = await loadContext(interaction);
    if (!ctx) return;
    const { user } = ctx;

    const e     = user.exploration;
    const state = canPrestige(user);
    const rank  = state.rank;
    const badge = PRESTIGE_BADGES[Math.min(rank, PRESTIGE_BADGES.length - 1)] ?? '';

    if (state.reason === 'max_rank') {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#6a1b9a')
                .setTitle(`${badge} There Is No Further Edge`)
                .setDescription(
                    `You are a **P${rank}** explorer — the last rank the map has a name for.\n` +
                    `Whatever lies past this, I haven't charted it either.`
                )
                .addFields({ name: 'Your Standing Bonuses', value: prestigeBonusLines(EXPLORER_PRESTIGE[rank]).join('\n') || 'None' })
                .setTimestamp()],
        });
    }

    const nextRow   = EXPLORER_PRESTIGE[rank + 1];
    const nextBadge = PRESTIGE_BADGES[rank + 1] ?? '';

    if (state.reason === 'level_too_low') {
        const finalXp = EXPLORER_LEVELS[MAX_EXPLORER_LEVEL - 1].xpRequired;
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#2e7d32')
                .setTitle(`${badge} Explorer Prestige — P${rank}`)
                .setDescription(
                    `Reach **Explorer Level ${MAX_EXPLORER_LEVEL}** to ascend to ${nextBadge} **P${rank + 1}**.\n` +
                    `You're Level **${e.level}**.`
                )
                .addFields(
                    { name: `${nextBadge} P${rank + 1} would grant`, value: prestigeBonusLines(nextRow, EXPLORER_PRESTIGE[rank]).join('\n') || 'Nothing new', inline: true },
                    { name: 'Progress', value: `${e.xp.toLocaleString()} / ${finalXp.toLocaleString()} XP\n${progressBar(e.xp, finalXp, 12)}`, inline: true },
                )
                .setFooter({ text: 'Prestige keeps your map, your surveys, your relics, your journal and every lifetime stat — only Explorer Level and XP reset.' })
                .setTimestamp()],
            flags: MessageFlags.Ephemeral,
        });
    }

    const confirmEmbed = new EmbedBuilder()
        .setColor('#6a1b9a')
        .setTitle(`${nextBadge} Walk Off The Edge — Ascend to P${rank + 1}?`)
        .setDescription(
            `You've reached **Explorer Level ${MAX_EXPLORER_LEVEL}**. Ascending is permanent and cannot be undone.\n\n` +
            `**Resets:** Explorer Level → 1, Explorer XP → 0\n` +
            `**Keeps:** every charted region, every survey, your relic case, your journal and every lifetime stat`
        )
        .addFields({ name: `${nextBadge} P${rank + 1} bonuses`, value: prestigeBonusLines(nextRow, EXPLORER_PRESTIGE[rank]).join('\n') || 'Nothing new', inline: false });

    // Region access is gated on explorer level, so an ascension puts the deeper
    // regions back behind the ladder. Say so before the button, not after it.
    const relocked = REGION_LIST
        .filter(r => !r.seasonalEventId
            && e.unlockedRegions.includes(r.id)
            && r.unlockLevel > 1)
        .map(r => `${r.emoji} ${r.name} *(Lv.${r.unlockLevel})*`);
    if (relocked.length) {
        confirmEmbed.addFields({
            name: '⚠️ Behind the level gate again until you re-climb',
            value: relocked.join('\n'),
            inline: false,
        });
    }
    confirmEmbed.setFooter({ text: 'Confirmation expires in 30 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('exploreprestige_confirm').setLabel('Ascend').setStyle(ButtonStyle.Success).setEmoji('🧭'),
        new ButtonBuilder().setCustomId('exploreprestige_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const response  = await interaction.reply({ embeds: [confirmEmbed], components: [row], withResponse: true });
    const reply     = response.resource.message;
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    let actionPromise = null;
    collector.on('collect', btn => {
        // An emitter discards whatever a listener returns, so these replies are
        // floating promises: a failed one (an expired interaction token, a
        // deleted message) becomes an unhandled rejection rather than a logged
        // miss, and enough of those trip the process-level rejection guard.
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral })
                .catch(err => console.error('[explore prestige] foreign-user reply failed:', err));
        }

        if (btn.customId === 'exploreprestige_cancel') {
            collector.stop();
            return btn.update({ content: 'You stay on the map. For now.', embeds: [], components: [] })
                .catch(err => console.error('[explore prestige] cancel update failed:', err));
        }

        // Assigned before collector.stop(): stop() emits 'end' synchronously, so an
        // assignment after it would leave the handler below awaiting a null.
        actionPromise = (async () => {
            try {
                await btn.deferUpdate();

                // Nothing is written from the in-memory snapshot. It was read before
                // a 30-second window during which an expedition may have moved this
                // profile, and a save() would put all of that back. The ascension is
                // the conditional update alone.
                //
                // `data.prestige` is absent on profiles written before the field
                // existed, so a first ascension has to match that shape too —
                // ensureExploreData only defaults it in memory.
                const rankMatches = rank === 0
                    ? [{ 'data.prestige': 0 }, { 'data.prestige': { $exists: false } }, { 'data.prestige': null }]
                    : [{ 'data.prestige': rank }];

                // Conditional so a second confirmation cannot ascend twice: the level
                // requirement and the rank both have to still hold.
                const ascended = await GrindProfile.findOneAndUpdate(
                    {
                        userId: user.userId, guildId: user.guildId, system: 'exploration',
                        'data.level': { $gte: MAX_EXPLORER_LEVEL },
                        $or: rankMatches,
                    },
                    { $set: { 'data.prestige': rank + 1, 'data.level': 1, 'data.xp': 0 } },
                    { new: true }
                ).catch(err => { console.error('[explore prestige] ascend error:', err); return null; });

                if (!ascended) {
                    return interaction.editReply({
                        content: 'Your explorer changed while that confirmation was open — run `/explore prestige` again.',
                        embeds: [], components: [],
                    });
                }

                e.prestige = rank + 1;
                e.level    = 1;
                e.xp       = 0;

                const embed = new EmbedBuilder()
                    .setColor('#6a1b9a')
                    .setTitle(`${nextBadge} Prestige ${rank + 1} — ${getExplorerTitle(user)}`)
                    .setDescription(
                        `You walk back out through the doorstep you started at, and it doesn't look any smaller.\n` +
                        `The map kept everything. The ladder starts again, and you start it as a **P${rank + 1}**.`
                    )
                    .addFields(
                        { name: 'Permanent Bonuses', value: prestigeBonusLines(EXPLORER_PRESTIGE[rank + 1]).join('\n') || 'None', inline: false },
                        { name: 'Explorer Level',   value: `**${MAX_EXPLORER_LEVEL}** → **1**`, inline: true },
                        { name: 'Relic Case',       value: `holds **${relicCapacityForBonus(nextRow.relicCapBonus)}** of ${RELIC_LIST.length}`, inline: true },
                        { name: 'Kept',             value: `${e.regions.length} region record(s) · ${getRelicCollection(user).length} distinct relic(s)`, inline: true },
                    )
                    .setFooter({ text: rank + 1 >= MAX_EXPLORER_PRESTIGE
                        ? 'That is the last rank the map has a name for.'
                        : `Reach Explorer Level ${MAX_EXPLORER_LEVEL} again to ascend to P${rank + 2}.` })
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed], components: [] });
            } catch (err) {
                console.error('[explore prestige] error:', err);
                interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
            }
        })();

        collector.stop();
    });

    return new Promise(resolve => {
        collector.on('end', async () => {
            if (actionPromise) await actionPromise.catch(() => {});
            resolve();
        });
    });
}

module.exports = {
    handlePrestige,
};
