'use strict';

// /fish cast — the roll itself, its staged reveal, and the world-record check
// a catch can trip.

const { TIER_NUM, TIER_STARS } = require('../../../data/materialRarity');
const { EmbedBuilder, MessageFlags } = require('discord.js');
const Guild = require('../../../models/Guild');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
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
    rollFightCues,
    recordPendingRelease,
} = require('../../../services/fishService');
const { buildCooldownEmbed } = require('../../../utils/cooldownEmbed');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS, FEATURED_RARE_BONUS } = require('../../../data/featuredRotation');
const { isDistrictActive } = require('../../../services/districtService');
const { getEventCrossSystemType } = require('../../../services/seasonalEventService');
const { ensureQuests, onFish, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../../services/questService');
const { recordMissionProgress } = require('../../../services/seasonMissionService');
const { checkAndAward, announceAchievements } = require('../../../services/achievementService');
const { isVersionError } = require('../../../utils/versionRetry');
const { submitCatch: submitTournamentCatch } = require('../../../services/tournamentService');
const { addWeeklyChampionProgress, getWeeklyChampionLeader } = require('../../../utils/weeklyChampion');
const { MATERIAL_NAMES: HUNT_MATERIAL_NAMES } = require('../../../data/huntData');
const { WILDERNESS_YIELD_BONUS } = require('../../../data/crossSystemData');
const { gatherPayoutKey } = require('../../../utils/payoutKey');
const { logBigWin } = require('../../../utils/bigWinLogger');
const { PITY_COPY } = require('../../../utils/pityBonus');
const { FISH_TIER_SCORE, awaitCasterClick, buildMoveRow, moveFromCustomId } = require('./shared');
const { REEL_IN, FIGHT_MOVES, FISH_WEIGHT_SCALE } = require('../../../data/fishData');
const { runBossFight } = require('./boss');
const { buildCastEmbed } = require('./embeds');
const { attachResultThumbnail } = require('../../../utils/itemImageHelper');
const { renderFishResultCard, cardChips } = require('./resultCard');
const { attachResultActions, buildResultActions } = require('./actions');
const COLORS = require('../../../utils/embedColors');
const { stagedLootReveal } = require('../../../utils/stagedLootReveal');

// ═══════════════════════════════════════════════════════════════════════════════
// CAST
// ═══════════════════════════════════════════════════════════════════════════════

const delay = ms => new Promise(r => setTimeout(r, ms));

async function handleCast(interaction) {
    const guildSettings = await getGuildSettings(interaction.guild.id);
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

    // Every refusal that answers privately has been given by now. What follows —
    // the cooldown claim, and the result save behind it — is more database
    // round-trips than Discord's three-second window safely allows, so the cast
    // is acknowledged before any of it.
    await interaction.deferReply();

    // Atomically claim the cooldown slot now that all preflight checks have
    // passed — see fishService.claimCastCooldown for the guarantees.
    const claim = await claimCastCooldown(user);
    if (!claim.claimed) {
        // Only reachable when two of the player's own casts race each other; the
        // reply is already public by now, so the notice goes there.
        return interaction.editReply({
            embeds: [buildCooldownEmbed({
                title: '🎣 Line Still Settling',
                description: 'Give your line a moment before the next cast.\nPatience is half of fishing.',
                color: '#1e6fa5',
                nextAt: claim.nextAt,
            })],
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

        // ── Cast & Wait for Bite ──────────────────────────────────────────────────
        // Common/Uncommon land on their own. Rare, Epic and Legendary put up a
        // fight the angler has to read — see the reel-in below and REEL_IN.
        const authorOpts = { name: interaction.member?.displayName || interaction.user.username, iconURL: interaction.user.displayAvatarURL() };
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

        let reelResult = null; // { caught: bool, label: string, icon: string } — shown on the result

        const result = executeCast(user, locationId, { reactionFactor: 1.0, marketplaceActive, username: interaction.user.username });

        // ── The Fight: Rarity-Gated Reel-In ──────────────────────────────────────
        // A rare-or-better bite fights back. Each beat shows what the fish is
        // doing and the angler answers with one of three moves (FIGHT_MOVES), in a
        // fresh order each time. The bite never names the fish or its tier — the
        // staged reveal after the fight is where the catch is shown — only the
        // urgency of the prompt hints at how big it is.
        const reelCfg = result.success && result.catchType === 'fish' ? REEL_IN[result.tier] : null;
        if (reelCfg) {
            const BITE = {
                rare:      { color: '#3498db', title: '🎣 Something\'s biting!' },
                epic:      { color: '#9b59b6', title: '🔥 Your rod bends double!' },
                legendary: { color: '#FFD700', title: '⚡ The reel SCREAMS!' },
            }[result.tier];
            const stakes      = reelCfg.required ? 'Misread it and it\'s gone.' : 'Misread it and you\'ll land something smaller.';
            const cues        = rollFightCues(reelCfg.beats);
            const customIdFor = move => `reel_${interaction.id}_${move}`;
            const moveIds     = Object.keys(FIGHT_MOVES).map(customIdFor);

            let missed = null; // { cue, chosen } — the beat that was misread
            for (let beat = 0; beat < cues.length; beat++) {
                const beatEmbed = new EmbedBuilder()
                    .setColor(BITE.color)
                    .setTitle(BITE.title)
                    .setDescription(
                        (beat > 0 ? '**It\'s not done yet!**\n\n' : '') +
                        `> **${cues[beat].text}**\n\n` +
                        `**What do you do?** ⏱️ ${reelCfg.windowMs / 1000}s — ${stakes}`
                    )
                    .setAuthor(authorOpts);
                if (cues.length > 1) beatEmbed.setFooter({ text: `Read ${beat + 1} of ${cues.length}` });

                const pick = awaitCasterClick(reelMsg, interaction.user.id, moveIds);
                await interaction.editReply({ embeds: [beatEmbed], components: [buildMoveRow(customIdFor)] });
                pick.start(reelCfg.windowMs);
                const clicked = await pick.choice;
                const chosen  = clicked ? moveFromCustomId(clicked) : null;
                if (chosen !== cues[beat].correct) { missed = { cue: cues[beat], chosen }; break; }
                if (beat < cues.length - 1) await delay(400);
            }

            if (missed) {
                // Say what the right read was, so a miss teaches the next fight.
                const right    = FIGHT_MOVES[missed.cue.correct];
                const feedback = missed.chosen
                    ? `You went for **${FIGHT_MOVES[missed.chosen].label.toLowerCase()}** — it needed **${right.emoji} ${right.label.toLowerCase()}**.`
                    : `You froze — it needed **${right.emoji} ${right.label.toLowerCase()}**.`;

                if (reelCfg.required) {
                    // Fish escapes — only stamina and rod durability stay spent.
                    const lostFish = result.fish;
                    const lostTier = result.tier === 'legendary' ? 'Legendary' : 'Epic';
                    revertEscapedCast(user, preCastSnapshot, result);

                    const durLine = result.durabilityLost > 0 ? ` Your rod took ${result.durabilityLost} durability damage.` : '';
                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor(COLORS.NEUTRAL)
                            .setTitle('💨 The One That Got Away')
                            .setDescription(
                                `${feedback}\n\n` +
                                `*The line snaps. For one second you see it roll at the surface — a ${lostFish.emoji} **${lostFish.name}**. ${lostTier}.*\n\n` +
                                `Stamina spent — nothing to show for it.${durLine}`
                            )
                            .setAuthor(authorOpts)],
                        components: [],
                    });
                    await delay(1200);
                } else {
                    // Rare misread — the rare one slips off and an Uncommon comes up instead.
                    downgradeOptionalMiss(user, result, preCastSnapshot, { locationId, username: interaction.user.username });
                    reelResult = { caught: true, icon: '😬', label: `Something rare slipped the hook — you landed this instead` };

                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor(COLORS.NEUTRAL)
                            .setTitle('😬 It Shook Free…')
                            .setDescription(`${feedback}\n\n*The big one tears loose — but something smaller grabs the lure on the way back.*`)
                            .setAuthor(authorOpts)],
                        components: [],
                    });
                    await delay(900);
                }
            } else {
                reelResult = cues.length > 1
                    ? { caught: true, icon: '🏆', label: `Won a ${cues.length}-round fight` }
                    : { caught: true, icon: '🎯', label: 'Landed on a perfect read' };
                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setColor(BITE.color)
                        .setTitle('🎯 Perfect read!')
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
        // What this catch would cost to release, for the result's Keep / Release
        // buttons — saved with the cast, keyed by it, and replacing whatever an
        // earlier cast left on offer.
        let release = recordPendingRelease(user, interaction.id, result);

        let payoutOwed = 0;
        try {
            ({ payoutOwed } = await commitCast(user, balanceAtLoad, {
                payoutKey: gatherPayoutKey('fish', interaction.id, 'run'),
            }));
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
                return interaction.editReply({ content: 'A simultaneous request conflicted. Please try `/fish cast` again.', embeds: [], components: [] });
            }
            console.error('[fish] save error:', err);
            return interaction.editReply({ content: 'Something went wrong saving your catch. Please try again.', embeds: [], components: [] });
        }

        // Fish escaped — the escape embed is already up, and commitCast saved the
        // stamina, durability and cooldown it cost. All that is left to offer is
        // another cast.
        if (result.escaped) {
            await interaction.editReply({ components: buildResultActions(null) }).catch(() => {});
            await attachResultActions(interaction, { locationId });
            return { started: true };
        }
        // A payout that did not land cannot be handed back.
        if (payoutOwed > 0) release = null;

        // Submit to active tournament if fish catch (not junk/treasure). The score
        // is the catch itself: the pet, featured-spot and Wilderness bonuses are
        // paid out but left off it, so owning a pet or fishing today's featured
        // spot doesn't decide a tournament.
        const catchScore = (result.finalPayout ?? 0)
            - (result.petYieldBonus ?? 0) - (result.featuredSpotBonus ?? 0) - (result.wildernessBonus ?? 0);
        if (result.success && result.catchType === 'fish' && result.fish && catchScore > 0) {
            submitTournamentCatch(interaction.guild.id, {
                userId:    interaction.user.id,
                username:  interaction.user.username,
                fishName:  result.fish.name,
                fishEmoji: result.fish.emoji ?? '🐟',
                tier:      result.tier,
                score:     catchScore
            }).catch(() => null);
        }

        // Server records (heaviest catch per species). Awaited so a record the
        // catch sets is announced on the catch itself.
        let worldRecord = null;
        if (result.success && result.catchType === 'fish' && result.fish && result.weightLbs > 0) {
            worldRecord = await checkAndUpdateWorldRecord(interaction.guild.id, {
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

        const embed = buildCastEmbed(result, user, location, rod, currency, interaction.user);

        // The picture card leads a landed fish: its art, weight against its
        // species, the payout and how the fight went, drawn above this text
        // (fish/resultCard — the card /hunt start draws for a kill). If it
        // cannot be drawn the art falls back to the embed's thumbnail. Either
        // attachment rides every later render of the message, boss rounds
        // included.
        const cardArgs = {
            result, location, worldRecord,
            username: interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username,
            chips: cardChips({
                result, reelResult, isFeaturedSpot, rarePetDrop,
                featuredPct: Math.round(FEATURED_PAYOUT_BONUS * 100),
                winterMaterialName: winterHuntMaterial ? (HUNT_MATERIAL_NAMES[winterHuntMaterial] ?? winterHuntMaterial) : null,
            }),
        };
        const card = await renderFishResultCard(cardArgs);
        const lead = card ? [card.embed] : [];
        const catchFiles = card
            ? [card.file]
            : result.success && result.catchType === 'fish'
                ? await attachResultThumbnail(embed, 'fish', result.fish, interaction.guild.id)
                : [];

        if (payoutOwed > 0) {
            embed.addFields({
                name: '⚠️ Payout Not Yet Credited',
                value: `The **${currency}${payoutOwed.toLocaleString()}** from this catch could not be paid out just now and has been recorded as owed — the balance shown below does not include it. It will be applied once the problem clears; tell an admin if it does not.`,
            });
        }

        // The post-roll bonuses, as one line that sits above the balance they
        // went into rather than three fields trailing below it.
        const bonusBits = [];
        if (result.petYieldBonus > 0)     bonusBits.push(`🐠 Pet +${result.petYieldBonus.toLocaleString()} (${petFishYieldPct}%)`);
        if (result.featuredSpotBonus > 0) bonusBits.push(`🌟 Featured Spot +${result.featuredSpotBonus.toLocaleString()} (${Math.round(FEATURED_PAYOUT_BONUS * 100)}%)`);
        if (result.wildernessBonus > 0)   bonusBits.push(`🌲 Wilderness +${result.wildernessBonus.toLocaleString()} (${Math.round(WILDERNESS_YIELD_BONUS * 100)}%)`);
        if (bonusBits.length) {
            const bonusField = { name: '✨ Bonuses', value: bonusBits.join(' · '), inline: false };
            const balanceAt  = (embed.data.fields ?? []).findIndex(fl => fl.name === 'Balance');
            if (balanceAt >= 0) embed.spliceFields(balanceAt, 0, bonusField);
            else embed.addFields(bonusField);
        }
        if (winterHuntMaterial) {
            const matName = HUNT_MATERIAL_NAMES[winterHuntMaterial] ?? winterHuntMaterial;
            embed.addFields({ name: '❄️ Winter Hunt Event', value: `+1 ${matName} (hunt material found in icy waters!)`, inline: true });
        }
        if (worldRecord?.set) {
            const prev = worldRecord.previous;
            embed.addFields({
                name: '🌍 New Server Record!',
                value: prev
                    ? `Heaviest **${result.fish.name}** on this server — **${result.weightLbs} lbs**, beating ${prev.username ?? 'the old record'}'s ${prev.weight} lbs.`
                    : `The first **${result.fish.name}** ever weighed on this server — **${result.weightLbs} lbs**. Beat that.`,
                inline: false,
            });
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

        // Weekly champion race footer. Fish accumulates rarity tiers rather
        // than coins, so the number is a score and is named as one.
        const leaderNote = weeklyLeader
            ? `👑 Week leader: ${weeklyLeader.username} (${(weeklyLeader.total ?? 0).toLocaleString()} pts)`
            : '👑 No Angler of the Week yet';
        const existingFooter = embed.data.footer?.text ?? '';
        embed.setFooter({ text: existingFooter ? `${existingFooter} · ${leaderNote}` : leaderNote });

        // Annotate embed with rarity reel-in result
        if (reelResult) {
            const desc = embed.data.description ?? '';
            embed.setDescription(desc + `\n> ${reelResult.icon} *${reelResult.label}*`);
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

        // The base catch's big-win log — a boss fight below logs its own bonus
        // separately, and must not swallow this one.
        if (result.success) {
            const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
            if (result.finalPayout >= bigWinThreshold || ['legendary', 'event'].includes(result.tier)) {
                logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: result.finalPayout, source: 'fish', details: { itemName: result.fish?.name, rarity: result.tier }, client: interaction.client });
            }
        }

        // Staged loot reveal for rare+ drops. A boss fight opens on top of the
        // revealed catch, so it gets the reveal too. The buttons ride the final
        // render only, so nothing can be pressed under the fog; a boss fight
        // follows instead of them when one triggers, and arms them when it ends.
        const components = result.bossEncounter ? [] : buildResultActions(release);
        await stagedLootReveal(interaction, result.success ? result.tier : null, [...lead, embed], 'fish', catchFiles, { components });

        announceRareCatch(interaction, guildSettings, result, location);
        announceServerRecord(interaction, guildSettings, result, worldRecord);

        // Boss encounter — multi-phase fight, fought over the revealed catch.
        if (result.bossEncounter) {
            await runBossFight({
                interaction, reelMsg, embed, lead, cardArgs: card ? cardArgs : null, catchFiles,
                result, location, guildSettings, currency, release,
            });
        }
        await attachResultActions(interaction, { locationId });
        return { started: true };
    } catch (err) {
        if (!castCommitted) await releaseFishClaim();
        throw err;
    }
}

// Epic-and-above catches are posted to the server (or its announcement
// channel). Fire-and-forget: a failed post never touches the cast.
function announceRareCatch(interaction, guildSettings, result, location) {
    if (!result.success || !['epic', 'legendary', 'event'].includes(result.tier)) return;
    if (guildSettings?.economy?.announceRareDrops === false) return;

    const announceChannelId = guildSettings?.economy?.announcementChannelId;
    const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
    const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
    if (!announceChannel) return;
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
                content: `You don't have a rod equipped! Buy one with \`/fish shop rod\` and equip it with \`/fish equip 1\`.`,
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

// A catch that takes a server record off another player is news worth posting.
// A first-ever record for a species is not — early on that is most catches —
// and neither is beating your own. Fire-and-forget, like the catch post.
function announceServerRecord(interaction, guildSettings, result, worldRecord) {
    const prev = worldRecord?.set ? worldRecord.previous : null;
    if (!prev || !prev.userId || prev.userId === interaction.user.id) return;
    if (guildSettings?.economy?.announceRareDrops === false) return;

    const announceChannelId = guildSettings?.economy?.announcementChannelId;
    const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
    const channel = resolved?.isTextBased() ? resolved : interaction.channel;
    if (!channel) return;

    channel.send({
        embeds: [new EmbedBuilder()
            .setColor('#45a6ec')
            .setTitle('🌍 Server Record Broken!')
            .setDescription(
                `<@${interaction.user.id}> landed a **${result.weightLbs} lbs** ${result.fish.emoji} **${result.fish.name}** — ` +
                `the heaviest this server has ever seen.\n\n` +
                `The old record, **${prev.weight} lbs**, belonged to <@${prev.userId}>. Time to take it back.`
            )
            .setTimestamp()],
        allowedMentions: { users: [interaction.user.id] },
    }).catch(() => null);
}

// ─── World Records ────────────────────────────────────────────────────────────

/**
 * Records `weight` as the server's heaviest `fish` if it beats the standing
 * record, or if there is none. Both writes are conditional on the record still
 * being beatable at write time, so two catches racing each other can neither
 * push a duplicate entry for the species nor let a lighter fish overwrite a
 * heavier one that landed a moment earlier. A record weighed on an older weight
 * table (FISH_WEIGHT_SCALE) is not comparable, so any new catch replaces it.
 *
 * Returns { set: true, previous, record } when this catch set the record —
 * `previous` is the record it beat, or null when there was none on this scale —
 * and { set: false, previous: null, record } when it did not, `record` being the
 * standing record the catch fell short of (null if it cannot be read).
 */
async function checkAndUpdateWorldRecord(guildId, { fish, weight, userId, username }) {
    const entry = { fish, weight, userId, username, date: new Date(), scale: FISH_WEIGHT_SCALE };

    const beaten = await Guild.findOneAndUpdate(
        {
            guildId,
            fishingWorldRecords: { $elemMatch: { fish, $or: [{ weight: { $lt: weight } }, { scale: { $ne: FISH_WEIGHT_SCALE } }] } },
        },
        { $set: { 'fishingWorldRecords.$': entry } },
        { new: false, projection: { fishingWorldRecords: { $elemMatch: { fish } } } }
    ).lean();
    if (beaten) {
        const old = beaten.fishingWorldRecords?.[0] ?? null;
        return { set: true, previous: old?.scale === FISH_WEIGHT_SCALE ? old : null, record: entry };
    }

    const first = await Guild.updateOne(
        { guildId, 'fishingWorldRecords.fish': { $ne: fish } },
        { $push: { fishingWorldRecords: entry } }
    );
    if (first.modifiedCount > 0) return { set: true, previous: null, record: entry };

    // Not a record: read the one that stands, for the catch card to measure
    // against. Positional projection — narrower than the cached settings copy.
    const standing = await Guild.findOne(
        { guildId, 'fishingWorldRecords.fish': fish },
        { 'fishingWorldRecords.$': 1 }
    ).lean().catch(() => null);
    return { set: false, previous: null, record: standing?.fishingWorldRecords?.[0] ?? null };
}

module.exports = {
    checkAndUpdateWorldRecord,
    handleCast,
    replyCastPreflightFailure,
};
