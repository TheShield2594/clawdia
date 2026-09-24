'use strict';

// /fish cast — the roll itself, its staged reveal, and the world-record check
// a catch can trip.

const { TIER_NUM, TIER_STARS } = require('../../../data/materialRarity');
const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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
const { FISH_TIER_SCORE, awaitCasterClick } = require('./shared');
const { runBossFight } = require('./boss');
const { buildCastEmbed } = require('./embeds');
const { attachResultThumbnail } = require('../../../utils/itemImageHelper');
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
        // Common/Uncommon: passive (no button). Rare: optional single button (3s) — miss
        // downgrades to Uncommon payout. Epic: required (3s). Legendary: required (2s).
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
                    .setEmoji('🎣')
                    .setLabel(`Reel In! (${cfg.window / 1000}s)`)
                    .setStyle(cfg.required ? ButtonStyle.Danger : ButtonStyle.Primary)
            );

            const reel = awaitCasterClick(reelMsg, interaction.user.id, [reelId]);
            await interaction.editReply({ embeds: [biteEmbed], components: [reelRow] });
            reel.start(cfg.window);
            const reelPressed = (await reel.choice) !== null;

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
                    downgradeOptionalMiss(user, result, preCastSnapshot);
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
        // stamina, durability and cooldown it cost. Nothing else to show.
        if (result.escaped) return;

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

        // Result artwork — the caught fish's icon as the embed thumbnail (emoji
        // fallback). Threaded through every render of this embed, boss phases
        // included, so the attachment rides with each one.
        const catchFiles = result.success && result.catchType === 'fish'
            ? await attachResultThumbnail(embed, 'fish', result.fish, interaction.guild.id)
            : [];

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
            embed.addFields({ name: '🌲 Wilderness District', value: `+${result.wildernessBonus.toLocaleString()} coins (+${Math.round(WILDERNESS_YIELD_BONUS * 100)}% yield)`, inline: true });
        }
        if (winterHuntMaterial) {
            const matName = HUNT_MATERIAL_NAMES[winterHuntMaterial] ?? winterHuntMaterial;
            embed.addFields({ name: '❄️ Winter Hunt Event', value: `+1 ${matName} (hunt material found in icy waters!)`, inline: true });
        }
        if (worldRecord) {
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
        let leaderNote;
        if (weeklyLeader) {
            leaderNote = `👑 Angler of the Week so far: ${weeklyLeader.username} — ${(weeklyLeader.total ?? 0).toLocaleString()} rarity score`;
        } else {
            leaderNote = '👑 No Angler of the Week yet — be the first!';
        }
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
        // revealed catch, so it gets the reveal too.
        await stagedLootReveal(interaction, result.success ? result.tier : null, embed, 'fish', catchFiles);

        announceRareCatch(interaction, guildSettings, result, location);

        // Boss encounter — multi-phase fight, fought over the revealed catch.
        if (result.bossEncounter) {
            await runBossFight({ interaction, reelMsg, embed, catchFiles, result, location, guildSettings, currency });
        }
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

// ─── World Records ────────────────────────────────────────────────────────────

/**
 * Records `weight` as the server's heaviest `fish` if it beats the standing
 * record, or if there is none. Both writes are conditional on the record still
 * being beatable at write time, so two catches racing each other can neither
 * push a duplicate entry for the species nor let a lighter fish overwrite a
 * heavier one that landed a moment earlier.
 *
 * Returns { previous } — the record that was beaten, or null for a first
 * record — when this catch set the record, and null when it did not.
 */
async function checkAndUpdateWorldRecord(guildId, { fish, weight, userId, username }) {
    const entry = { fish, weight, userId, username, date: new Date() };

    const beaten = await Guild.findOneAndUpdate(
        { guildId, fishingWorldRecords: { $elemMatch: { fish, weight: { $lt: weight } } } },
        { $set: { 'fishingWorldRecords.$': entry } },
        { new: false, projection: { fishingWorldRecords: { $elemMatch: { fish } } } }
    ).lean();
    if (beaten) return { previous: beaten.fishingWorldRecords?.[0] ?? null };

    const first = await Guild.updateOne(
        { guildId, 'fishingWorldRecords.fish': { $ne: fish } },
        { $push: { fishingWorldRecords: entry } }
    );
    return first.modifiedCount > 0 ? { previous: null } : null;
}

module.exports = {
    checkAndUpdateWorldRecord,
    handleCast,
    replyCastPreflightFailure,
};
