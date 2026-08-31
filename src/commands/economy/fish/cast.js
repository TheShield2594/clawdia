'use strict';

// /fish cast — the roll itself, its staged reveal, and the world-record check
// a catch can trip.

const { TIER_NUM, TIER_STARS } = require('../../../data/materialRarity');
const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Guild = require('../../../models/Guild');
const User = require('../../../models/User');
const {
    prepareCastUser,
    validateCastPreflight,
    claimCastCooldown,
    snapshotCastRewards,
    executeCast,
    revertEscapedCast,
    downgradeOptionalMiss,
    applyCastBonuses,
    rollWinterHuntMaterial,
    updateFishQuestProgress,
    commitCast,
    rollBossType,
    ensureFishingData,
    resolveBossEncounter,
    applyPayoutModifiers
} = require('../../../services/fishService');
const { buildCooldownEmbed } = require('../../../utils/cooldownEmbed');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS, FEATURED_RARE_BONUS } = require('../../../data/featuredRotation');
const { getTimeBand } = require('../../../utils/timeBand');
const { isDistrictActive } = require('../../../services/districtService');
const { getEventCrossSystemType } = require('../../../services/seasonalEventService');
const { ensureQuests, onFish, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../../services/questService');
const { recordMissionProgress } = require('../../../services/seasonMissionService');
const { checkAndAward, announceAchievements } = require('../../../services/achievementService');
const { isVersionError } = require('../../../utils/versionRetry');
const { submitCatch: submitTournamentCatch } = require('../../../services/tournamentService');
const { addWeeklyChampionProgress, getWeeklyChampionLeader } = require('../../../utils/weeklyChampion');
const { MATERIAL_NAMES: HUNT_MATERIAL_NAMES } = require('../../../data/huntData');
const { attachGrind } = require('../../../utils/grindProfile');
const { LOCATIONS } = require('../../../data/fishData');
const { saveWithBalanceDelta } = require('../../../utils/balanceDelta');
const { logBigWin } = require('../../../utils/bigWinLogger');
const { PITY_COPY } = require('../../../utils/pityBonus');
const { FISH_TIER_SCORE } = require('./shared');
const { buildCastEmbed } = require('./embeds');
const COLORS = require('../../../utils/embedColors');
const { ownedBy } = require('../../../utils/collectorOwner');
const { stagedLootReveal } = require('../../../utils/stagedLootReveal');

// ═══════════════════════════════════════════════════════════════════════════════
// CAST
// ═══════════════════════════════════════════════════════════════════════════════

async function handleCast(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );

    await prepareCastUser(user);
    const f = user.fishing;

    // ── Preflight (read-only; the cooldown slot is claimed atomically below) ──
    const preflight = validateCastPreflight(user, interaction.options.getString('location'));
    if (!preflight.ok) {
        return replyCastPreflightFailure(interaction, preflight);
    }
    const { locationId, location, rod, rodData } = preflight;

    // Atomically claim the cooldown slot now that all preflight checks have
    // passed — see fishService.claimCastCooldown for the guarantees.
    const claim = await claimCastCooldown(user);
    if (!claim.claimed) {
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🎣 Line Still Settling',
                description: 'Give your line a moment before the next cast.\nPatience is half of fishing.',
                color: '#1e6fa5',
                nextAt: claim.nextAt,
            })],
            flags: MessageFlags.Ephemeral,
        });
    }
    const releaseFishClaim = claim.release;

    // Everything between here and the save can still fail — a Discord API error
    // while collecting the reel-in prompts, a service throwing — and until the
    // result is persisted the player has nothing to show for the cooldown they
    // just paid for. Hand the slot back on the way out unless the cast committed.
    let castCommitted = false;

    // Everything below runs across the bite delay and the reel-in prompt — up to
    // ~8 seconds during which the player can spend coins somewhere else. The
    // cast's own coin movement is collected as a delta against this reading and
    // applied as an atomic `$inc` at the save, so `save()` never writes an
    // absolute balance read before that window. See src/utils/balanceDelta.js.
    const balanceAtLoad = user.balance ?? 0;

    try {

        // Bait comes out only once the cooldown slot is ours, so a lost race never
        // costs the player a bait.
        if (rodData.requiresBait) {
            f.bait[rodData.baitType] = (f.bait[rodData.baitType] ?? 0) - 1;
            user.markModified('fishing');
        }

        const featured          = getDailyFeatured(interaction.guild.id);
        const isFeaturedSpot    = locationId === featured.fishSpot.id;
        const timeBand          = getTimeBand();

        await interaction.deferReply();

        // ── Cast & Wait for Bite ──────────────────────────────────────────────────
        // Common/Uncommon: passive (no button). Rare: optional single button (3s) — miss
        // downgrades to Uncommon payout. Epic: required (3s). Legendary: required (2s).
        const delay      = ms => new Promise(r => setTimeout(r, ms));
        const authorOpts = { name: interaction.member?.displayName || interaction.user.username, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) };
        const featuredNote = isFeaturedSpot ? `\n\n🌟 **Featured Spot!** +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% payout & +${Math.round(FEATURED_RARE_BONUS * 100)}% rare chance active.` : '';

        const luringEmbed = new EmbedBuilder()
            .setColor(isFeaturedSpot ? '#FFD700' : '#4169E1')
            .setTitle('🎣 Cast!')
            .setDescription(`*Your lure hits the water with a satisfying plop…*\n\n🎣 **Lure in water… watching for a bite…**${featuredNote}`)
            .setAuthor(authorOpts);
        await interaction.editReply({ embeds: [luringEmbed], components: [] });
        const reelMsg = await interaction.fetchReply();
        await delay(2000 + Math.floor(Math.random() * 3001));

        // Fish/Shark pet: +5%/+15% yield (only if hunger >= 30)
        const { getTotalBonus, PET_DEFINITIONS: PET_DEFS, isPetActive, TRAIT_FLAVOR, tryGrantRarePet } = require('../../../services/petService');
        const petFishYieldPct = getTotalBonus(user.pets || [], 'fish_yield');

        const marketplaceActive = isDistrictActive(guildSettings, 'marketplace');

        // Snapshot pre-cast reward state so we can reverse it if the fish escapes
        const preCastSnapshot = snapshotCastRewards(user);

        let reelResult = null; // { caught: bool, label: string, icon: string }

        const result = executeCast(user, locationId, { reactionFactor: 1.0, marketplaceActive, username: interaction.user.username });

        // ── Rarity-Gated Reel-In ──────────────────────────────────────────────────
        if (result.success && result.catchType === 'fish' && ['rare', 'epic', 'legendary'].includes(result.tier)) {
            const REEL_TIERS = {
                legendary: { window: 2000, required: true,  color: '#FFD700', emoji: '⚡', label: 'LEGENDARY CATCH — REEL IT IN!',  tagline: 'Once-in-a-lifetime — don\'t let it go!' },
                epic:      { window: 3000, required: true,  color: '#9b59b6', emoji: '🔥', label: 'EPIC CATCH — HOLD THE LINE!',    tagline: 'A rare fighter — keep the tension!' },
                rare:      { window: 3000, required: false, color: '#3498db', emoji: '🎣', label: 'You feel a bite! Reel In?',      tagline: 'Hit the button to land it, or it slips to Uncommon.' },
            };
            const cfg   = REEL_TIERS[result.tier];
            const reelId = `reel_${interaction.id}`;

            const biteEmbed = new EmbedBuilder()
                .setColor(cfg.color)
                .setTitle(`${cfg.emoji} ${cfg.label}`)
                .setDescription(
                    `*A **${result.fish.name}** is on the line!*\n\n` +
                    `${cfg.tagline}\n\n` +
                    (cfg.required
                        ? `⚠️ **Press within ${cfg.window / 1000}s or it escapes!**`
                        : `💡 **Optional** — miss it and you still get an Uncommon catch.`)
                )
                .setAuthor(authorOpts);
            const reelRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(reelId)
                    .setLabel(`🎣 Reel In! (${cfg.window / 1000}s)`)
                    .setStyle(cfg.required ? ButtonStyle.Danger : ButtonStyle.Primary)
            );
            await interaction.editReply({ embeds: [biteEmbed], components: [reelRow] });

            const reelPressed = await new Promise(resolve => {
                const col = reelMsg.createMessageComponentCollector({
                    filter: ownedBy(interaction.user.id, i => i.customId === reelId, "This isn't your cast."),
                    time: cfg.window,
                    max: 1,
                });
                col.on('collect', async i => { await i.deferUpdate(); resolve(true); });
                col.on('end', (_, reason) => { if (reason !== 'limit') resolve(false); });
            });

            if (!reelPressed) {
                if (cfg.required) {
                    // Fish escapes — only stamina and rod durability stay spent.
                    revertEscapedCast(user, preCastSnapshot, result);
                    reelResult = { caught: false, icon: '💨', label: `${result.tier} fish escaped!` };

                    const durLine = result.durabilityLost > 0 ? ` Rod took ${result.durabilityLost} durability damage.` : '';
                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor(COLORS.NEUTRAL)
                            .setTitle('💨 It Got Away!')
                            .setDescription(`*The ${result.fish.name} snapped the line and vanished into the depths.*\n\nStamina spent — nothing to show for it.${durLine}`)
                            .setAuthor(authorOpts)],
                        components: [],
                    });
                    await delay(1200);
                } else {
                    // Rare optional miss — downgrade payout to simulate Uncommon yield
                    downgradeOptionalMiss(user, result);
                    reelResult = { caught: true, icon: '😬', label: 'Rare slipped — Uncommon catch instead' };

                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor(COLORS.NEUTRAL)
                            .setTitle('😬 Slipped Away Partially…')
                            .setDescription(`*The ${result.fish.name} struggled free but you still pulled something in.*\n\nCatch downgraded to Uncommon.`)
                            .setAuthor(authorOpts)],
                        components: [],
                    });
                    await delay(800);
                }
            } else {
                const tierLabel = result.tier.charAt(0).toUpperCase() + result.tier.slice(1);
                reelResult = { caught: true, icon: cfg.required ? '🏆' : '✅', label: `${tierLabel} catch secured!` };
                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setColor(cfg.color)
                        .setTitle(`${reelResult.icon} ${reelResult.label}`)
                        .setDescription('*Reeling it in…*')
                        .setAuthor(authorOpts)],
                    components: [],
                });
                await delay(600);
            }
        }
        // ─────────────────────────────────────────────────────────────────────────

        // Pity counter, pet yield, featured-spot and Wilderness bonuses,
        // best-payout stat — the full post-roll bonus stack.
        applyCastBonuses(user, result, {
            petFishYieldPct,
            isFeaturedSpot,
            featuredPayoutBonus: FEATURED_PAYOUT_BONUS,
            wildernessActive: isDistrictActive(guildSettings, 'wilderness'),
        });

        // Winter Hunt cross-system bonus: fishing at Misty Lake drops arctic hunt materials
        const winterHuntMaterial = rollWinterHuntMaterial(
            user, result, getEventCrossSystemType(guildSettings), locationId
        );

        updateFishQuestProgress(user, result, locationId);
        await ensureQuests(user, guildSettings);
        const { completed: questsDone, nearComplete: questsNear } = await onFish(user, guildSettings);
        // Season pass daily missions listen for the same actions quests do.
        recordMissionProgress(user, 'fish', 1, guildSettings);
        if (result.success && result.finalPayout > 0) {
            const earn = await onEconomyEarn(user, guildSettings, result.finalPayout);
            questsDone.push(...earn.completed);
            questsNear.push(...earn.nearComplete);
        }

        // Rare companions are found, not bought: a legendary result is the only
        // thing that can turn one up. Rolled before the save below persists it.
        const rarePetDrop = result.success ? tryGrantRarePet(user, 'fish', result.tier) : null;
        if (rarePetDrop) user.markModified('pets');

        const fishAchievements = await checkAndAward(user, guildSettings).catch(() => []);

        // Persist and credit through the service. An escape reverses its own
        // mutations, so that path simply produces a delta of zero and issues
        // no coin write.
        let payoutOwed = 0;
        try {
            ({ payoutOwed } = await commitCast(user, balanceAtLoad));
            castCommitted = true;
            if (fishAchievements.length) {
                announceAchievements(interaction.client, guildSettings, user, interaction.member, fishAchievements).catch(() => null);
            }
            notifyQuestComplete(guildSettings, interaction.member, questsDone, interaction.channel, user).catch(() => null);
            notifyQuestNearComplete(guildSettings, interaction.member, questsNear, interaction.channel).catch(() => null);
        } catch (err) {
            // Nothing was saved, so give the cooldown slot back before telling them to retry.
            await releaseFishClaim();
            if (isVersionError(err)) {
                return interaction.editReply({ content: 'A simultaneous request conflicted. Please try `/fish cast` again.' });
            }
            console.error('[fish] save error:', err);
            return interaction.editReply({ content: 'Something went wrong saving your catch. Please try again.' });
        }

        // Submit to active tournament if fish catch (not junk/treasure)
        if (result.success && result.catchType === 'fish' && result.fish && result.finalPayout > 0) {
            submitTournamentCatch(interaction.guild.id, {
                userId:    interaction.user.id,
                username:  interaction.user.username,
                fishName:  result.fish.name,
                fishEmoji: result.fish.emoji ?? '🐟',
                tier:      result.tier,
                score:     result.finalPayout
            }).catch(() => null);
        }

        // Track world records (heaviest catch per fish species in the server)
        if (result.success && result.catchType === 'fish' && result.fish && result.weightLbs > 0) {
            checkAndUpdateWorldRecord(interaction.guild.id, {
                fish:     result.fish.name,
                weight:   result.weightLbs,
                userId:   interaction.user.id,
                username: interaction.user.username,
            }).catch(() => null);
        }

        // Await the weekly tally update then re-fetch for accurate footer
        if (result.success) {
            const tierScore = FISH_TIER_SCORE[result.tier] ?? 0;
            if (tierScore > 0 && result.fish) {
                await addWeeklyChampionProgress({ guildId: interaction.guild.id, category: 'fish', userId: interaction.user.id, username: interaction.user.username, value: tierScore, details: `${result.fish.emoji ?? ''} ${result.fish.name} (${result.tier})`.trim() }).catch(() => null);
            }
        }
        const weeklyLeader = await getWeeklyChampionLeader(interaction.guild.id, 'fish').catch(() => null);

        // Fish escaped — already showed escape embed; just save stamina/cooldown and return
        if (result.escaped) {
            await user.save().catch(err => console.error('[fish] escape save error:', err));
            return;
        }

        const embed = buildCastEmbed(result, user, location, rod, currency, interaction.user);

        if (payoutOwed > 0) {
            embed.addFields({
                name: '⚠️ Payout Not Yet Credited',
                value: `The **${currency}${payoutOwed.toLocaleString()}** from this catch could not be paid out just now and has been recorded as owed — the balance shown below does not include it. It will be applied once the problem clears; tell an admin if it does not.`,
            });
        }

        if (result.petYieldBonus > 0) {
            embed.addFields({ name: '🐠 Pet Bonus', value: `+${result.petYieldBonus.toLocaleString()} coins (${petFishYieldPct}% yield)`, inline: true });
        }
        if (result.featuredSpotBonus > 0) {
            embed.addFields({ name: '🌟 Featured Spot Bonus', value: `+${result.featuredSpotBonus.toLocaleString()} coins (+${Math.round(FEATURED_PAYOUT_BONUS * 100)}%)`, inline: true });
        }
        if (result.wildernessBonus > 0) {
            embed.addFields({ name: '🌲 Wilderness District', value: `+${result.wildernessBonus.toLocaleString()} coins (+10% yield)`, inline: true });
        }
        if (winterHuntMaterial) {
            const matName = HUNT_MATERIAL_NAMES[winterHuntMaterial] ?? winterHuntMaterial;
            embed.addFields({ name: '❄️ Winter Hunt Event', value: `+1 ${matName} (hunt material found in icy waters!)`, inline: true });
        }

        // Weekly champion race footer. Fish accumulates rarity tiers rather
        // than coins, so the number is a score and is named as one.
        let leaderNote;
        if (weeklyLeader) {
            leaderNote = `👑 Angler of the Week so far: ${weeklyLeader.username} — ${(weeklyLeader.total ?? 0).toLocaleString()} rarity score`;
        } else {
            leaderNote = '👑 No Angler of the Week yet — be the first!';
        }
        const existingFooter = embed.data.footer?.text ?? '';
        embed.setFooter({ text: existingFooter ? `${existingFooter} · ${timeBand.emoji} ${timeBand.label} · ${leaderNote}` : `${timeBand.emoji} ${timeBand.label} · ${leaderNote}` });

        // Annotate embed with rarity reel-in result
        if (reelResult) {
            const desc = embed.data.description ?? '';
            embed.setDescription(desc + `\n> ${reelResult.icon} *${reelResult.label}*`);
        }

        // Boss encounter — multi-phase fight
        if (result.bossEncounter) {
            const bossType     = rollBossType();
            const choicesMade  = [];
            const phaseCount   = bossType.phases.length;

            const buildBossPhaseEmbed = (phaseIndex, prevResults) => {
                const phase      = bossType.phases[phaseIndex];
                const integrity  = 3 - prevResults.filter(p => !p.correct && p.chosen !== 'safe').length;
                const intBar     = '❤️'.repeat(integrity) + '🖤'.repeat(3 - integrity);
                const histLines  = prevResults.map((p, i) => {
                    const icon = p.correct ? '✅' : p.chosen === 'safe' ? '🛡️' : '❌';
                    return `Phase ${i + 1}: ${icon}`;
                }).join('  ');

                return new EmbedBuilder()
                    .setColor('#1C0A00')
                    .setTitle(`${bossType.emoji} ${bossType.name} — Phase ${phaseIndex + 1}/${phaseCount}`)
                    .setDescription(
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `  ${result.bossEncounter.fish.emoji}  **${result.bossEncounter.fish.name}**\n` +
                        `  Line Integrity: ${intBar}\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `${phase.hint}\n\n` +
                        (histLines ? `${histLines}\n\n` : '') +
                        `**Choose your response — NOW:**`
                    )
                    .setFooter({ text: `⏱️ 30 seconds per phase • Outcomes: 3/3=Full legendary payout | 2/3=Rare | 1/3=Common | 0/3=Nothing` });
            };

            const buildPhaseRow = (phaseIndex) => {
                const phase   = bossType.phases[phaseIndex];
                const choices = phase.choices;
                return new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('boss_match').setLabel(choices.match.label).setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('boss_hold').setLabel(choices.hold.label).setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('boss_safe').setLabel(choices.safe.label).setStyle(ButtonStyle.Secondary)
                );
            };

            const validIds = ['boss_match', 'boss_hold', 'boss_safe'];
            const idToKey  = { boss_match: 'match', boss_hold: 'hold', boss_safe: 'safe' };

            // Phase 1
            await interaction.editReply({ embeds: [embed, buildBossPhaseEmbed(0, [])], components: [buildPhaseRow(0)] });

            const runPhase = async (phaseIndex, prevResults, prevBtn) => {
                const fetchReply = prevBtn ? await prevBtn.fetchReply() : await interaction.fetchReply();

                return new Promise(resolve => {
                    const collector = fetchReply.createMessageComponentCollector({
                        filter: ownedBy(interaction.user.id, i => validIds.includes(i.customId), "This isn't your cast."),
                        time: 30_000, max: 1
                    });
                    collector.on('collect', async btn => {
                        const chosen    = idToKey[btn.customId];
                        const phase     = bossType.phases[phaseIndex];
                        const correct   = chosen === phase.correct;
                        const results   = [...prevResults, { correct, chosen, correctChoice: phase.correct }];
                        choicesMade.push(chosen);

                        if (phaseIndex < phaseCount - 1) {
                            // More phases ahead
                            await btn.update({ embeds: [embed, buildBossPhaseEmbed(phaseIndex + 1, results)], components: [buildPhaseRow(phaseIndex + 1)] });
                            resolve({ btn, results });
                        } else {
                            resolve({ btn, results, done: true });
                        }
                    });
                    collector.on('end', (collected, reason) => {
                        if (reason === 'time' && collected.size === 0) {
                            // Timeout — treat as safe choice for remaining phases
                            resolve({ btn: null, results: prevResults, timedOut: true });
                        }
                    });
                });
            };

            // Run all 3 phases sequentially
            let state = { btn: null, results: [], done: false, timedOut: false };
            for (let i = 0; i < phaseCount; i++) {
                state = await runPhase(i, state.results, state.btn);
                if (state.timedOut) {
                    const timeoutEmbed = new EmbedBuilder()
                        .setColor('#1C0A00')
                        .setTitle(`${bossType.emoji} ${bossType.name} Slipped Away`)
                        .setDescription(`⏱️ *You hesitated too long — the ${bossType.name} broke free before you could respond.*\n\nThe base catch above still counts; no bonus boss payout was earned.`);
                    interaction.editReply({ embeds: [embed, timeoutEmbed], components: [] }).catch(() => {});
                    return;
                }
            }

            // Resolve outcome
            const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            await attachGrind(freshUser);
            ensureFishingData(freshUser);
            const bossResult = resolveBossEncounter(freshUser, result.bossEncounter.fish, result.bossEncounter.tier, choicesMade, bossType);

            // The reload above is already seconds old by the time the fight
            // resolves, and `save()` writes `balance` as an absolute `$set` — so
            // the bonus is applied as its own `$inc` and `balance` stays out of
            // the save, exactly as the cast itself does.
            const bossBalanceAtLoad = freshUser.balance ?? 0;

            let bossQuestsDone = [], bossQuestsNear = [];
            if (bossResult.bonusPayout > 0) {
                const bossLocation = LOCATIONS[freshUser.fishing.activeLocation] ?? location;
                const { adjustedPayout } = applyPayoutModifiers(freshUser, bossResult.bonusPayout, bossLocation);
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
                });
                if (!bossPaid.credited) bossPayoutOwed = bossResult.bonusPayout;
                if (bossQuestsDone.length || bossQuestsNear.length) {
                    notifyQuestComplete(guildSettings, interaction.member, bossQuestsDone, interaction.channel, freshUser).catch(() => null);
                    notifyQuestNearComplete(guildSettings, interaction.member, bossQuestsNear, interaction.channel).catch(() => null);
                }
            } catch (saveErr) {
                console.error('[fish boss] save error:', saveErr);
                return state.btn.update({ content: 'Something went wrong saving your boss result. Please try again.', embeds: [], components: [] });
            }

            if (bossResult.bonusPayout > 0) {
                const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
                if (bossResult.bonusPayout >= bigWinThreshold) {
                    logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: bossResult.bonusPayout, source: 'fish', details: { itemName: result.bossEncounter.fish.name, rarity: 'boss' }, client: interaction.client });
                }
                // Submit boss win to active tournament with multiplier bonus
                const tournamentScore = Math.round(bossResult.bonusPayout * (bossResult.tournamentMultiplier ?? 1));
                submitTournamentCatch(interaction.guild.id, {
                    userId:    interaction.user.id,
                    username:  interaction.user.username,
                    fishName:  result.bossEncounter.fish.name,
                    fishEmoji: result.bossEncounter.fish.emoji ?? '🐉',
                    tier:      result.bossEncounter.tier,
                    score:     tournamentScore,
                    isBossKill: ['perfect', 'win'].includes(bossResult.outcome)
                }).catch(() => null);
            }

            const phaseScoreLine = bossResult.phaseResults.map((p, i) => {
                const icon = p.correct ? '✅' : p.chosen === 'safe' ? '🛡️' : '❌';
                return `Phase ${i + 1}: ${icon}`;
            }).join('  ');

            const outcomeColors = { perfect: '#FFD700', win: '#2ecc71', survived: '#3498db', escaped: '#1C0A00' };
            const outcomeTitles = {
                perfect:  `🏆 ${result.bossEncounter.fish.emoji} PERFECT — ${bossType.name} Mastered!`,
                win:      `✅ ${result.bossEncounter.fish.emoji} ${bossType.name} Subdued`,
                survived: `😓 ${result.bossEncounter.fish.emoji} Barely Survived`,
                escaped:  `💀 ${result.bossEncounter.fish.emoji} ${bossType.name} Escaped!`
            };

            const bossResultEmbed = new EmbedBuilder()
                .setColor(outcomeColors[bossResult.outcome] ?? '#95a5a6')
                .setTitle(outcomeTitles[bossResult.outcome] ?? '❓ Boss Result')
                .setDescription(`${phaseScoreLine}\n\n${bossResult.message}`)
                .addFields(
                    { name: 'Score',        value: `${bossResult.correctCount}/3 correct`, inline: true },
                    { name: 'Bonus Payout', value: bossResult.bonusPayout > 0 ? `${currency}${bossResult.bonusPayout.toLocaleString()}` : 'None', inline: true },
                    { name: 'Rod Damage',   value: `-${bossResult.durabilityLost} durability`, inline: true }
                )
                .setTimestamp();

            if (bossPayoutOwed > 0) {
                bossResultEmbed.addFields({
                    name: '⚠️ Payout Not Yet Credited',
                    value: `The **${currency}${bossPayoutOwed.toLocaleString()}** bonus could not be paid out just now and has been recorded as owed — your balance does not include it yet. It will be applied once the problem clears; tell an admin if it does not.`,
                });
            }

            await state.btn.update({ embeds: [embed, bossResultEmbed], components: [] });
            return;
        }

        // Non-boss path: log big win after all payouts finalized
        if (result.success) {
            const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
            if (result.finalPayout >= bigWinThreshold || ['legendary', 'event'].includes(result.tier)) {
                logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: result.finalPayout, source: 'fish', details: { itemName: result.fish?.name, rarity: result.tier }, client: interaction.client });
            }
        }

        // Rare companion drop — announced prominently; this is the only way to get one.
        if (rarePetDrop) {
            embed.addFields({
                name: `${rarePetDrop.emoji} A Rare Companion Appears!`,
                value: `A wild **${rarePetDrop.name}** followed you home! It joined your pets at full hunger.\n`
                     + `Passive: **+${rarePetDrop.bonusPct}% ${rarePetDrop.bonusType.replace(/_/g, ' ')}** · Favourite food: \`${rarePetDrop.favoriteMaterial}\`\n`
                     + `*Name it with \`/pet rename\` and keep it fed with \`/pet feed\`.*`,
                inline: false,
            });
        }

        // Pet narrative: show active pet's personality flavor in description
        if (result.success && result.catchType !== 'junk') {
            const activePet = (user.pets || []).find(p => isPetActive(p));
            if (activePet) {
                const petDef = PET_DEFS[activePet.petId];
                const petName = activePet.name || petDef?.name || activePet.petId;
                const flavorFn = TRAIT_FLAVOR[activePet.personality]?.fish;
                if (flavorFn && petDef) {
                    const desc = embed.data.description ?? '';
                    embed.setDescription(desc + `\n> ${flavorFn(petName, petDef.emoji)}`);
                }
            }
        }

        // Staged loot reveal for rare+ drops
        await stagedLootReveal(interaction, result.success ? result.tier : null, embed, 'fish');

        if (result.success && ['epic', 'legendary', 'event'].includes(result.tier) && guildSettings?.economy?.announceRareDrops !== false) {
            const announceChannelId = guildSettings?.economy?.announcementChannelId;
            const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
            const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
            const announceTier = TIER_NUM[result.tier] ?? 4;
            const ANNOUNCE_COPY = {
                4: { color: '#9c27b0', title: '🔮 Epic Catch!',             line: 'A remarkable catch.' },
                5: { color: '#ff9800', title: '✨ Legendary Catch! ✨',      line: "That's incredibly rare." },
                6: { color: '#e74c3c', title: '☄️ Mythical Catch! ☄️',      line: 'Sailors tell stories about this one.' },
            };
            const copy = ANNOUNCE_COPY[announceTier] ?? ANNOUNCE_COPY[4];
            const announcementEmbed = new EmbedBuilder()
                .setColor(copy.color)
                .setTitle(copy.title)
                .setDescription(
                    `<@${interaction.user.id}> just pulled ${result.fish.emoji} **${result.fish.name}** [${TIER_STARS[announceTier]}]\n` +
                    `while fishing in the **${location.name}**.\n\n` +
                    copy.line
                )
                .setTimestamp();
            announceChannel.send({ embeds: [announcementEmbed] }).catch(() => null);
        }
    } catch (err) {
        if (!castCommitted) await releaseFishClaim();
        throw err;
    }
}

