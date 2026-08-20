'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const { attachGrind, persistGrindIfNew } = require('../../utils/grindProfile');
const { isVersionError } = require('../../utils/versionRetry');
const { detachBalanceDelta, commitBalanceDelta } = require('../../utils/balanceDelta');
const GrindProfile = require('../../models/GrindProfile');
const Guild = require('../../models/Guild');
const {
    LIMITS, EXPLORER_LEVELS, TIER_COLORS, REGIONS, REGION_LIST,
    RELIC_LIST, RELIC_RARITY_ORDER, TOTAL_CORE_RELICS,
    FOOTER_LINES, INJURY_LINES,
} = require('../../data/exploreData');
const { fitDescription, EMBED_LIMITS } = require('../../utils/embedFields');
const {
    ensureExploreData,
    applyStaminaRegen,
    applyDailyReset,
    msUntilNextStamina,
    getLevelData,
    xpToNextLevel,
    getRegionProgress,
    isRegionInSeason,
    isRegionEnabled,
    isRegionFullyCharted,
    resolveActiveRegion,
    getRelicCollection,
    getRelicBonus,
    getSecretOdds,
    executeExplore,
    resolveEncounter,
    getEncounterStakes,
    addJournalEntry,
    regionCompletion,
    renderMap,
    randomFrom,
    formatMs,
} = require('../../services/exploreService');
const { checkAndAward, announceAchievements } = require('../../services/achievementService');
const { ensureQuests, onExplore, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../services/questService');
const { recordMissionProgress } = require('../../services/seasonMissionService');
const { applyXpGain, announceLevelUp } = require('../../utils/applyXpGain');
const {
    getEventXpMultiplier, getEventCoinMultiplier,
    hasActiveEvent, getEventCurrencyId, addEventCurrency,
} = require('../../services/seasonalEventService');
const { SEASONAL_EVENTS } = require('../../data/seasonalEvents');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');
const { logTransaction } = require('../../utils/logTransaction');
const { logBigWin } = require('../../utils/bigWinLogger');
const { tryUpdateHourlyWinner, getCurrentHourlyLeader } = require('../../utils/hourlyWinner');
const { progressBar } = require('../../utils/progressBar');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS } = require('../../data/featuredRotation');

const REGION_CHOICES = REGION_LIST.map(r => ({
    name: `${r.emoji} ${r.name}${r.seasonalEventId ? ' (seasonal)' : ''}`,
    value: r.id,
}));

