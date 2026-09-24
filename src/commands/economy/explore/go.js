'use strict';

// /explore go — set out on an expedition: run the roll, stage the narration,
// resolve any encounter, pay out, and record the trip.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const GrindProfile = require('../../../models/GrindProfile');
const { persistGrindIfNew } = require('../../../utils/grindProfile');
const { isVersionError } = require('../../../utils/versionRetry');
const { detachBalanceDelta, commitBalanceDelta } = require('../../../utils/balanceDelta');
const { gatherPayoutKey } = require('../../../utils/payoutKey');
const { creditEventCurrencyOrOwe } = require('../../../utils/creditOrOwe');
const { LIMITS, REGIONS, relicSlug } = require('../../../data/exploreData');
const { relicItemId, exploreRegionItemId } = require('../../../data/activityItems');
const { attachItemThumbnail } = require('../../../utils/itemImageHelper');
const {
    commitExpeditionRelic, applyStaminaRegen, applyDailyReset, msUntilNextStamina,
    resolveActiveRegion, executeExplore, applyExploreXpBonus, resolveEncounter,
    getEncounterStakes, addJournalEntry, randInt, resolveRoute,
} = require('../../../services/exploreService');
const { getTotalBonus, tryGrantRarePet } = require('../../../services/petService');
const { checkAndAward, announceAchievements } = require('../../../services/achievementService');
const { ensureQuests, onExplore, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../../services/questService');
const { recordMissionProgress } = require('../../../services/seasonMissionService');
const { applyXpGain, announceLevelUp } = require('../../../services/levelingService');
const {
    getEventXpMultiplier, getEventCoinMultiplier,
    hasActiveEvent, getEventCurrencyId,
} = require('../../../services/seasonalEventService');
const { buildCooldownEmbed } = require('../../../utils/cooldownEmbed');
const { logTransaction } = require('../../../utils/logTransaction');
const { logBigWin } = require('../../../utils/bigWinLogger');
const { addWeeklyChampionProgress, getWeeklyChampionLeader } = require('../../../utils/weeklyChampion');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS } = require('../../../data/featuredRotation');
const COLORS = require('../../../utils/embedColors');
const { ownedBy } = require('../../../utils/collectorOwner');
const { loadContext, regionGateError, EXPLORE_COLORS } = require('./shared');
const { buildResultEmbed, secretTeaser, summarizeResult } = require('./embeds');
const { attachResultActions, buildResultActions } = require('./actions');

// How long an encounter waits for a choice before resolving as "keep your
// distance".
const ENCOUNTER_WINDOW_MS = 20_000;

// The staged "Setting out" beat — the intro, a pause, then the find — earns its
// two seconds on a run with something to reveal. On the routine ones it was
// just a wait, hundreds of times over, so those go straight to the result.
function isStagedRun(result, { firstVisit, rerouted }) {
    return Boolean(result.pendingChoice)
        || result.type === 'secret'
        || firstVisit
        || Boolean(rerouted)
        || ['epic', 'legendary'].includes(result.treasureTier?.tier);
}