// Renders a failed cast preflight (fishService.validateCastPreflight) as the
// reply the player sees. Pure presentation — every check lives in the service.
function replyCastPreflightFailure(interaction, preflight) {
    const ephemeral = { flags: MessageFlags.Ephemeral };
    switch (preflight.reason) {
        case 'unknown_location':
            return interaction.reply({ content: `Unknown location. Use \`/fish location list\` to see available spots.`, ...ephemeral });
        case 'location_locked':
            return interaction.reply({
                content: `You haven't unlocked **${preflight.location.name}** yet. Use \`/fish shop unlock\` to unlock it.`,
                ...ephemeral
            });
        case 'level_too_low':
            return interaction.reply({
                content: `You need to be Fisher Level **${preflight.location.unlockLevel}** to fish at **${preflight.location.name}**.`,
                ...ephemeral
            });
        case 'injured':
            return interaction.reply({
                embeds: [buildCooldownEmbed({
                    title: '🤕 Drying Off',
                    description: "You're still recovering from your last mishap.\nThe fish will be there when you're back.",
                    color: '#1e6fa5',
                    nextAt: preflight.nextAt,
                })],
                ...ephemeral,
            });
        case 'cooldown':
            return interaction.reply({
                embeds: [buildCooldownEmbed({
                    title: '🎣 Line Still Settling',
                    description: 'Give your line a moment before the next cast.\nPatience is half of fishing.',
                    color: '#1e6fa5',
                    nextAt: preflight.nextAt,
                })],
                ...ephemeral,
            });
        case 'no_stamina': {
            // Surfaces the fail-streak pity that actually exists, using the shared
            // curve so this never drifts from what calculateSuccessChance applies.
            // There is no rare-catch pity — sinceRare is a stat, not a guarantee,
            // so it is reported as one.
            const pityBits = [];
            if (preflight.pityBonus > 0) {
                pityBits.push(`🎯 ${preflight.consecutiveFails} ${PITY_COPY.fishing.streakNoun} • +${Math.round(preflight.pityBonus * 100)}% success on your next cast`);
            }
            if (preflight.sinceRare >= 5) pityBits.push(`🐟 ${preflight.sinceRare} casts since your last Rare+ catch`);
            return interaction.reply({
                embeds: [buildCooldownEmbed({
                    title: '😮‍💨 Too Tired to Cast',
                    description: "You've worn yourself out on the water.\nBuy an **Energy Drink** from `/fish shop` to speed up recovery.",
                    color: '#1e6fa5',
                    nextAt: preflight.nextAt,
                    pityStat: pityBits.length ? pityBits.join('\n') : null,
                    nextRewardPreview: `Full stamina = ${preflight.maxStamina} casts · Boss fights can start on any Rare or better catch`,
                })],
                ...ephemeral,
            });
        }
        case 'no_rod':
            return interaction.reply({
                content: `You don't have a rod equipped! Buy one with \`/fish shop rod\` and equip it with \`/fish inv equip 1\`.`,
                ...ephemeral
            });
        case 'rod_broken':
            return interaction.reply({
                content: `Your **${preflight.rod.name}** is broken! Repair it with \`/fish shop repair\` or buy a new one with \`/fish shop rod\`.`,
                ...ephemeral
            });
        case 'no_bait':
            return interaction.reply({
                content: `You're out of **${preflight.rodData.baitType.replace(/_/g, ' ')}**! Buy more with \`/fish shop\`.`,
                ...ephemeral
            });
        default:
            return interaction.reply({ content: 'You cannot cast right now.', ...ephemeral });
    }
}

// ─── World Records ────────────────────────────────────────────────────────────
async function checkAndUpdateWorldRecord(guildId, { fish, weight, userId, username }) {
    const existing = await Guild.findOne(
        { guildId, 'fishingWorldRecords.fish': fish },
        { 'fishingWorldRecords.$': 1 }
    ).lean().catch(() => null);

    const existingRecord = existing?.fishingWorldRecords?.[0];
    if (existingRecord && existingRecord.weight >= weight) return;

    if (existingRecord) {
        await Guild.updateOne(
            { guildId, 'fishingWorldRecords.fish': fish },
            { $set: { 'fishingWorldRecords.$.weight': weight, 'fishingWorldRecords.$.userId': userId, 'fishingWorldRecords.$.username': username, 'fishingWorldRecords.$.date': new Date() } }
        ).catch(() => {});
    } else {
        await Guild.updateOne(
            { guildId },
            { $push: { fishingWorldRecords: { fish, weight, userId, username, date: new Date() } } }
        ).catch(() => {});
    }
}

module.exports = {
    checkAndUpdateWorldRecord,
    handleCast,
    replyCastPreflightFailure,
};
