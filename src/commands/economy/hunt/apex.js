'use strict';

// The apex duel: the multi-phase showdown a rare-or-better kill can trigger on
// /hunt start, from the first phase to the saved bonus and the final card.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../../../models/User');
const {
    rollApexType,
    apexNerveMax,
    apexNerveAfter,
    ensureHuntData,
    resolveApexEncounter,
    applyPayoutModifiers,
    recordBestPayout,
} = require('../../../services/huntService');
const { ensureQuests, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../../services/questService');
const { logBigWin } = require('../../../utils/bigWinLogger');
const { attachGrind } = require('../../../utils/grindProfile');
const { saveWithBalanceDelta } = require('../../../utils/balanceDelta');
const { gatherPayoutKey } = require('../../../utils/payoutKey');
const { ownedBy } = require('../../../utils/collectorOwner');
const { sceneAuthor, fitEmbeds } = require('./embeds');
const { buildResultActions, attachResultActions } = require('./actions');

// Per apex phase.
const APEX_PHASE_MS = 30_000;
// From this hunter level the apex tells are no longer bolded for you: the
// words that give the read away are still there, just not highlighted.
const APEX_PLAIN_HINT_LEVEL = 20;

const tsRel = date => `<t:${Math.floor(date.getTime() / 1000)}:R>`;

const APEX_KEYS = ['match', 'hold', 'safe'];
const APEX_ID = /^apex_(match|hold|safe)_(\d+)$/;

function apexOutcomeFeedback(last, nerveLost) {
    if (last.correct) return '✅ **Read it right.** It gives ground.';
    if (last.chosen === 'safe') return '🛡️ You gave ground — no harm done, no ground won.';
    return `💥 **Misread — it catches you. −${nerveLost} ❤️**`;
}

/**
 * The multi-phase showdown a rare-or-better kill can trigger. One collector
 * serves the whole duel and every press is acknowledged the moment it lands;
 * each render goes out on the command's own token. Phase buttons carry their
 * phase number, so a stale press on an earlier phase's buttons is ignored
 * rather than answering the current one.
 */
async function runApexDuel(interaction, { embed, catchFiles, result, user, zone, zoneId, weaponIndex, currency, guildSettings }) {
    const prey       = result.apexEncounter.animal;
    const apexType   = rollApexType(prey);
    const phaseCount = apexType.phases.length;
    const nerveMax   = apexNerveMax(user);
    const plainHints = (user.hunt.level ?? 1) >= APEX_PLAIN_HINT_LEVEL;
    const hintFor    = phase => plainHints ? phase.hint.replace(/\*\*/g, '') : phase.hint;

    const phaseEmbed = (i, results, feedback, deadline) => {
        const nerve = apexNerveAfter(results, user);
        const nerveBar = '❤️'.repeat(nerve) + '🖤'.repeat(nerveMax - nerve);
        const history = results.map((p, n) => `Phase ${n + 1}: ${p.correct ? '✅' : p.chosen === 'safe' ? '🛡️' : '❌'}`).join('  ');
        return new EmbedBuilder()
            .setColor('#3b1f04')
            .setAuthor(sceneAuthor(zone, interaction.user))
            .setTitle(`${apexType.emoji} ${apexType.name} — Phase ${i + 1}/${phaseCount}`)
            .setDescription([
                `Drawn by the kill, a **${apexType.name}** steps out to claim your ${prey.emoji} **${prey.name}**.`,
                `Nerve: ${nerveBar}`,
                feedback ? `\n${feedback}` : null,
                '',
                hintFor(apexType.phases[i]),
                history ? `\n${history}` : null,
                '',
                `**Choose your move** — ${tsRel(deadline)}`,
            ].filter(v => v !== null).join('\n'))
            .setFooter({ text: '3/3 reads = 1.5x bonus · 2/3 = 1x · 1/3 = 0.4x\nA misread costs 2 nerve — at 0 it escapes. Backing off is safe but never counts. Walking away counts as an escape.' });
    };

    const phaseRow = i => {
        const choices = apexType.phases[i].choices;
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`apex_match_${i}`).setLabel(choices.match.label).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`apex_hold_${i}`).setLabel(choices.hold.label).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`apex_safe_${i}`).setLabel(choices.safe.label).setStyle(ButtonStyle.Secondary),
        );
    };

    await interaction.editReply({
        embeds: fitEmbeds([embed, phaseEmbed(0, [], null, new Date(Date.now() + APEX_PHASE_MS))]),
        components: [phaseRow(0)],
        files: catchFiles,
    });
    const message = await interaction.fetchReply();

    const picks = new Map();
    let waiter = null;
    const collector = message.createMessageComponentCollector({
        filter: ownedBy(interaction.user.id, i => APEX_ID.test(i.customId), "This isn't your hunt."),
        time: phaseCount * APEX_PHASE_MS + 15_000,
    });
    collector.on('collect', i => {
        const [, key, idx] = APEX_ID.exec(i.customId);
        const phase = Number(idx);
        if (!picks.has(phase)) picks.set(phase, key);
        if (waiter?.phase === phase) waiter.settle(picks.get(phase));
        i.deferUpdate().catch(() => {});
    });
    collector.on('end', () => { waiter?.settle(null); });

    const awaitPick = phase => new Promise(resolve => {
        if (picks.has(phase)) return resolve(picks.get(phase));
        if (collector.ended) return resolve(null);
        const timer = setTimeout(() => waiter?.settle(null), APEX_PHASE_MS);
        waiter = {
            phase,
            settle: value => { clearTimeout(timer); waiter = null; resolve(value); },
        };
    });

    const choicesMade = [];
    const results = [];
    let forfeit = false;
    for (let i = 0; i < phaseCount; i++) {
        const pick = await awaitPick(i);
        if (!APEX_KEYS.includes(pick)) { forfeit = true; break; }

        const phase = apexType.phases[i];
        const nerveBefore = apexNerveAfter(results, user);
        choicesMade.push(pick);
        results.push({ correct: pick === phase.correct, chosen: pick, correctChoice: phase.correct });
        const nerveNow = apexNerveAfter(results, user);

        // A broken nerve ends the duel there — there is no point asking for a
        // read that can no longer change the outcome.
        if (nerveNow <= 0 || i === phaseCount - 1) break;

        await interaction.editReply({
            embeds: fitEmbeds([embed, phaseEmbed(i + 1, results, apexOutcomeFeedback(results.at(-1), nerveBefore - nerveNow), new Date(Date.now() + APEX_PHASE_MS))]),
            components: [phaseRow(i + 1)],
            files: catchFiles,
        });
    }
    collector.stop('done');
    // Off the message while the outcome is worked out, so a late press is not
    // left hanging on buttons with nothing behind them.
    const stripped = interaction.editReply({ components: [] }).catch(() => {});

    // Resolve outcome on a fresh user document
    const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
    await stripped;
    if (!freshUser) {
        console.error(`[hunt apex] user document vanished mid-encounter — user=${interaction.user.id} guild=${interaction.guild.id}`);
        return interaction.editReply({ content: 'Something went wrong resolving the encounter — your hunt rewards were already saved.', embeds: [embed], components: [], files: catchFiles }).catch(() => {});
    }
    await attachGrind(freshUser);
    ensureHuntData(freshUser);
    // The duel is priced off the kill that spawned it — crit, trophy
    // quality, streak and traits included — rather than a fresh roll of
    // the animal's base range (#744). Caps are still applied below.
    const apexResult = resolveApexEncounter(
        freshUser, prey, result.apexEncounter.tier,
        choicesMade, apexType, weaponIndex,
        { killPayout: result.apexEncounter.killPayout, forfeit },
    );

    // The reload above is already seconds old by the time the fight
    // resolves, and `save()` writes `balance` as an absolute `$set` — so
    // the bonus is applied as its own `$inc` and `balance` stays out of
    // the save, exactly as the hunt itself does.
    const apexBalanceAtLoad = freshUser.balance ?? 0;

    let apexQuestsDone = [], apexQuestsNear = [];
    if (apexResult.bonusPayout > 0) {
        // The zone the hunt was actually in — the `zone:` option can differ
        // from the hunter's active zone, and the duel belongs to the hunt.
        // It rides on the gathering charge the kill already spent rather than
        // burning a second one.
        const { adjustedPayout } = applyPayoutModifiers(freshUser, apexResult.bonusPayout, zone, {
            reuseGatheringYield: !!result.gatheringYield,
        });
        apexResult.bonusPayout = adjustedPayout;
        freshUser.balance          += adjustedPayout;
        freshUser.hunt.totalEarned += adjustedPayout;
        freshUser.hunt.dailyCoins  += adjustedPayout;
        recordBestPayout(freshUser.hunt, adjustedPayout, {
            animal: prey,
            tier:   result.apexEncounter.tier,
            zoneId,
        });

        await ensureQuests(freshUser, guildSettings);
        const earn = await onEconomyEarn(freshUser, guildSettings, adjustedPayout);
        apexQuestsDone = earn.completed;
        apexQuestsNear = earn.nearComplete;
    }
    freshUser.markModified('hunt');
    let apexPayoutOwed = 0;
    try {
        // Same contract as the hunt's own payout: a credit that would not
        // land is recorded as owed, and has to be said out loud rather
        // than rendered as a bonus the player was paid.
        const apexPaid = await saveWithBalanceDelta(User, freshUser, apexBalanceAtLoad, {
            service: 'hunt',
            jobName: 'apexBonusPayout',
            guildId: interaction.guild.id,
            payoutKey: gatherPayoutKey('hunt', interaction.id, 'apex'),
        });
        if (!apexPaid.credited) apexPayoutOwed = apexResult.bonusPayout;
    } catch (saveErr) {
        console.error('[hunt apex] save error:', saveErr);
        return interaction.editReply({ content: 'Something went wrong saving your apex result — the encounter is lost and cannot be retried. Your original hunt rewards were already saved.', embeds: [embed], components: [], files: catchFiles }).catch(() => {});
    }

    const phaseScoreLine = apexResult.phaseResults.map((p, i) => {
        const icon = p.correct ? '✅' : p.chosen === 'safe' ? '🛡️' : '❌';
        return `Phase ${i + 1}: ${icon}`;
    }).join('  ');

    const outcomeColors = { perfect: '#FFD700', win: '#2ecc71', survived: '#3498db', escaped: '#3b1f04' };
    const outcomeTitles = {
        perfect:  `🏆 ${apexType.emoji} PERFECT — ${apexType.name} Brought Down!`,
        win:      `✅ ${apexType.emoji} ${apexType.name} Defeated!`,
        survived: `😓 ${apexType.emoji} You Survived the ${apexType.name}`,
        escaped:  `💀 ${apexType.emoji} The ${apexType.name} Escaped`
    };
    const nerveBroke = !forfeit && apexNerveAfter(apexResult.phaseResults, freshUser) <= 0 && apexResult.phaseResults.length < phaseCount;

    const apexEmbed = new EmbedBuilder()
        .setColor(outcomeColors[apexResult.outcome])
        .setAuthor(sceneAuthor(zone, interaction.user))
        .setTitle(outcomeTitles[apexResult.outcome])
        .setDescription(
            `${apexResult.message}` +
            (nerveBroke ? `\n*Your nerve broke after ${apexResult.phaseResults.length} of ${phaseCount} phases.*` : '') +
            (phaseScoreLine ? `\n\n${phaseScoreLine}` : '') + '\n\n' +
            (apexResult.bonusPayout > 0
                ? `💰 Bonus trophy: **+${currency}${apexResult.bonusPayout.toLocaleString()}**`
                : '*No bonus this time — but you lived to tell the tale.*') +
            `\n🔧 Weapon wear: -${apexResult.durabilityLost} durability`
        )
        .setTimestamp();

    if (apexPayoutOwed > 0) {
        apexEmbed.addFields({
            name: '⚠️ Payout Not Yet Credited',
            value: `The **${currency}${apexPayoutOwed.toLocaleString()}** bonus could not be paid out just now and has been recorded as owed — your balance does not include it yet. It will be applied once the problem clears; tell an admin if it does not.`,
        });
    }

    const apexWeapon = freshUser.hunt.weapons[weaponIndex];
    await interaction.editReply({
        embeds: fitEmbeds([embed, apexEmbed]),
        components: apexWeapon ? buildResultActions(freshUser, apexWeapon, freshUser.hunt.quickHunt ?? false) : [],
        files: catchFiles,
    }).catch(() => {});

    if (apexQuestsDone.length || apexQuestsNear.length) {
        notifyQuestComplete(guildSettings, interaction.member, apexQuestsDone, interaction.channel, freshUser).catch(() => null);
        notifyQuestNearComplete(guildSettings, interaction.member, apexQuestsNear, interaction.channel).catch(() => null);
    }
    if (apexResult.bonusPayout > 0) {
        const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
        if (apexResult.bonusPayout >= bigWinThreshold) {
            logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: apexResult.bonusPayout, source: 'hunt', details: { itemName: prey.name, rarity: 'apex' }, client: interaction.client });
        }
    }
    if (apexWeapon) await attachResultActions(interaction, weaponIndex);
}

module.exports = {
    APEX_PHASE_MS,
    APEX_PLAIN_HINT_LEVEL,
    apexOutcomeFeedback,
    runApexDuel,
};