const EVENT_TYPE_EMOJI = {
    discovery: '🗿', lore: '📜', secret: '✨', treasure: '🪙',
    trap: '🪤', encounter: '👁️', quiet: '🌫️',
};

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('explore')
        .setDescription('World exploration: set out into the wilds, chart your map, and find what hides there.')
        .addSubcommand(sub =>
            sub.setName('go')
                .setDescription('Set out on an expedition. Uses 1 stamina. Cooldown: 60s.')
                .addStringOption(o =>
                    o.setName('region')
                        .setDescription('Region to explore (defaults to your active region)')
                        .setRequired(false)
                        .addChoices(...REGION_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('map')
                .setDescription("View your Explorer's Map — every region, landmark, and secret you've charted."))
        .addSubcommand(sub =>
            sub.setName('travel')
                .setDescription('Travel to a region (unlocking it first if needed) and make it your active region.')
                .addStringOption(o =>
                    o.setName('region')
                        .setDescription('Destination region')
                        .setRequired(true)
                        .addChoices(...REGION_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('regions')
                .setDescription('Browse every known region — requirements, season windows, and your progress.'))
        .addSubcommand(sub =>
            sub.setName('journal')
                .setDescription('Reread your expedition journal — your most recent finds, in order.'))
        .addSubcommand(sub =>
            sub.setName('relics')
                .setDescription('Open your relic case — everything the wilds let you keep, and what it earns you.')
                .addUserOption(o =>
                    o.setName('user')
                        .setDescription('Collector to inspect')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription("View your or another wanderer's explorer profile")
                .addUserOption(o =>
                    o.setName('user')
                        .setDescription('Explorer to inspect')
                        .setRequired(false))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'go')      return handleGo(interaction);
        if (sub === 'map')     return handleMap(interaction);
        if (sub === 'travel')  return handleTravel(interaction);
        if (sub === 'regions') return handleRegions(interaction);
        if (sub === 'journal') return handleJournal(interaction);
        if (sub === 'relics')  return handleRelics(interaction);
        if (sub === 'profile') return handleProfile(interaction);
    },

    // Exposed so sibling commands can render the same Explorer's Map
    handleMap,
};

// ─── Shared guards ────────────────────────────────────────────────────────────

// Returns the guild doc, or null after replying if exploration is switched off.
async function loadGuildOrReply(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        await interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        return null;
    }
    if (guildSettings?.exploration?.enabled === false) {
        await interaction.reply({ content: 'Exploration is switched off on this server. The wilds will wait — they\'re good at it.', flags: MessageFlags.Ephemeral });
        return null;
    }
    return guildSettings ?? {};
}

async function loadContext(interaction) {
    const guildSettings = await loadGuildOrReply(interaction);
    if (!guildSettings) return null;
    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureExploreData(user);
    return { guildSettings, user, currency: guildSettings?.economy?.currency ?? '💰' };
}

/**
 * Read-only loader for map/journal/relics/profile: honours the same enable
 * switches as the write paths, and loads whichever user is being inspected.
 */
async function loadReadContext(interaction, target = interaction.user) {
    const guildSettings = await loadGuildOrReply(interaction);
    if (!guildSettings) return null;
    const user = await User.findOne({ userId: target.id, guildId: interaction.guild.id });
    await attachGrind(user);
    return { guildSettings, user, currency: guildSettings?.economy?.currency ?? '💰' };
}

// Region gate shared by go/travel: returns an error string or null
function regionGateError(user, region, guildSettings) {
    const e = user.exploration;
    if (!region) {
        return 'I don\'t have that place on any map, and I have several maps.';
    }
    if (!isRegionEnabled(region, guildSettings)) {
        return `**${region.name}** is closed by decree of the server staff. Even the wilds answer to someone.`;
    }
    if (region.seasonalEventId && !isRegionInSeason(region, guildSettings)) {
        return `**${region.emoji} ${region.name}** is out of season. It will be back — that kind of place always comes back. Keep an eye on \`/event status\`.`;
    }
    if (!region.seasonalEventId && !e.unlockedRegions.includes(region.id)) {
        return `You haven't opened the way to **${region.emoji} ${region.name}** yet. Use \`/explore travel\` — it costs **${region.unlockCost.toLocaleString()}** coins and Explorer Level **${region.unlockLevel}**.`;
    }
    if (!region.seasonalEventId && e.level < region.unlockLevel) {
        return `**${region.emoji} ${region.name}** requires Explorer Level **${region.unlockLevel}**. The place isn't going anywhere. You should be, though — go level up.`;
    }
    return null;
}

// ─── GO ───────────────────────────────────────────────────────────────────────

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

    const gateError = regionGateError(user, region, guildSettings);
    if (gateError) return interaction.reply({ content: gateError, flags: MessageFlags.Ephemeral });

    if (e.injuryUntil && Date.now() < e.injuryUntil.getTime()) {
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🤕 Patching Yourself Up',
                description: 'The last trap left a mark. The wilds will still be wild when you can walk straight.',
                color: '#2e7d32',
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
                color: '#2e7d32',
                nextAt: new Date(e.lastExplore.getTime() + LIMITS.EXPLORE_COOLDOWN_MS),
                nextRewardPreview: secretTeaser(user, region, guildSettings),
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (e.stamina <= 0) {
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '😮‍💨 Out of Stamina',
                description: 'Even legends sleep. Your legs have unionized and their demands are reasonable.',
                color: '#2e7d32',
                nextAt: new Date(Date.now() + msUntilNextStamina(user)),
                nextRewardPreview: 'Stamina regenerates 1 every 5 minutes.',
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
                color: '#2e7d32',
                nextAt: new Date(new Date(lastAt).getTime() + LIMITS.EXPLORE_COOLDOWN_MS),
                nextRewardPreview: secretTeaser(user, region, guildSettings),
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
        const result = executeExplore(user, region, guildSettings, { coinMultiplier });
        result.featured = isFeatured;
        const firstVisit = result.firstVisit;

        // Commit stamina spend + cooldown timestamp now, before the (up to 20s)
        // encounter prompt below. Once this lands the expedition is real, so the
        // cooldown slot is earned and must not be handed back on a later failure.
        const findDelta = detachBalanceDelta(user, balanceBaseline);
        try {
            await user.save();
            exploreCommitted = true;
            const paid = await commitBalanceDelta(User, balanceFilter, user, findDelta, {
                service: 'explore',
                jobName: 'findPayout',
                guildId: interaction.guild.id,
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

        // Staged narration: the setting-out beat, then the find
        const delay = ms => new Promise(r => setTimeout(r, ms));
        const reroutedLine = rerouted
            ? `\n\n🧭 **${rerouted.emoji} ${rerouted.name}** is closed to you right now, so your compass reset to **${region.emoji} ${region.name}**. It'll wait.`
            : '';
        const featuredLine = isFeatured
            ? `\n\n🌟 **Featured region today** — everything here pays **+${Math.round(FEATURED_PAYOUT_BONUS * 100)}%** until the rotation turns over.`
            : '';
        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor(region.color)
                .setTitle(`${region.emoji} Setting out — ${region.name}`)
                .setDescription(`*${result.intro}*${reroutedLine}${featuredLine}`)
                .setFooter({ text: region.tagline })],
        });
        await delay(2000);

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
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(region.color)
                    .setTitle(`${enc.emoji} ${enc.name}`)
                    .setDescription(`*${enc.intro}*\n\n` + (stakes.capped
                        ? 'Approach it, or watch from a safe distance? The daily cap has already taken everything this can pay, so bold buys you nothing but the risk.'
                        : 'Approach it, or watch from a safe distance? Bold pays better. Careful always pays.'))
                    .addFields(
                        {
                            name: `🤝 Approach — ${odds}%`,
                            value: stakes.capped
                                ? `Win: **nothing** — the daily cap has your coins.\nLose: **−${range(stakes.loss)}**, and it may leave a mark.`
                                : `Win: **+${range(stakes.win)}**\nLose: **−${range(stakes.loss)}**, and it may leave a mark.`,
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
                    .setFooter({ text: '20 seconds to decide. Hesitation counts as keeping your distance, which is honest of it.' })],
                components: [row],
            });
            const msg = await interaction.fetchReply();
            const choice = await new Promise(resolve => {
                const col = msg.createMessageComponentCollector({
                    filter: i => i.user.id === interaction.user.id && i.customId.startsWith(encId),
                    time: 20_000,
                    max: 1,
                });
                col.on('collect', async i => { await i.deferUpdate(); resolve(i.customId.endsWith('_approach') ? 'approach' : 'observe'); });
                col.on('end', (_, reason) => { if (reason !== 'limit') resolve(null); });
            });
            resolveEncounter(user, region, guildSettings, result, choice);
        }

        // ── Cross-system rewards ──────────────────────────────────────────────────
        // Seasonal event currency: a real handful in the seasonal region, loose
        // change anywhere else while an event runs.
        let eventDrop = null;
        const currencyId = getEventCurrencyId(guildSettings);
        if (currencyId && hasActiveEvent(guildSettings)) {
            const range = region.eventCurrency ?? { min: 1, max: 2 };
            const amount = Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
            addEventCurrency(user, currencyId, amount);
            eventDrop = { currencyId, amount };
        }

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
        let questsDone = [...trip.completed], questsNear = [...trip.nearComplete];
        if (result.payout > 0) {
            const earn = await onEconomyEarn(user, guildSettings, result.payout);
            questsDone.push(...earn.completed);
            questsNear.push(...earn.nearComplete);
        }

        const encounterDelta = detachBalanceDelta(user, balanceBaseline);
        try {
            await user.save();
            const paid = await commitBalanceDelta(User, balanceFilter, user, encounterDelta, {
                service: 'explore',
                jobName: 'encounterPayout',
                guildId: interaction.guild.id,
            });
            if (!paid.credited) payoutOwed += encounterDelta;
        } catch (err) {
            if (isVersionError(err)) {
                return interaction.editReply({ content: 'A simultaneous request tangled your expedition log. Try `/explore go` again.', embeds: [], components: [] });
            }
            console.error('[explore] save error:', err);
            return interaction.editReply({ content: 'Something went wrong writing your expedition down. Try again.', embeds: [], components: [] });
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

        // Hourly micro-competition: richest expedition of the hour, same shape as
        // the biggest dig and the largest haul. Only a paying run can compete —
        // a trap or a quiet walk has nothing to enter.
        if (result.payout > 0) {
            await tryUpdateHourlyWinner({
                guildId:  interaction.guild.id,
                category: 'explore',
                userId:   interaction.user.id,
                username: interaction.user.username,
                value:    result.payout,
                details:  `${region.emoji} ${summarizeResult(result, currency)}`,
            }).catch(() => null);
        }
        const hourlyLeader = await getCurrentHourlyLeader(interaction.guild.id, 'explore').catch(() => null);

        // ── Result embed ──────────────────────────────────────────────────────────
        const embed = buildResultEmbed(result, region, user, currency, eventDrop, mainXp, firstVisit, guildSettings, hourlyLeader);

        if (payoutOwed > 0) {
            embed.addFields({
                name: '⚠️ Payout Not Yet Credited',
                value: `The **${currency}${payoutOwed.toLocaleString()}** from this expedition could not be paid out just now and has been recorded as owed, so your wallet is short by that much until it lands. It will be applied once the problem clears; tell an admin if it does not.`,
            });
        }

        await interaction.editReply({ embeds: [embed], components: [] });

        // Server-wide whisper for secrets
        if (result.type === 'secret' && guildSettings?.exploration?.announceSecrets !== false) {
            const channelId = guildSettings?.economy?.announcementChannelId;
            const resolved = channelId ? interaction.guild.channels.cache.get(channelId) : null;
            const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
            announceChannel.send({
                embeds: [new EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle('✨ A Secret Has Been Found')
                    .setDescription(
                        `<@${interaction.user.id}> just uncovered **${result.secret.name}** in ${region.emoji} **${region.name}**.\n\n` +
                        `*The map has fewer blank spaces tonight. The blank spaces are taking it personally.*`
                    )
                    .setTimestamp()],
            }).catch(err => console.error('[explore] secret announce error:', err));
        }
    } catch (err) {
        if (!exploreCommitted) await releaseExploreClaim();
        throw err;
    }
}

function summarizeResult(result, currency) {
    // Once the daily cap bites, payouts land at zero — say so rather than
    // logging a triumphant haul of nothing.
    const haul = result.payout > 0
        ? `${currency}${result.payout.toLocaleString()}`
        : result.cappedByDailyCap ? 'nothing the daily cap would let you keep' : `${currency}0`;

    switch (result.type) {
        case 'discovery': return `Charted ${result.landmark.name}`;
        case 'lore':      return `Recovered a lore fragment`;
        case 'secret':    return `Uncovered the secret: ${result.secret.name}`;
        case 'treasure':  return `${result.relic ? `Recovered ${result.relic.itemId} and ` : ''}hauled ${haul} in treasure`;
        case 'trap':      return `Sprang ${result.trap.name} (−${currency}${(result.penalty ?? 0).toLocaleString()})`;
        case 'encounter': return result.outcome === 'win'
            ? `Faced ${result.encounter.name} and came out ahead`
            : result.outcome === 'safe'
                ? `Watched ${result.encounter.name} from a respectful distance`
                : `Faced ${result.encounter.name} and paid the tuition`;
        default:          return 'A long, quiet walk';
    }
}

/**
 * "It's been N expeditions since your last secret" is only true while the
 * region still HAS a secret to give. Once it's fully uncovered, saying it is
 * a promise nothing can keep, so say something honest instead.
 */
function secretTeaser(user, region, guildSettings) {
    if (!region) return 'The map never fills itself in.';
    const odds = getSecretOdds(user, region, getRegionProgress(user, region.id), guildSettings);
    if (odds.exhausted) {
        return `${region.name} has nothing left to hide from you. Other maps still do.`;
    }
    if (odds.sinceSecret >= 10) {
        return `It's been ${odds.sinceSecret} expeditions since your last secret — the odds are up to ${(odds.chance * 100).toFixed(1)}% and still climbing.`;
    }
    return 'The map never fills itself in.';
}

/**
 * Where the player sits on the secret curve. Without it the pity system is
 * invisible and a dry run just looks like bad luck with no reason to believe
 * it lets up — the same reason hunt, fishing and mining grew a streak field.
 */
function buildSecretPityField(user, region, guildSettings) {
    const odds = getSecretOdds(user, region, getRegionProgress(user, region.id), guildSettings);
    if (odds.exhausted) return null;

    const barLen = 16;
    const ratio  = Math.min(1, odds.pity / LIMITS.SECRET_PITY_MAX);
    const bar    = '█'.repeat(Math.round(ratio * barLen)) + '░'.repeat(barLen - Math.round(ratio * barLen));
    const maxed  = odds.pity >= LIMITS.SECRET_PITY_MAX;
    const lift   = odds.chance / odds.baseChance;

    if (odds.pity <= 0) {
        return {
            name: `✨ Secret Odds — ${(odds.chance * 100).toFixed(1)}%`,
            value: `\`${bar}\`\nEvery expedition here without a secret nudges these odds up.`,
            inline: false,
        };
    }
    return {
        name: `✨ Something's Overdue — ${odds.sinceSecret} expeditions dry`,
        value: `\`${bar}\`\n**${(odds.chance * 100).toFixed(1)}% secret chance** next time out `
             + `— ×${lift.toFixed(2)} the base rate${maxed ? ' *(max)*' : ', climbing with every dry run'}.`,
        inline: false,
    };
}

function buildResultEmbed(result, region, user, currency, eventDrop, mainXp, firstVisit, guildSettings, hourlyLeader = null) {
    const e = user.exploration;
    // The "Setting out — <region>" embed is edited away by this one, so without
    // an author line the message a player scrolls back to never says where any
    // of this happened. The titles below are landmark and creature names; only
    // the embed colour hinted at the region, which is not something you can read.
    const embed = new EmbedBuilder()
        .setAuthor({ name: `${region.emoji} ${region.name}` })
        .setTimestamp();
    const lines = [];

    switch (result.type) {
        case 'discovery':
            embed.setColor(region.color).setTitle(`🗿 Landmark Charted — ${result.landmark.name}`);
            lines.push(`*${result.landmark.line}*`);
            break;
        case 'lore':
            embed.setColor('#b39ddb').setTitle('📜 Lore Fragment Recovered');
            lines.push(`*You find words someone meant to be found:*`, '', `> ${result.lore.text}`);
            break;
        case 'secret':
            embed.setColor('#FFD700').setTitle(`✨ SECRET UNCOVERED — ${result.secret.name}`);
            lines.push(`*${result.secret.reveal}*`);
            break;
        case 'treasure': {
            const tier = result.treasureTier;
            embed.setColor(TIER_COLORS[tier.tier] ?? region.color)
                .setTitle(`🪙 Treasure — ${tier.tier.charAt(0).toUpperCase() + tier.tier.slice(1)} ${tier.stars}`);
            lines.push(`*${result.treasureLine}*`);
            if (result.relic) {
                lines.push(
                    '',
                    `🏺 **Relic recovered: ${result.relic.itemId}**${result.relicIsNew ? ' — *new to your case*' : ''}`,
                    `> *${result.relic.lore}*`,
                    `> It's in your \`/inventory\` now, and in \`/explore relics\`, where it earns its keep.`,
                );
            }
            break;
        }
        case 'trap':
            embed.setColor('#b5651d').setTitle(`🪤 Trap — ${result.trap.name}`);
            lines.push(`*${result.trap.line}*`);
            if (result.injured) lines.push('', `🤕 *${randomFrom(INJURY_LINES)}* (10 min)`);
            break;
        case 'encounter': {
            const enc = result.encounter;
            if (result.outcome === 'win') {
                embed.setColor('#00CC55').setTitle(`${enc.emoji} ${enc.name} — Well Played`);
                lines.push(`*${enc.winLine}*`);
            } else if (result.outcome === 'safe') {
                embed.setColor(region.color).setTitle(`${enc.emoji} ${enc.name} — Watched From the Ferns`);
                lines.push(`*${enc.safeLine}*`);
            } else {
                embed.setColor('#CC4400').setTitle(`${enc.emoji} ${enc.name} — That Went Differently`);
                lines.push(`*${enc.loseLine}*`);
                if (result.injured) lines.push('', `🤕 *${randomFrom(INJURY_LINES)}* (10 min)`);
            }
            break;
        }
        default:
            embed.setColor('#78909c').setTitle('🌫️ A Quiet Expedition');
            lines.push(`*${result.quietLine}*`);
            break;
    }

    if (firstVisit) {
        lines.push('', `🗺️ **New region charted: ${region.emoji} ${region.name}** — it has a place on your map now. So do its blank spaces.`);
    }

    if (result.regionCompleted) {
        lines.push(
            '',
            `🏅 **${region.emoji} ${region.name} — fully surveyed.**`,
            `Every landmark, every fragment, every secret. There is nothing left in this region that you haven't stood in front of.`,
            `Everything it pays you from here carries a standing **+${Math.round(result.surveyBonus * 100)}%**. The map keeps its debts.`,
        );
    }

    embed.setDescription(lines.join('\n'));

    const gains = [];
    if (result.payout > 0) {
        gains.push(`+${currency}${result.payout.toLocaleString()}`);
    } else if (result.cappedByDailyCap && result.grossPayout > 0) {
        // Don't render a legendary haul with a blank coin line and no reason.
        gains.push(`~~+${currency}${result.grossPayout.toLocaleString()}~~ *(daily cap)*`);
    }
    if (result.payout > 0 && result.cappedByDailyCap) {
        gains.push(`*(trimmed from ${currency}${result.grossPayout.toLocaleString()} — daily cap)*`);
    }
    if (result.penalty > 0) gains.push(`−${currency}${result.penalty.toLocaleString()}`);
    if (result.xp > 0)      gains.push(`+${result.xp} Explorer XP`);
    if (mainXp > 0)         gains.push(`+${mainXp} XP`);
    if (eventDrop) {
        const def = Object.values(SEASONAL_EVENTS).find(s => s.currency?.id === eventDrop.currencyId);
        gains.push(`+${eventDrop.amount} ${def?.currency?.emoji ?? '🎟️'} ${def?.currency?.name ?? eventDrop.currencyId}`);
    }
    if (gains.length) embed.addFields({ name: '🎒 The Haul', value: gains.join('  ·  '), inline: false });

    // Crossing an explorer level is the only thing that opens new regions, so it
    // gets said out loud — and if the new level actually put one within reach,
    // it gets named. Seasonal regions are left out: the calendar gates those,
    // not the level, so promising one here would be a promise about the weather.
    if (result.explorerLevelUp) {
        const lift = result.explorerLevelUp;
        const liftLines = [`Explorer Level **${lift.oldLevel}** → **${lift.newLevel}** — *${lift.newTitle}*`];
        const opened = REGION_LIST.filter(r =>
            !r.seasonalEventId
            && isRegionEnabled(r, guildSettings)
            && r.unlockLevel > lift.oldLevel
            && r.unlockLevel <= lift.newLevel);
        for (const opening of opened) {
            liftLines.push(
                `🔓 **${opening.emoji} ${opening.name}** is within reach — `
                + `\`/explore travel\` opens the route for ${currency}${opening.unlockCost.toLocaleString()}.`
            );
        }
        embed.addFields({ name: '⬆️ Level Up!', value: liftLines.join('\n'), inline: false });
    }

    if (result.hardCapped) {
        embed.addFields({
            name: '🧾 Daily Cap Reached',
            value: `You've banked ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()} from exploring in the last 24 hours, which is where the coins stop. `
                 + `Expeditions still chart the map and still pay Explorer XP — the wilds just stop paying cash until the window rolls over.`,
            inline: false,
        });
    } else if (result.softCapped) {
        embed.addFields({
            name: '🧾 Past the Soft Cap',
            value: `You're over ${currency}${LIMITS.DAILY_SOFT_CAP.toLocaleString()} for the last 24 hours, so hauls settle at `
                 + `**${Math.round(LIMITS.DAILY_SOFT_CAP_RATE * 100)}%** from here — down to ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()}, `
                 + `where they stop entirely. Charting and Explorer XP are untouched.`,
            inline: false,
        });
    }

    // Standing bonuses, shown once they're actually doing something
    const boosts = [];
    if (result.featured) boosts.push(`🌟 Featured region +${Math.round(FEATURED_PAYOUT_BONUS * 100)}%`);
    if (result.surveyed) boosts.push(`🏅 Fully surveyed +${Math.round(LIMITS.SURVEY_BONUS * 100)}%`);
    const relicBonus = getRelicBonus(user);
    if (relicBonus > 0) boosts.push(`🏺 Relic case +${Math.round(relicBonus * 100)}%`);
    if (boosts.length) {
        embed.addFields({ name: '📈 Standing Bonuses', value: boosts.join('  ·  '), inline: false });
    }

    // Pity curve — only on runs that didn't turn up the secret
    if (result.type !== 'secret') {
        const pityField = buildSecretPityField(user, region, guildSettings);
        if (pityField) embed.addFields(pityField);
    }

    const staminaNote = result.staminaSpared ? ' *(a blank walk costs no stamina)*' : '';
    const leaderNote = hourlyLeader
        ? `🏆 Richest this hour: ${hourlyLeader.username} — ${hourlyLeader.details ?? `${currency}${hourlyLeader.value.toLocaleString()}`}`
        : randomFrom(FOOTER_LINES);
    embed.setFooter({ text: `⚡ ${e.stamina}/${LIMITS.MAX_STAMINA} stamina${staminaNote} · ${nextExpeditionNote(user)} · ${leaderNote}` });
    return embed;
}

/**
 * When they can set out again — every other detail of the run is on the embed
 * except the one thing that decides what they do next. Whichever gate is further
 * out wins: an injury outlasts the cooldown by minutes, and quoting the cooldown
 * while a trap has them sitting down would be a lie with a countdown on it.
 */
function nextExpeditionNote(user) {
    const e = user.exploration;
    const now = Date.now();
    const cooldownLeft = e.lastExplore ? (e.lastExplore.getTime() + LIMITS.EXPLORE_COOLDOWN_MS) - now : 0;
    const injuryLeft   = e.injuryUntil ? e.injuryUntil.getTime() - now : 0;

    if (injuryLeft > cooldownLeft && injuryLeft > 0) return `🤕 walking again in ${formatMs(injuryLeft)}`;
    if (e.stamina <= 0) {
        const staminaLeft = msUntilNextStamina(user);
        if (staminaLeft > cooldownLeft) return `😮‍💨 stamina back in ${formatMs(staminaLeft)}`;
    }
    if (cooldownLeft > 0) return `🥾 ready in ${formatMs(cooldownLeft)}`;
    return '🥾 ready now';
}

// ─── MAP ──────────────────────────────────────────────────────────────────────

async function handleMap(interaction) {
    const ctx = await loadReadContext(interaction);
    if (!ctx) return;
    const { user: userData, guildSettings } = ctx;

    if (!userData?.exploration?.totalExpeditions) {
        return interaction.reply({
            content: 'Your map is a blank page with your name on it. Poetic, but useless. `/explore go` fixes that.',
            flags: MessageFlags.Ephemeral,
        });
    }

    ensureExploreData(userData);
    const e = userData.exploration;
    const lines = renderMap(userData, guildSettings);
    const levelData = getLevelData(e.level);

    const embed = new EmbedBuilder()
        .setColor('#2e7d32')
        .setTitle(`🗺️ The Explorer's Map — ${interaction.user.username}`)
        .setDescription(
            `*Every line on this map cost somebody shoe leather. These lines cost yours.*\n\n` +
            lines.join('\n\n')
        )
        .addFields({
            name: '🧭 The Tally',
            value: [
                `**${levelData.title}** — Explorer Lv ${e.level}`,
                `🗿 ${e.landmarksDiscovered} landmarks · 📜 ${e.loreCollected} lore · ✨ ${e.secretsFound} secrets · 🏺 ${e.relicsRecovered} relics`,
                `${e.totalExpeditions.toLocaleString()} expeditions logged · 🏅 ${surveyedCount(userData, guildSettings)} regions fully surveyed`,
            ].join('\n'),
            inline: false,
        })
        .setFooter({ text: 'The blank spaces aren\'t empty. They\'re waiting.' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// How many regions the player has charted end to end.
function surveyedCount(user, guildSettings) {
    return REGION_LIST.filter(region => {
        if (!isRegionEnabled(region, guildSettings)) return false;
        const progress = user.exploration.regions.find(r => r.regionId === region.id);
        return isRegionFullyCharted(region, progress);
    }).length;
}

// ─── TRAVEL ───────────────────────────────────────────────────────────────────

async function handleTravel(interaction) {
    const ctx = await loadContext(interaction);
    if (!ctx) return;
    const { guildSettings, user, currency } = ctx;
    const e = user.exploration;

    const region = REGIONS[interaction.options.getString('region')];
    if (!region) {
        return interaction.reply({ content: 'I don\'t have that place on any map, and I have several maps.', flags: MessageFlags.Ephemeral });
    }
    if (!isRegionEnabled(region, guildSettings)) {
        return interaction.reply({ content: `**${region.name}** is closed by decree of the server staff.`, flags: MessageFlags.Ephemeral });
    }
    if (region.seasonalEventId && !isRegionInSeason(region, guildSettings)) {
        return interaction.reply({ content: `**${region.emoji} ${region.name}** is out of season. It will return when the calendar does its part.`, flags: MessageFlags.Ephemeral });
    }

    let unlockLine = '';
    let unlockCharged = 0;
    if (!region.seasonalEventId && !e.unlockedRegions.includes(region.id)) {
        if (e.level < region.unlockLevel) {
            return interaction.reply({
                content: `The way to **${region.emoji} ${region.name}** needs Explorer Level **${region.unlockLevel}**. You're Level **${e.level}**. The road respects experience; go collect some.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        if (user.balance < region.unlockCost) {
            return interaction.reply({
                content: `Opening the route to **${region.emoji} ${region.name}** costs **${currency}${region.unlockCost.toLocaleString()}** — guides, bribes, one very specific key. You have ${currency}${user.balance.toLocaleString()}.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        // The toll is a conditional update, not `balance -= cost` followed by a
        // save: the balance read above goes stale the moment anything else pays
        // this player, and saving it back would erase that payout.
        const charged = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: region.unlockCost } },
            { $inc: { balance: -region.unlockCost } },
            { new: true, projection: { balance: 1 } },
        );
        if (!charged) {
            return interaction.reply({
                content: `Opening the route to **${region.emoji} ${region.name}** costs **${currency}${region.unlockCost.toLocaleString()}** — you no longer have enough. Check \`/balance\` and try again.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        // Take the authoritative balance and keep the save off that path.
        user.balance = charged.balance;
        user.unmarkModified('balance');
        unlockCharged = region.unlockCost;
        e.unlockedRegions.push(region.id);
        unlockLine = `\n\n🔓 Route opened for **${currency}${region.unlockCost.toLocaleString()}**. Money well buried.`;
    }

    e.activeRegion = region.id;
    user.markModified('exploration');
    try {
        await user.save();
    } catch (err) {
        console.error('[explore travel] save error:', err);
        let refunded = false;
        if (unlockCharged) {
            // The toll is already gone; hand it back rather than charging for a
            // route that was never opened.
            // A resolved promise is not proof the coins went back — an update
            // that matched nothing resolves just as happily. Only a matched
            // document means the toll actually returned.
            refunded = await User.updateOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: unlockCharged } },
            ).then(res => (res?.matchedCount ?? 0) > 0).catch(refundErr => {
                console.error('[explore travel] refund after failed save:', refundErr);
                return false;
            });
        }
        return interaction.reply({
            // Only promise the refund that actually landed. Saying "refunded"
            // when the refund itself threw sends the player away satisfied while
            // their coins are still gone.
            content: unlockCharged && !refunded
                ? `Something went wrong opening the route, and the **${currency}${unlockCharged.toLocaleString()}** taken could not be returned automatically. Tell an admin — it is recoverable.`
                : 'Something went wrong opening the route — any coins taken were refunded. Please try again.',
            flags: MessageFlags.Ephemeral,
        });
    }

    // Logged after the save, not before: the failure path above hands the toll
    // back, and a ledger entry written first would leave a debit the balance
    // never made. `user.balance` is already the authoritative post-charge value.
    if (unlockCharged) {
        logTransaction({ userId: user.userId, guildId: user.guildId, type: 'explore_unlock', amount: -unlockCharged, balance: user.balance, note: region.name });
    }

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(region.color)
            .setTitle(`${region.emoji} Now Exploring: ${region.name}`)
            .setDescription(`*${region.description}*${unlockLine}`)
            .setFooter({ text: region.tagline })],
    });
}

// ─── REGIONS ──────────────────────────────────────────────────────────────────

async function handleRegions(interaction) {
    const ctx = await loadContext(interaction);
    if (!ctx) return;
    const { guildSettings, user, currency } = ctx;
    const e = user.exploration;
    const todaysFeature = getDailyFeatured(interaction.guild.id).region;

    const sections = REGION_LIST
        .filter(r => isRegionEnabled(r, guildSettings))
        .map(region => {
            const progress = e.regions.find(r => r.regionId === region.id) ?? null;
            const pct = progress ? regionCompletion(region, progress) : 0;
            const active = e.activeRegion === region.id ? ' 🧭 *(active)*' : '';
            const star   = region.id === todaysFeature.id ? ' 🌟' : '';

            let status;
            if (region.seasonalEventId) {
                status = isRegionInSeason(region, guildSettings)
                    ? '🟢 **In season** — open to everyone, free entry, limited time'
                    : '⚪ Out of season — returns with its event';
            } else if (e.unlockedRegions.includes(region.id)) {
                status = e.level >= region.unlockLevel ? '🟢 Open to you' : `🟡 Unlocked, needs Explorer Lv ${region.unlockLevel}`;
            } else {
                status = `🔒 Explorer Lv ${region.unlockLevel} + ${currency}${region.unlockCost.toLocaleString()} via \`/explore travel\``;
            }

            return [
                `${region.emoji} **${region.name}**${active}${star} — *${region.tagline}*`,
                `> ${status}`,
                `> ${progress ? `${pct}% charted · ${progress.expeditions} expeditions` : 'Uncharted'}`,
            ].join('\n');
        });

    const embed = new EmbedBuilder()
        .setColor('#2e7d32')
        .setTitle('🧭 Known Regions')
        .setDescription(sections.join('\n\n'))
        .setFooter({ text: `🌟 ${todaysFeature.name} pays +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% today · seasonal regions come and go with /event seasons.` })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── JOURNAL ──────────────────────────────────────────────────────────────────

async function handleJournal(interaction) {
    const ctx = await loadReadContext(interaction);
    if (!ctx) return;
    const { user: userData } = ctx;

    const journal = userData?.exploration?.journal ?? [];
    if (!journal.length) {
        return interaction.reply({
            content: 'Your journal is empty. Every page is still possible. `/explore go` writes the first one.',
            flags: MessageFlags.Ephemeral,
        });
    }

    const lines = journal.slice(0, LIMITS.JOURNAL_CAP).map(entry => {
        const region = REGIONS[entry.regionId];
        const stamp = `<t:${Math.floor(new Date(entry.at).getTime() / 1000)}:R>`;
        return `${EVENT_TYPE_EMOJI[entry.eventType] ?? '🥾'} ${region?.emoji ?? ''} **${region?.name ?? entry.regionId}** — ${entry.summary} *(${stamp})*`;
    });

    const embed = new EmbedBuilder()
        .setColor('#8d6e63')
        .setTitle(`📔 Expedition Journal — ${interaction.user.username}`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `The last ${LIMITS.JOURNAL_CAP} entries are kept. The rest live in the retelling.` })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── RELICS ───────────────────────────────────────────────────────────────────

async function handleRelics(interaction) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const isSelf = target.id === interaction.user.id;

    const ctx = await loadReadContext(interaction, target);
    if (!ctx) return;
    const { user: userData, currency } = ctx;

    const collection = userData ? getRelicCollection(userData) : [];
    if (!collection.length) {
        return interaction.reply({
            content: isSelf
                ? 'Your relic case is a shelf and a hopeful expression. Rare treasure carries relics out of the wilds — `/explore go` is the only supplier.'
                : `${target.username} hasn't brought anything home worth a shelf yet.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    // Grouped by rarity, rarest first — the case should read like a case. Any
    // rarity not in the ladder still gets a group rather than silently vanishing
    // from a case whose totals already count it.
    const knownRarities = [...RELIC_RARITY_ORDER].reverse();
    const extraRarities = [...new Set(collection.map(r => r.rarity))].filter(r => !knownRarities.includes(r));

    const renderGroups = withLore => [...knownRarities, ...extraRarities].map(rarity => {
        const held = collection.filter(r => r.rarity === rarity);
        if (!held.length) return null;
        const rows = held.map(r => {
            const head = `${r.emoji} **${r.itemId}**${r.quantity > 1 ? ` ×${r.quantity}` : ''} — *${r.regionName}* · ${currency}${r.value.toLocaleString()}`;
            return withLore ? `${head}\n> *${r.lore}*` : head;
        });
        return `**${rarity.charAt(0).toUpperCase() + rarity.slice(1)}**\n${rows.join('\n')}`;
    }).filter(Boolean);

    // A full 25-relic case with lore runs past the 4096-char description limit,
    // and discord.js throws rather than truncating. Drop the lore before dropping
    // relics — the case is a list first and a story second.
    const budget = EMBED_LIMITS.DESCRIPTION - 120; // headroom for the omission note
    let groups = renderGroups(true);
    let loreDropped = false;
    if (groups.join('\n\n').length > budget) {
        groups = renderGroups(false);
        loreDropped = true;
    }
    const { text: caseText, omitted } = fitDescription(groups, { limit: budget, separator: '\n\n' });
    const caseNote = [
        loreDropped ? '*The case has outgrown its little plaques — names only from here.*' : '',
        omitted > 0 ? `*…and ${omitted} more group${omitted === 1 ? '' : 's'} that wouldn't fit.*` : '',
    ].filter(Boolean).join('\n');

    const distinct = collection.length;
    const missingField = buildMissingRelicsField(collection, isSelf, target.username);
    const bonus = getRelicBonus(userData);
    const atCap = bonus >= LIMITS.RELIC_BONUS_MAX;
    const caseValue = collection.reduce((sum, r) => sum + r.value * r.quantity, 0);

    const embed = new EmbedBuilder()
        .setColor('#c9a227')
        .setTitle(`🏺 The Relic Case — ${target.username}`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .setDescription(caseNote ? `${caseText}\n\n${caseNote}` : caseText)
        .addFields(
            {
                name: '📚 The Collection',
                value: `**${distinct}** distinct of **${RELIC_LIST.length}** known *(${TOTAL_CORE_RELICS} from the core regions, the rest only turn up in season)*\n`
                     + `Case value: **${currency}${caseValue.toLocaleString()}**`,
                inline: false,
            },
            ...(missingField ? [missingField] : []),
            {
                name: '📈 What It Earns You',
                value: `**+${Math.round(bonus * 100)}%** on every coin exploration pays you`
                     + (atCap
                         ? ' — *the case is as persuasive as it gets.*'
                         : `\n*+${Math.round(LIMITS.RELIC_BONUS_PER * 100)}% per distinct relic, up to +${Math.round(LIMITS.RELIC_BONUS_MAX * 100)}%. Duplicates are for trading, not for stacking.*`),
                inline: false,
            },
        )
        .setFooter({ text: 'Relics have no buyer — nothing out there is qualified. Trade them on the /market if someone disagrees.' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

/**
 * What the case is still missing. Rare treasure deliberately prefers relics the
 * player doesn't own yet, so "12 of 25" without naming the other 13 hides the
 * one number the drop table is actually built around. Returns null once there is
 * nothing left to want.
 *
 * Seasonal relics are listed apart from core ones: they only drop while their
 * event runs, so a checklist that mixed them in would read as thirteen things
 * you could go get today, and some of them are months away.
 */
function buildMissingRelicsField(collection, isSelf, username) {
    const owned = new Set(collection.map(r => r.itemId));
    const missing = RELIC_LIST.filter(r => !owned.has(r.itemId));
    if (!missing.length) {
        return {
            name: '🔍 Still Out There',
            value: isSelf
                ? '**Nothing.** Every relic the wilds have ever let go of is on that shelf. Including the ones that were statues when you picked them up.'
                : `**Nothing.** ${username} has the complete set.`,
            inline: false,
        };
    }

    const core     = missing.filter(r => !REGIONS[r.regionId].seasonalEventId);
    const seasonal = missing.filter(r =>  REGIONS[r.regionId].seasonalEventId);

    // A field value caps at 1024 characters and discord.js throws rather than
    // truncating, so the list gets trimmed to fit with a count of what it dropped.
    const BUDGET = 900;
    const render = list => list.map(r => `${REGIONS[r.regionId].emoji} ${r.itemId}`);
    const { text, omitted } = fitDescription(render(core), { limit: BUDGET, separator: ' · ' });

    const lines = [];
    if (core.length) {
        lines.push(text);
        if (omitted > 0) lines.push(`*…and ${omitted} more out in the core regions.*`);
    }
    if (seasonal.length) {
        lines.push(`*Plus ${seasonal.length} that only turn up while their season is running.*`);
    }

    return { name: `🔍 Still Out There — ${missing.length}`, value: lines.join('\n'), inline: false };
}

// ─── PROFILE ──────────────────────────────────────────────────────────────────

async function handleProfile(interaction) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const isSelf = target.id === interaction.user.id;

    const ctx = await loadReadContext(interaction, target);
    if (!ctx) return;
    const { user: userData, guildSettings, currency } = ctx;

    if (!userData?.exploration?.totalExpeditions) {
        return interaction.reply({
            content: isSelf
                ? 'You haven\'t set out yet. The wilds have noticed. `/explore go` settles the matter.'
                : `${target.username} hasn't set a single boot past the gate yet.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    ensureExploreData(userData);
    if (isSelf) applyStaminaRegen(userData);
    // Read-only, but the daily footer should reflect a window that has already
    // rolled over rather than yesterday's numbers.
    applyDailyReset(userData);

    const e = userData.exploration;
    const levelData = getLevelData(e.level);
    const toNext = xpToNextLevel(e.level, e.xp);
    const activeRegion = REGIONS[e.activeRegion];
    const nextThreshold = EXPLORER_LEVELS.find(l => l.level === e.level + 1)?.xpRequired;

    const stamBar = '⚡'.repeat(e.stamina) + '▪️'.repeat(Math.max(0, LIMITS.MAX_STAMINA - e.stamina));
    const regenMs = msUntilNextStamina(userData);

    const embed = new EmbedBuilder()
        .setColor(activeRegion?.color ?? '#2e7d32')
        .setTitle(`🧭 ${target.username}'s Explorer Profile`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
            {
                name: '🥾 Rank',
                value: `**${levelData.title}** (Level ${e.level})`,
                inline: true,
            },
            {
                name: '⭐ Explorer XP',
                value: toNext !== null
                    ? `${e.xp.toLocaleString()} / ${nextThreshold.toLocaleString()} XP\n${progressBar(e.xp, nextThreshold, 12)}\n${toNext.toLocaleString()} to Level ${e.level + 1}`
                    : `${e.xp.toLocaleString()} XP — **MAX LEVEL**`,
                inline: true,
            },
            {
                name: '🗺️ Active Region',
                value: activeRegion ? `${activeRegion.emoji} ${activeRegion.name}` : 'Unknown',
                inline: true,
            },
            {
                name: '⚡ Stamina',
                value: `${stamBar}\n${e.stamina}/${LIMITS.MAX_STAMINA}${e.stamina < LIMITS.MAX_STAMINA ? `\nNext regen: ${formatMs(regenMs)}` : '\nFull!'}`,
                inline: true,
            },
            {
                name: '💰 Balance',
                value: `${currency}${userData.balance.toLocaleString()}`,
                inline: true,
            },
            {
                name: '📊 Field Record',
                value: [
                    `Expeditions:     **${e.totalExpeditions.toLocaleString()}**`,
                    `Total Earned:    **${currency}${e.totalEarned.toLocaleString()}**`,
                    `Best Haul:       **${currency}${e.bestHaul.toLocaleString()}**`,
                    `Secrets Found:   **${e.secretsFound}**`,
                    `Relics:          **${e.relicsRecovered}**`,
                    `Regions Surveyed:**${surveyedCount(userData, guildSettings)}**`,
                    `Traps Sprung:    **${e.trapsSprung}** *(we don't judge here. much.)*`,
                ].join('\n'),
                inline: false,
            }
        )
        .setTimestamp();

    const relicBonus = getRelicBonus(userData);
    const surveyed = surveyedCount(userData, guildSettings);
    if (relicBonus > 0 || surveyed > 0) {
        const boosts = [];
        if (surveyed > 0)   boosts.push(`🏅 **+${Math.round(LIMITS.SURVEY_BONUS * 100)}%** in ${surveyed} fully surveyed region${surveyed === 1 ? '' : 's'}`);
        if (relicBonus > 0) boosts.push(`🏺 **+${Math.round(relicBonus * 100)}%** everywhere, from the relic case`);
        embed.addFields({ name: '📈 Standing Bonuses', value: boosts.join('\n'), inline: false });
    }

    // Where the road goes next. Explorer level gates every region, and nothing
    // anywhere told a player how close the next one was — the level bar measures
    // progress toward a number, not toward a place.
    const nextGate = REGION_LIST
        .filter(r => !r.seasonalEventId
            && isRegionEnabled(r, guildSettings)
            && !e.unlockedRegions.includes(r.id))
        .sort((a, b) => a.unlockLevel - b.unlockLevel)[0];
    if (isSelf && nextGate) {
        const short = nextGate.unlockLevel - e.level;
        embed.addFields({
            name: '🔭 Next Horizon',
            value: short > 0
                ? `**${nextGate.emoji} ${nextGate.name}** — Explorer Lv ${nextGate.unlockLevel} and ${currency}${nextGate.unlockCost.toLocaleString()}. `
                  + `You're ${short} level${short === 1 ? '' : 's'} short.`
                : `**${nextGate.emoji} ${nextGate.name}** — the level is yours. `
                  + `${currency}${nextGate.unlockCost.toLocaleString()} opens the route via \`/explore travel\`.`,
            inline: false,
        });
    }

    if (isSelf) {
        embed.setFooter({
            text: `Daily: ${e.dailyExpeditions} expeditions · ${currency}${e.dailyCoins.toLocaleString()} earned `
                + `(full rate to ${currency}${LIMITS.DAILY_SOFT_CAP.toLocaleString()}, `
                + `${Math.round(LIMITS.DAILY_SOFT_CAP_RATE * 100)}% to ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()})`,
        });
    }

    return interaction.reply({ embeds: [embed] });
}

// ── Per-user economy lock ─────────────────────────────────────────────────────
// Exploration mutates the user document with read-modify-write saves, and an
// expedition can sit for 20s waiting on the encounter prompt. The lock key is
// the player rather than this command, so every other money-moving command
// contends for it too — see utils/economyLock.js.
const { withEconomyLock } = require('../../utils/economyLock');
module.exports.execute = withEconomyLock(module.exports.execute, { activity: 'explore' });
