'use strict';

// The boss fight a rare-or-better /fish cast can turn into: something big
// goes for the catch on its way up, and the angler fights it for three rounds of
// read-the-cue button choices fought over the revealed catch, then a bonus
// payout credited on its own atomic write. The base catch is already saved and
// shown by the time this runs; nothing here can take it back.

const { EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const {
    rollBossFight,
    scoreFightMove,
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
const { FIGHT_MOVES, BOSS_LINE_INTEGRITY } = require('../../../data/fishData');
const { awaitCasterClick, buildMoveRow, moveFromCustomId } = require('./shared');
const { renderFishResultCard } = require('./resultCard');
const { buildResultActions } = require('./actions');

const BOSS_COLOR    = '#B03A2E';
const BOSS_ROUND_MS = 15_000;
// A round the player let run out. Never the correct answer, and it costs the
// line like any wrong move — waiting a boss out is not a strategy.
const BOSS_TIMEOUT = 'timeout';

function roundIcon(p) {
    if (p.correct) return '✅';
    if (p.chosen === BOSS_TIMEOUT) return '⏱️';
    return '❌';
}

function integrityBar(integrity) {
    return '❤️'.repeat(integrity) + '🖤'.repeat(BOSS_LINE_INTEGRITY - integrity);
}

/**
 * Fights the boss over the revealed catch. `lead` is the picture card's embed
 * (empty when it could not be drawn) and `cardArgs` what drew it, so the card
 * can be redrawn with the fight's banner once it is over; `release` is the
 * catch's pending release, for the buttons the result ends on.
 */
async function runBossFight({ interaction, reelMsg, embed, lead = [], cardArgs = null, catchFiles, result, location, guildSettings, currency, release = null }) {
    const fight       = rollBossFight();
    const { boss: bossType, rounds } = fight;
    const roundCount  = rounds.length;
    const bossFish    = result.bossEncounter.fish;
    const choicesMade = [];
    const shown       = [];
    let integrity     = BOSS_LINE_INTEGRITY;

    const customIdFor = move => `boss_${interaction.id}_${move}`;
    const moveIds     = Object.keys(FIGHT_MOVES).map(customIdFor);

    const buildRoundEmbed = i => {
        const histLines = shown.map((p, n) => `Round ${n + 1}: ${roundIcon(p)}`).join('  ');
        const opening   = i === 0
            ? `*${bossType.intro} Your ${bossFish.emoji} **${bossFish.name}** is still on the hook — land them both.*\n\n`
            : '';
        return new EmbedBuilder()
            .setColor(BOSS_COLOR)
            .setTitle(`${bossType.emoji} ${bossType.name} — Round ${i + 1}/${roundCount}`)
            .setDescription(
                opening +
                `Line: ${integrityBar(integrity)}\n\n` +
                `> **${rounds[i].text}**\n\n` +
                (histLines ? `${histLines}\n\n` : '') +
                `**Read it. Answer it.** ⏱️ ${BOSS_ROUND_MS / 1000}s`
            )
            .setFooter({ text: `${bossType.description} • Bonus: 3/3 = 1.5× your catch's value | 2/3 = 1× | 1/3 = 0.4× | a snapped line = nothing` });
    };

    let timedOut = false;
    for (let i = 0; i < roundCount && integrity > 0; i++) {
        const pick = awaitCasterClick(reelMsg, interaction.user.id, moveIds);
        await interaction.editReply({ embeds: [...lead, embed, buildRoundEmbed(i)], components: [buildMoveRow(customIdFor)], files: catchFiles });
        pick.start(BOSS_ROUND_MS);
        const clicked = await pick.choice;
        const chosen  = clicked ? moveFromCustomId(clicked) : BOSS_TIMEOUT;
        const scored  = scoreFightMove(rounds[i], chosen);
        integrity = Math.max(0, integrity - scored.cost);
        choicesMade.push(chosen);
        shown.push({ chosen, correct: scored.correct });
        if (!clicked) { timedOut = true; break; }
    }

    // Resolve outcome
    const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
    await attachGrind(freshUser);
    ensureFishingData(freshUser);
    const bossResult = resolveBossEncounter(freshUser, bossFish, result.bossEncounter.tier, choicesMade, fight);

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
        return interaction.editReply({ embeds: [...lead, embed], components: buildResultActions(release), files: catchFiles, content: 'Something went wrong saving your boss result. Your catch above is safe; the boss bonus was not paid.' });
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

    const phaseScoreLine = bossResult.phaseResults.map((p, i) => `Round ${i + 1}: ${roundIcon(p)}`).join('  ');

    const outcomeColors = { perfect: '#FFD700', win: '#2ecc71', survived: '#3498db', escaped: COLORS.NEUTRAL };
    const outcomeTitles = {
        perfect:  `🏆 ${bossFish.emoji} PERFECT — ${bossType.name} Mastered!`,
        win:      `✅ ${bossFish.emoji} ${bossType.name} Subdued`,
        survived: `😓 ${bossFish.emoji} Barely Survived`,
        escaped:  `💀 ${bossFish.emoji} ${bossType.name} Escaped!`
    };

    const timeoutNote = timedOut
        ? `⏱️ *You hesitated — the ${bossType.name} took its chance and ran.*\n\n`
        : '';
    const bossResultEmbed = new EmbedBuilder()
        .setColor(outcomeColors[bossResult.outcome] ?? '#95a5a6')
        .setTitle(outcomeTitles[bossResult.outcome] ?? '❓ Boss Result')
        .setDescription(`${phaseScoreLine}\n\n${timeoutNote}${bossResult.message}\n\n*The catch above is yours either way.*`)
        .addFields(
            { name: 'Score',        value: `${bossResult.correctCount}/${roundCount} read right`, inline: true },
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

    // The card, redrawn with the fight on it — the banner under the badges, as
    // /hunt's card carries an apex duel.
    let finalLead = lead, finalFiles = catchFiles;
    if (cardArgs) {
        const cardTitles = {
            perfect:  `${bossType.name} mastered`,
            win:      `${bossType.name} subdued`,
            survived: `Barely held the ${bossType.name}`,
            escaped:  bossResult.lineSnapped ? `${bossType.name} snapped the line` : `${bossType.name} shook free`,
        };
        const redrawn = await renderFishResultCard({
            ...cardArgs,
            apex: { label: 'Boss fight', outcome: bossResult.outcome, title: cardTitles[bossResult.outcome], payout: bossResult.bonusPayout },
        });
        if (redrawn) { finalLead = [redrawn.embed]; finalFiles = [redrawn.file]; }
    }

    await interaction.editReply({ embeds: [...finalLead, embed, bossResultEmbed], components: buildResultActions(release), files: finalFiles });
}

module.exports = { runBossFight, BOSS_TIMEOUT };