async function handleGo(interaction) {
    const ctx = await loadContext(interaction);
    if (!ctx) return;
    const { guildSettings, user, currency } = ctx;

    const e = user.exploration;

    // Regen, the daily rollover and the seeded defaults are all recomputed from
    // persisted anchors (staminaLastRegen, dailyWindowStart), so nothing is lost
    // by leaving them in memory until the expedition's own save. They are
    // deliberately NOT flushed here: saveGrind rewrites the whole `data` blob,
    // which would stomp a concurrent expedition's cooldown claim below.
    applyStaminaRegen(user);
    applyDailyReset(user);

    // A bare /explore go follows your active region — unless that region has
    // gone out of season or been switched off underneath you, in which case
    // resolveActiveRegion moves you somewhere you can actually walk.
    const explicitRegionId = interaction.options.getString('region');
    let region, rerouted = null;
    if (explicitRegionId) {
        region = REGIONS[explicitRegionId];
    } else {
        const resolved = resolveActiveRegion(user, guildSettings);
        region = resolved.region;
        if (resolved.switched) rerouted = resolved.from;
    }

    // The route is picked per trip — the slash option or a result button — and
    // otherwise follows the one taken last.
    const route = resolveRoute(interaction.options.getString('route') ?? e.lastRoute);

    const gateError = regionGateError(user, region, guildSettings);
    if (gateError) return interaction.reply({ content: gateError, flags: MessageFlags.Ephemeral });

    if (e.injuryUntil && Date.now() < e.injuryUntil.getTime()) {
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🤕 Patching Yourself Up',
                description: 'The last trap left a mark. The wilds will still be wild when you can walk straight.',
                color: EXPLORE_COLORS.TRAIL,
                nextAt: new Date(e.injuryUntil.getTime()),
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (e.lastExplore && Date.now() - e.lastExplore.getTime() < LIMITS.EXPLORE_COOLDOWN_MS) {
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🥾 Catching Your Breath',
                description: 'You just got back. Shake the dust off, check your boots for stowaways, then go again.',
                color: EXPLORE_COLORS.TRAIL,
                nextAt: new Date(e.lastExplore.getTime() + LIMITS.EXPLORE_COOLDOWN_MS),
                nextRewardPreview: secretTeaser(user, region, guildSettings, route),
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (e.stamina <= 0) {
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '😮‍💨 Out of Stamina',
                description: 'Even legends sleep. Your legs have unionized and their demands are reasonable.',
                color: EXPLORE_COLORS.TRAIL,
                nextAt: new Date(Date.now() + msUntilNextStamina(user)),
                nextRewardPreview: `Stamina regenerates 1 every ${Math.round(LIMITS.STAMINA_REGEN_MS / 60_000)} minutes.`,
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    // Atomically claim the cooldown slot now that all preflight checks have passed —
    // lastExplore is set the moment the expedition is actually accepted, not earlier,
    // so a failed precheck (region/injury/stamina) never burns the cooldown. The same
    // guard stops two concurrent /explore go calls from both slipping through.
    //
    // The claim targets GrindProfile, not User: exploration state lives in its own
    // collection (see src/models/User.js), so a User-level guard would match every
    // document on the missing `exploration` field and never reject anything.
    const exploreClaimNow = new Date();
    const exploreCooldownFloor = new Date(exploreClaimNow.getTime() - LIMITS.EXPLORE_COOLDOWN_MS);
    const priorLastExplore = e.lastExplore ?? null;
    await persistGrindIfNew(user, 'exploration');
    const exploreClaimQuery = { userId: interaction.user.id, guildId: interaction.guild.id, system: 'exploration' };
    const claimedExplore = await GrindProfile.findOneAndUpdate(
        {
            ...exploreClaimQuery,
            $or: [{ 'data.lastExplore': null }, { 'data.lastExplore': { $lte: exploreCooldownFloor } }],
        },
        { $set: { 'data.lastExplore': exploreClaimNow } },
        { new: true },
    );

    if (!claimedExplore) {
        // Losing the claim means another expedition already took the slot, so the
        // in-memory snapshot is stale — read the winning timestamp back so the
        // countdown reflects the expedition that actually happened. If that read
        // fails, fall back to now rather than the snapshot: reaching the claim at all
        // means the snapshot was already past the cooldown floor, so it would render
        // a countdown in the past and say they can set out again.
        const current = await GrindProfile.findOne(exploreClaimQuery).catch(() => null);
        const lastAt  = current?.data?.lastExplore ?? exploreClaimNow;
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🥾 Catching Your Breath',
                description: 'You just got back. Shake the dust off, check your boots for stowaways, then go again.',
                color: EXPLORE_COLORS.TRAIL,
                nextAt: new Date(new Date(lastAt).getTime() + LIMITS.EXPLORE_COOLDOWN_MS),
                nextRewardPreview: secretTeaser(user, region, guildSettings, route),
            })],
            flags: MessageFlags.Ephemeral,
        });
    }
    e.lastExplore = exploreClaimNow;

    // The claim is a real write now, so an expedition that dies before its result
    // is saved would otherwise cost the player a full cooldown for nothing. Hand
    // the slot back — but only while it is still ours, so a newer claim isn't undone.
    const releaseExploreClaim = () => GrindProfile.updateOne(
        { ...exploreClaimQuery, 'data.lastExplore': exploreClaimNow },
        { $set: { 'data.lastExplore': priorLastExplore } },
    ).catch(() => null);

    // Everything between here and the pre-encounter save can still fail, and until
    // that save lands the player has nothing to show for the cooldown they just
    // paid for. Hand the slot back on the way out unless the expedition committed.
    let exploreCommitted = false;

    // The expedition writes coins twice — once for the find, once after the (up
    // to 20s) encounter prompt — and `save()` writes `balance` as an absolute
    // `$set`. Both movements are collected as deltas against this baseline and
    // applied as atomic `$inc`s, so neither save can flatten coins spent
    // elsewhere in between. See src/utils/balanceDelta.js.
    let balanceBaseline = user.balance ?? 0;
    const balanceFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
    let payoutOwed = 0;

    try {

        // ── Run the expedition ────────────────────────────────────────────────────
        // Featured region: folded into the coin multiplier rather than added to
        // the payout afterwards, so the daily cap still governs the boosted haul
        // and the encounter prompt quotes the numbers the player will really see.
        // It rides the coin multiplier deliberately — getPenaltyMultiplier ignores
        // that, so a featured region pays more without costing more to fail in.
        const featuredRegion = getDailyFeatured(interaction.guild.id).region;
        const isFeatured = region.id === featuredRegion.id;
        const coinMultiplier = getEventCoinMultiplier(guildSettings)
            * (isFeatured ? 1 + FEATURED_PAYOUT_BONUS : 1);
        const result = executeExplore(user, region, guildSettings, { coinMultiplier, route: route.id });
        result.featured = isFeatured;
        const firstVisit = result.firstVisit;
        const wasEncounter = Boolean(result.pendingChoice);
        // What the first save below commits. If the second one fails, the
        // result is rendered from this rather than from XP that never landed.
        const committed = {
            xp: result.xp,
            explorerLevelUp: result.explorerLevelUp ? { ...result.explorerLevelUp } : undefined,
        };

        // Rare companions are found, not bought: a legendary treasure is the
        // only thing that turns the owl up. Rolled here, with the expedition,
        // so it rides the same save as the treasure that produced it. Rolling
        // it after the encounter instead would have left the owl riding the
        // *second* save, and a failure there loses a 4%-of-legendary drop whose
        // treasure has already been committed by the first.
        const rarePetDrop = result.treasureTier
            ? tryGrantRarePet(user, 'explore', result.treasureTier.tier)
            : null;
        if (rarePetDrop) user.markModified('pets');

        // Commit stamina spend + cooldown timestamp now, before the (up to 20s)
        // encounter prompt below. Once this lands the expedition is real, so the
        // cooldown slot is earned and must not be handed back on a later failure.
        const findDelta = detachBalanceDelta(user, balanceBaseline);
        // A recovered relic stays in the in-memory inventory — the encounter
        // stakes and the reply both read it — but must not ride the save:
        // `save()` writes the whole array as read at load, flattening any credit
        // that landed in between, so the relic is re-applied as an atomic upsert
        // right after (src/utils/inventoryGrant.js). A brand-new document
        // inserts its whole inventory in one piece, so there is nothing to
        // detach or re-apply there.
        const relicDetached = Boolean(result.relic) && !user.isNew;
        if (relicDetached) user.unmarkModified('inventory');
        try {
            await user.save();
            exploreCommitted = true;
            if (relicDetached) {
                const relicGrant = await commitExpeditionRelic(user, result.relic, interaction.id);
                if (!relicGrant.granted) result.relicOwed = relicGrant.owed ? 'owed' : 'lost';  // not in the bag — see commitExpeditionRelic (#873)
            }
            const paid = await commitBalanceDelta(User, balanceFilter, user, findDelta, {
                service: 'explore',
                jobName: 'findPayout',
                guildId: interaction.guild.id,
                payoutKey: gatherPayoutKey('explore', interaction.id, 'find'),
            });
            if (!paid.credited) payoutOwed += findDelta;
            // The credit moved the balance; the encounter's delta is measured
            // from here, not from what was read before the expedition ran.
            balanceBaseline = user.balance ?? 0;
        } catch (err) {
            // Nothing was saved, so give the cooldown slot back before telling them to retry.
            await releaseExploreClaim();
            if (isVersionError(err)) {
                return interaction.reply({ content: 'A simultaneous request tangled your expedition log. Try `/explore go` again.', flags: MessageFlags.Ephemeral });
            }
            console.error('[explore] pre-encounter save error:', err);
            return interaction.reply({ content: 'Something went wrong writing your expedition down. Try again.', flags: MessageFlags.Ephemeral });
        }

        // Staged narration: the setting-out beat, then the find. `show` sends the
        // first message and edits it after that, so the routine run that skips
        // the beat answers with the result directly.
        let replyMessage = null;
        const show = async payload => {
            if (replyMessage) return interaction.editReply(payload);
            const response = await interaction.reply({ ...payload, withResponse: true });
            replyMessage = response?.resource?.message ?? null;
            return replyMessage;
        };

        const staged = isStagedRun(result, { firstVisit, rerouted });
        if (staged) {
            const reroutedLine = rerouted
                ? `\n\n🧭 **${rerouted.emoji} ${rerouted.name}** is closed to you right now, so your compass reset to **${region.emoji} ${region.name}**. It'll wait.`
                : '';
            const featuredLine = isFeatured
                ? `\n\n🌟 **Featured region today** — everything here pays **+${Math.round(FEATURED_PAYOUT_BONUS * 100)}%** until the rotation turns over.`
                : '';
            await show({
                embeds: [new EmbedBuilder()
                    .setColor(region.color)
                    .setTitle(`${region.emoji} Setting out — ${region.name} · ${route.emoji} ${route.name}`)
                    .setDescription(`*${result.intro}*${reroutedLine}${featuredLine}`)
                    .setFooter({ text: region.tagline })],
            });
            await new Promise(r => setTimeout(r, 2000));
        }

        // ── Encounter choice ──────────────────────────────────────────────────────
        if (result.pendingChoice) {
            const enc = result.encounter;
            // Both options are priced out in the coins THIS player would see —
            // relic case, survey bonus, region depth and any event multiplier
            // already folded in. A choice between two pieces of flavour text is
            // not a decision, it's a coin toss with extra reading.
            const stakes = getEncounterStakes(user, region, guildSettings, result);
            const odds = Math.round(stakes.winChance * 100);
            const range = band => `${currency}${band.min.toLocaleString()}–${currency}${band.max.toLocaleString()}`;
            const encId = `explore_${interaction.id}`;
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`${encId}_approach`).setLabel(`🤝 Approach (${odds}%)`).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`${encId}_observe`).setLabel('🌿 Keep Your Distance').setStyle(ButtonStyle.Secondary),
            );
            // A lost encounter ends the streak as surely as a trap does, so the
            // prompt prices that in beside the coins.
            const streakLoss = stakes.streakAtRisk > 0 ? `, and ends your 🔥 ${stakes.streakAtRisk}-run streak` : '';
            const loreLine = stakes.loreBonus
                ? `\n\n📖 *You know ${region.name}'s story, and it knows you do — **+${Math.round(LIMITS.ENCOUNTER_LORE_BONUS * 100)}%** on the approach.*`
                : '';
            const msg = await show({
                embeds: [new EmbedBuilder()
                    .setColor(region.color)
                    .setTitle(`${enc.emoji} ${enc.name}`)
                    .setDescription(`*${enc.intro}*\n\n` + (stakes.capped
                        ? 'Approach it, or watch from a safe distance? The daily cap has already taken everything this can pay, so bold buys you nothing but the risk.'
                        : 'Approach it, or watch from a safe distance? Bold can pay better. Careful always pays.') + loreLine)
                    .addFields(
                        {
                            name: `🤝 Approach — ${odds}%`,
                            value: stakes.capped
                                ? `Win: **nothing** — the daily cap has your coins.\nLose: **−${range(stakes.loss)}**${streakLoss}, and it may leave a mark.`
                                : `Win: **+${range(stakes.win)}**\nLose: **−${range(stakes.loss)}**${streakLoss}, and it may leave a mark.`,
                            inline: true,
                        },
                        {
                            name: '🌿 Keep Your Distance',
                            value: stakes.capped
                                ? '**Nothing**, guaranteed — but nothing risked either.'
                                : `**+${range(stakes.safe)}**, guaranteed.\nNothing risked, nothing broken.`,
                            inline: true,
                        },
                    )
                    .setFooter({ text: `${ENCOUNTER_WINDOW_MS / 1000} seconds to decide. Hesitation counts as keeping your distance, which is honest of it.` })],
                components: [row],
            });
            const choice = await new Promise(resolve => {
                if (!msg) return resolve(null);
                const col = msg.createMessageComponentCollector({
                    filter: ownedBy(interaction.user.id, i => i.customId.startsWith(encId), "This isn't your expedition."),
                    time: ENCOUNTER_WINDOW_MS,
                    max: 1,
                });
                // Resolve before acknowledging. A click that lands after
                // Discord's three-second window makes deferUpdate throw, and
                // awaiting it first left this promise unresolved for good —
                // the collector had already ended on 'limit', so nothing else
                // would — which hung the expedition with the player's economy
                // lock held.
                col.on('collect', i => {
                    resolve(i.customId.endsWith('_approach') ? 'approach' : 'observe');
                    i.deferUpdate().catch(() => {});
                });
                col.on('end', (_, reason) => { if (reason !== 'limit') resolve(null); });
            });
            resolveEncounter(user, region, guildSettings, result, choice);
        }

        // ── Cross-system rewards ──────────────────────────────────────────────────
        // Seasonal event currency: a real handful in the seasonal region, loose
        // change anywhere else while an event runs. Only rolled here — it does
        // not ride the save below, which would write the whole `eventCurrency`
        // array as a snapshot `$set` (flattening an `/eventshop` spend that
        // landed in between) with no key to replay it. It is credited through
        // the keyed helper once the expedition is written (#873, pass 13).
        let eventDrop = null;
        const currencyId = getEventCurrencyId(guildSettings);
        if (currencyId && hasActiveEvent(guildSettings)) {
            const range = region.eventCurrency ?? { min: 1, max: 2 };
            const amount = randInt(range.min, range.max);
            eventDrop = { currencyId, amount, owed: null };
        }

        // Lantern Owl: +15% Explorer XP (only while its hunger holds). Applied
        // here rather than threaded through the eleven grantXp call sites, and
        // after the encounter has resolved, so it covers every XP the expedition
        // ended up granting — including the survey bonus and the encounter.
        applyExploreXpBonus(user, result, getTotalBonus(user.pets || [], 'explore_xp'));

        // Guild leveling XP mirrors half the explorer XP
        let mainXp = Math.floor((result.xp ?? 0) * 0.5 * getEventXpMultiplier(guildSettings));
        let leveledUp = false;
        if (mainXp > 0) {
            // Reassign from `gained` so the embed reports the XP actually credited
            // (applyXpGain folds in the Bird pet's xp_gain passive).
            ({ leveled: leveledUp, gained: mainXp } = applyXpGain(user, mainXp));
        }

        // Journal
        addJournalEntry(user, region.id, result.type, summarizeResult(result, currency));

        // Achievements (checked against the freshly mutated user doc)
        const newAchievements = await checkAndAward(user, guildSettings).catch(err => {
            console.error('[explore] checkAndAward error:', err);
            return [];
        });

        await ensureQuests(user, guildSettings);
        // Season pass daily missions count expeditions, the same way they count
        // hunts and casts. Recorded in memory — the save below carries it.
        recordMissionProgress(user, 'explore', 1, guildSettings);
        // Expedition quests count the trip; the coin quests count the haul. A
        // quiet walk still advances the first and rightly not the second.
        const trip = await onExplore(user, guildSettings);
        const questsDone = [...trip.completed], questsNear = [...trip.nearComplete];
        if (result.payout > 0) {
            const earn = await onEconomyEarn(user, guildSettings, result.payout);
            questsDone.push(...earn.completed);
            questsNear.push(...earn.nearComplete);
        }

        const encounterDelta = detachBalanceDelta(user, balanceBaseline);
        let unsaved = false;
        try {
            await user.save();
            const paid = await commitBalanceDelta(User, balanceFilter, user, encounterDelta, {
                service: 'explore',
                jobName: 'encounterPayout',
                guildId: interaction.guild.id,
                payoutKey: gatherPayoutKey('explore', interaction.id, 'encounter'),
            });
            if (!paid.credited) payoutOwed += encounterDelta;
        } catch (err) {
            if (!isVersionError(err)) console.error('[explore] save error:', err);
            const tangled = isVersionError(err) ? 'A simultaneous request tangled your expedition log. ' : '';
            // The find already landed with the first save — stamina, cooldown,
            // coins, Explorer XP and any relic. What this write carried was the
            // encounter's outcome and the bookkeeping around the run.
            if (wasEncounter) {
                // The encounter's coins ride this write, so none moved.
                await show({
                    content: `${tangled}Your nerve held, but your notes didn't: the meeting with **${result.encounter.name}** couldn't be written down, so nothing was won or lost on it. \`/explore go\` when you're ready.`,
                    embeds: [], components: [],
                });
                return { started: false };
            }
            // Anything else was a find that is already paid, and wiping it for
            // an error line hid a legendary haul the player had in fact banked.
            // Render it from what the first save committed and say what didn't.
            unsaved = true;
            result.xp = committed.xp;
            result.petXp = 0;
            result.explorerLevelUp = committed.explorerLevelUp;
            mainXp = 0;
            leveledUp = false;
            eventDrop = null;
            newAchievements.length = 0;
            questsDone.length = 0;
            questsNear.length = 0;
        }

        // After the save, so a run that fails to write pays no drop. Never
        // throws: a drop that will not land is recorded as owed, not raised.
        if (eventDrop) {
            const drop = await creditEventCurrencyOrOwe(balanceFilter, eventDrop.currencyId, eventDrop.amount, {
                payoutKey: gatherPayoutKey('explore', interaction.id, 'eventCurrency'),
                service:   'explore',
                jobName:   'eventCurrency',
            });
            if (!drop.credited) eventDrop.owed = drop.owed ? 'owed' : 'lost';
        }

        if (newAchievements.length) {
            announceAchievements(interaction.client, guildSettings, user, interaction.member, newAchievements)
                .catch(err => console.error('[explore] announceAchievements error:', err));
        }
        if (questsDone.length || questsNear.length) {
            notifyQuestComplete(guildSettings, interaction.member, questsDone, interaction.channel, user).catch(() => null);
            notifyQuestNearComplete(guildSettings, interaction.member, questsNear, interaction.channel).catch(() => null);
        }
        if (leveledUp) {
            announceLevelUp(user, guildSettings, interaction.member, interaction.guild, interaction.channel)
                .catch(err => console.error('[explore] announceLevelUp error:', err));
        }

        // Transaction audit log
        if (result.payout > 0) {
            logTransaction({ userId: user.userId, guildId: user.guildId, type: 'explore', amount: result.payout, balance: user.balance, note: `${region.name} · ${result.type}` });
        } else if (result.penalty > 0) {
            logTransaction({ userId: user.userId, guildId: user.guildId, type: 'explore', amount: -result.penalty, balance: user.balance, note: `${region.name} · ${result.type}` });
        }

        // Big-win feed for legendary treasure and secrets
        if (result.payout > 0 && (result.treasureTier?.tier === 'legendary' || result.type === 'secret')) {
            logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: result.payout, source: 'explore', details: result.secret?.name ?? `${region.name} legendary treasure` });
        }

        // Weekly champion race: coins recovered across the week, same shape as
        // the mining and hunting tallies. Only a paying run can compete —
        // a trap or a quiet walk has nothing to enter.
        if (result.payout > 0) {
            await addWeeklyChampionProgress({
                guildId:  interaction.guild.id,
                category: 'explore',
                userId:   interaction.user.id,
                username: interaction.user.username,
                value:    result.payout,
                details:  `${region.emoji} ${summarizeResult(result, currency)}`,
            }).catch(() => null);
        }
        const weeklyLeader = await getWeeklyChampionLeader(interaction.guild.id, 'explore').catch(() => null);

        // ── Result embed ──────────────────────────────────────────────────────────
        const embed = buildResultEmbed(result, region, user, {
            currency, eventDrop, mainXp, firstVisit, guildSettings, weeklyLeader, unsaved,
            intro: staged ? null : result.intro,
        });

        if (rarePetDrop) {
            embed.addFields({
                name: `${rarePetDrop.emoji} A Rare Companion Appears!`,
                value: `A **${rarePetDrop.name}** came down out of the canopy and followed you back. It joined your pets at full hunger.\n`
                     + `Passive: **+${rarePetDrop.bonusPct}% ${rarePetDrop.bonusType.replace(/_/g, ' ')}** · Favourite food: \`${rarePetDrop.favoriteMaterial}\`\n`
                     + `*Name it with \`/pet rename\` and keep it fed with \`/pet feed\`.*`,
                inline: false,
            });
        }

        if (eventDrop?.owed) {
            embed.addFields({
                name: '⚠️ Event Currency Not Yet Delivered',
                value: eventDrop.owed === 'owed'
                    ? "This expedition's event currency couldn't be delivered just now and has been recorded as owed — it'll arrive once the problem clears. Tell an admin if it doesn't."
                    : "This expedition's event currency couldn't be delivered and could not be recorded — please contact a server admin.",
            });
        }

        if (payoutOwed > 0) {
            embed.addFields({
                name: '⚠️ Payout Not Yet Credited',
                value: `The **${currency}${payoutOwed.toLocaleString()}** from this expedition could not be paid out just now and has been recorded as owed, so your wallet is short by that much until it lands. It will be applied once the problem clears; tell an admin if it does not.`,
            });
        }

        // Icon on the result: the recovered relic when there is one — the
        // collectible moment, the way /fish, /hunt and /mine thumbnail the catch
        // — otherwise the region itself. Bundle-only art, so this no-ops to the
        // emoji fallback until the icons are baked (src/utils/itemImageHelper.js).
        const thumbId = result.relic
            ? relicItemId(relicSlug(result.relic.itemId))
            : exploreRegionItemId(region.id);
        const thumbLabel = result.relic ? result.relic.itemId : region.name;
        const files = await attachItemThumbnail(embed, thumbId, interaction.guild.id, thumbLabel);

        const resultMessage = await show({ embeds: [embed], components: buildResultActions(result.route), files });
        attachResultActions(interaction, resultMessage, { regionId: region.id });

        // Server-wide whisper for secrets
        if (result.type === 'secret' && guildSettings?.exploration?.announceSecrets !== false) {
            const channelId = guildSettings?.economy?.announcementChannelId;
            const resolved = channelId ? interaction.guild.channels.cache.get(channelId) : null;
            const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
            announceChannel.send({
                embeds: [new EmbedBuilder()
                    .setColor(COLORS.PRIZE)
                    .setTitle('✨ A Secret Has Been Found')
                    .setDescription(
                        `<@${interaction.user.id}> just uncovered **${result.secret.name}** in ${region.emoji} **${region.name}**.\n\n` +
                        `*The map has fewer blank spaces tonight. The blank spaces are taking it personally.*`
                    )
                    .setTimestamp()],
            }).catch(err => console.error('[explore] secret announce error:', err));
        }
        return { started: true };
    } catch (err) {
        if (!exploreCommitted) await releaseExploreClaim();
        throw err;
    }
}

module.exports = {
    handleGo,
};
