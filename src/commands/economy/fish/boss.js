'use strict';

// The boss fight a rare-or-better /fish cast can turn into: three phases of
// read-the-fish button choices fought over the revealed catch, then a bonus
// payout credited on its own atomic write. The base catch is already saved and
// shown by the time this runs; nothing here can take it back.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../../../models/User');
const {
    rollBossType,
    ensureFishingData,
    resolveBossEncounter,
    applyPayoutModifiers,
} = require('../../../services/fishService');
const { ensureQuests, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../../services/questService');
const { submitCatch: submitTournamentCatch } = require('../../../services/tournamentService');
const { attachGrind } = require('../../../utils/grindProfile');
const { saveWithBalanceDelta } = require('../../../utils/balanceDelta');
const { gatherPayoutKey } = require('../../../utils/payoutKey');
const { logBigWin } = require('../../../utils/bigWinLogger');
const COLORS = require('../../../utils/embedColors');
const { awaitCasterClick } = require('./shared');

const BOSS_COLOR   = '#B03A2E';
const BOSS_PHASE_MS = 30_000;
const BOSS_IDS     = ['boss_match', 'boss_hold', 'boss_safe'];
const BOSS_ID_KEY  = { boss_match: 'match', boss_hold: 'hold', boss_safe: 'safe' };
// A phase the player let run out. Never the correct answer, so a timeout keeps
// the credit for phases already answered and earns none for the rest — waiting
// out a boss whose answer happens to be "slack" is not a winning strategy.
const BOSS_TIMEOUT = 'timeout';

function bossPhaseIcon(p) {
    if (p.correct) return '✅';
    if (p.chosen === 'safe') return '🛡️';
    if (p.chosen === BOSS_TIMEOUT) return '⏱️';
    return '❌';
}

async function runBossFight({ interaction, reelMsg, embed, catchFiles, result, location, guildSettings, currency }) {
    const bossType    = rollBossType();
    const phaseCount  = bossType.phases.length;
    const bossFish    = result.bossEncounter.fish;
    const choicesMade = [];
    const shown       = [];

    const buildBossPhaseEmbed = phaseIndex => {
        const phase     = bossType.phases[phaseIndex];
        const integrity = Math.max(0, 3 - shown.filter(p => !p.correct && p.chosen !== 'safe').length);
        const intBar    = '❤️'.repeat(integrity) + '🖤'.repeat(3 - integrity);
        const histLines = shown.map((p, i) => `Phase ${i + 1}: ${bossPhaseIcon(p)}`).join('  ');

        return new EmbedBuilder()
            .setColor(BOSS_COLOR)
            .setTitle(`${bossType.emoji} ${bossType.name} — Phase ${phaseIndex + 1}/${phaseCount}`)
            .setDescription(
                `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `  ${bossFish.emoji}  **${bossFish.name}**\n` +
                `  Line Integrity: ${intBar}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `${phase.hint}\n\n` +
                (histLines ? `${histLines}\n\n` : '') +
                `**Choose your response — NOW:**`
            )
            .setFooter({ text: `⏱️ ${BOSS_PHASE_MS / 1000}s per phase • Bonus: 3/3 = 1.5× the catch's value | 2/3 = 1× | 1/3 = 0.4× | 0/3 = nothing` });
    };

    const buildPhaseRow = phaseIndex => {
        const { choices } = bossType.phases[phaseIndex];
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('boss_match').setLabel(choices.match.label).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('boss_hold').setLabel(choices.hold.label).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('boss_safe').setLabel(choices.safe.label).setStyle(ButtonStyle.Secondary)
        );
    };

    let timedOut = false;
    for (let i = 0; i < phaseCount; i++) {
        const pick = awaitCasterClick(reelMsg, interaction.user.id, BOSS_IDS);
        await interaction.editReply({ embeds: [embed, buildBossPhaseEmbed(i)], components: [buildPhaseRow(i)], files: catchFiles });
        pick.start(BOSS_PHASE_MS);
        const clicked = await pick.choice;
        if (!clicked) {
            timedOut = true;
            while (choicesMade.length < phaseCount) choicesMade.push(BOSS_TIMEOUT);
            break;
        }
        const chosen = BOSS_ID_KEY[clicked];
        choicesMade.push(chosen);
        shown.push({ chosen, correct: chosen === bossType.phases[i].correct });
    }

    // Resolve outcome
    const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
    await attachGrind(freshUser);
    ensureFishingData(freshUser);
    const bossResult = resolveBossEncounter(freshUser, bossFish, result.bossEncounter.tier, choicesMade, bossType);

    // The reload above is already seconds old by the time the fight
    // resolves, and `save()` writes `balance` as an absolute `$set` — so
    // the bonus is applied as its own `$inc` and `balance` stays out of
    // the save, exactly as the cast itself does.
    const bossBalanceAtLoad = freshUser.balance ?? 0;

    let bossQuestsDone = [], bossQuestsNear = [];
    if (bossResult.bonusPayout > 0) {
        // The spot the cast was made at — not the saved active location, which a
        // `location:` option on the command does not change.
        const { adjustedPayout } = applyPayoutModifiers(freshUser, bossResult.bonusPayout, location);
        bossResult.bonusPayout = adjustedPayout;
        freshUser.balance                 += adjustedPayout;
        freshUser.fishing.totalEarned     += adjustedPayout;
        freshUser.fishing.dailyCoins      += adjustedPayout;
        if (adjustedPayout > freshUser.fishing.bestPayout) freshUser.fishing.bestPayout = adjustedPayout;

        await ensureQuests(freshUser, guildSettings);
        const earn = await onEconomyEarn(freshUser, guildSettings, adjustedPayout);
        bossQuestsDone = earn.completed;
        bossQuestsNear = earn.nearComplete;
    }
    freshUser.markModified('fishing');
    let bossPayoutOwed = 0;
    try {
        // Same contract as the cast's own payout: a credit that would not
        // land is recorded as owed, and has to be said out loud rather
        // than rendered as a bonus the player was paid.
        const bossPaid = await saveWithBalanceDelta(User, freshUser, bossBalanceAtLoad, {
            service: 'fish',
            jobName: 'bossBonusPayout',
            guildId: interaction.guild.id,
            payoutKey: gatherPayoutKey('fish', interaction.id, 'boss'),
        });
        if (!bossPaid.credited) bossPayoutOwed = bossResult.bonusPayout;
        if (bossQuestsDone.length || bossQuestsNear.length) {
            notifyQuestComplete(guildSettings, interaction.member, bossQuestsDone, interaction.channel, freshUser).catch(() => null);
            notifyQuestNearComplete(guildSettings, interaction.member, bossQuestsNear, interaction.channel).catch(() => null);
        }
    } catch (saveErr) {
        console.error('[fish boss] save error:', saveErr);
        return interaction.editReply({ embeds: [embed], components: [], files: catchFiles, content: 'Something went wrong saving your boss result. Your catch above is safe; the boss bonus was not paid.' });
    }

    if (bossResult.bonusPayout > 0) {
        const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
        if (bossResult.bonusPayout >= bigWinThreshold) {
            logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: bossResult.bonusPayout, source: 'fish', details: { itemName: bossFish.name, rarity: 'boss' }, client: interaction.client });
        }
        // Submit boss win to active tournament with multiplier bonus
        const tournamentScore = Math.round(bossResult.bonusPayout * (bossResult.tournamentMultiplier ?? 1));
        submitTournamentCatch(interaction.guild.id, {
            userId:    interaction.user.id,
            username:  interaction.user.username,
            fishName:  bossFish.name,
            fishEmoji: bossFish.emoji ?? '🐉',
            tier:      result.bossEncounter.tier,
            score:     tournamentScore,
            isBossKill: ['perfect', 'win'].includes(bossResult.outcome)
        }).catch(() => null);
    }

    const phaseScoreLine = bossResult.phaseResults.map((p, i) => `Phase ${i + 1}: ${bossPhaseIcon(p)}`).join('  ');

    const outcomeColors = { perfect: '#FFD700', win: '#2ecc71', survived: '#3498db', escaped: COLORS.NEUTRAL };
    const outcomeTitles = {
        perfect:  `🏆 ${bossFish.emoji} PERFECT — ${bossType.name} Mastered!`,
        win:      `✅ ${bossFish.emoji} ${bossType.name} Subdued`,
        survived: `😓 ${bossFish.emoji} Barely Survived`,
        escaped:  `💀 ${bossFish.emoji} ${bossType.name} Escaped!`
    };

    const timeoutNote = timedOut
        ? `⏱️ *You hesitated — the ${bossType.name} took the phases you didn't answer.*\n\n`
        : '';
    const bossResultEmbed = new EmbedBuilder()
        .setColor(outcomeColors[bossResult.outcome] ?? '#95a5a6')
        .setTitle(outcomeTitles[bossResult.outcome] ?? '❓ Boss Result')
        .setDescription(`${phaseScoreLine}\n\n${timeoutNote}${bossResult.message}\n\n*The catch above is yours either way.*`)
        .addFields(
            { name: 'Score',        value: `${bossResult.correctCount}/${phaseCount} correct`, inline: true },
            { name: 'Bonus Payout', value: bossResult.bonusPayout > 0 ? `${currency}${bossResult.bonusPayout.toLocaleString()}` : 'None', inline: true },
            { name: 'Rod Damage',   value: `-${bossResult.durabilityLost} durability`, inline: true }
        )
        .setTimestamp();

    const bossRod = freshUser.fishing.rods?.[freshUser.fishing.equippedRodIndex];
    if (bossRod?.status === 'broken') {
        bossResultEmbed.addFields({ name: '❌ Rod Broke!', value: `Your **${bossRod.name}** gave out in the fight. Use \`/fish shop repair\` before casting again.` });
    }

    if (bossPayoutOwed > 0) {
        bossResultEmbed.addFields({
            name: '⚠️ Payout Not Yet Credited',
            value: `The **${currency}${bossPayoutOwed.toLocaleString()}** bonus could not be paid out just now and has been recorded as owed — your balance does not include it yet. It will be applied once the problem clears; tell an admin if it does not.`,
        });
    }

    await interaction.editReply({ embeds: [embed, bossResultEmbed], components: [], files: catchFiles });
}

module.exports = { runBossFight, BOSS_TIMEOUT };
