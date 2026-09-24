'use strict';

// /mine dig — the intensity prompt, the vein read, the roll itself, and the
// staged reveal of what came out of the rock.

const { TIER_NUM, TIER_STARS } = require('../../../data/materialRarity');
const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const User = require('../../../models/User');
const {
    prepareDigUser,
    validateDigPreflight,
    claimDigCooldown,
    surveyRock,
    riskAt,
    digIntensity,
    promoteIntensity,
    executeMine,
    blastClearCaveIn,
    digOutCaveIn,
    abandonCaveIn,
    keptFind,
    applyDigBonuses,
    updateMineQuestProgress,
    updateMineMap,
    commitDig
} = require('../../../services/mineService');
const { buildCooldownEmbed } = require('../../../utils/cooldownEmbed');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS } = require('../../../data/featuredRotation');
const { getTimeBand } = require('../../../utils/timeBand');
const {
    LIMITS, CHOOSABLE_INTENSITY, DEFAULT_INTENSITY_LEVEL, PICKAXE_BY_TIER, CAVE_IN_DIG_OUT_STAMINA,
} = require('../../../data/mineData');
const { WILDERNESS_YIELD_BONUS } = require('../../../data/crossSystemData');
const { isDistrictActive } = require('../../../services/districtService');
const { refundEffectCharge } = require('../../../services/effectsService');
const { ensureQuests, onMine, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../../services/questService');
const { recordMissionProgress } = require('../../../services/seasonMissionService');
const { checkAndAward, announceAchievements } = require('../../../services/achievementService');
const { isVersionError } = require('../../../utils/versionRetry');
const { logBigWin } = require('../../../utils/bigWinLogger');
const { addWeeklyChampionProgress, getWeeklyChampionLeader } = require('../../../utils/weeklyChampion');
const { randomFrom, MINE_CAVE_LINES } = require('../../../utils/copyLines');
const { PITY_COPY } = require('../../../utils/pityBonus');
const { buildMineEmbed } = require('./embeds');
const { ownedBy } = require('../../../utils/collectorOwner');
const { stagedLootReveal } = require('../../../utils/stagedLootReveal');
const { attachResultThumbnail } = require('../../../utils/itemImageHelper');
const { gatherPayoutKey } = require('../../../utils/payoutKey');

// Presentation timings for the pre-dig prompt and the cave-in choice. The ladder,
// the survey and the promotion rule live with the rest of the mine's rules, in
// mineData and mineService.
const INTENSITY_PICK_MS = 20_000;

const CAVE_IN_DECIDE_MS = 20_000;

// ─── DIG ──────────────────────────────────────────────────────────────────────

async function handleDig(interaction) {
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

    await prepareDigUser(user);
    const m = user.mining;

    // ── Preflight (read-only; the cooldown slot is claimed atomically below) ──
    const requestedDepth = interaction.options.getString('depth');
    const preflight = validateDigPreflight(user, requestedDepth);
    if (!preflight.ok) {
        return replyDigPreflightFailure(interaction, preflight);
    }
    const { depthId, depth, pickaxe, pickaxeData } = preflight;

    // Atomically claim the cooldown slot now that all preflight checks have
    // passed — see mineService.claimDigCooldown for the guarantees.
    const claim = await claimDigCooldown(user);
    if (!claim.claimed) {
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '⛏️ Catching Your Breath',
                description: 'You just came up from a dig.\nTake a short break before heading back down.',
                color: '#b5651d',
                nextAt: claim.nextAt,
            })],
            flags: MessageFlags.Ephemeral,
        });
    }
    const releaseMineClaim = claim.release;

    // Everything between here and the save can still fail — a Discord API error
    // while collecting the vein prompts, a service throwing — and until the result
    // is persisted the player has nothing to show for the cooldown they just paid
    // for. Hand the slot back on the way out unless the dig committed.
    let mineCommitted = false;

    // Everything below runs across the interactive prompts, during which the
    // player can spend coins elsewhere. The run's own coin movement is
    // collected as a delta against this reading and applied as an atomic
    // `$inc` at the save, so `save()` never writes an absolute balance read
    // before that window. See src/utils/balanceDelta.js.
    const balanceAtLoad = user.balance ?? 0;

    try {

        // The charge comes out only once the cooldown slot is ours, so a lost race
        // never costs the player a charge.
        if (pickaxeData.requiresCharge) {
            m.charges[pickaxeData.chargeType] = (m.charges[pickaxeData.chargeType] ?? 0) - 1;
            user.markModified('mining');
        }

        // Digging an explicit depth makes it your active depth. Without this it only
        // ever moved when you unlocked something, so /mine profile and /mine map kept
        // reporting a depth you had long since stopped digging.
        if (requestedDepth && m.activeDepth !== depthId) {
            m.activeDepth = depthId;
            user.markModified('mining');
        }

        // ── Read the rock, then choose how hard to push ────────────────────────────
        // The lamp reads the face before the miner commits: how rich the seam is
        // (exact — it lifts the payout) and how sound the rock is (a read that can be
        // wrong — it scales the cave-in risk). The intensity choice is made against
        // that reading, so the right answer changes from dig to dig.
        //
        // This replaced a vein read that flashed the answer for 1.4s and asked for it
        // back: anyone watching got it right, so it promoted nearly every dig, and a
        // slow client could swallow the flash entirely.

        const featured         = getDailyFeatured(interaction.guild.id);
        const isFeaturedDepth  = depthId === featured.mineDepth.id;
        const timeBand         = getTimeBand();
        const survey           = surveyRock(user);

        const featuredDepthNote = isFeaturedDepth
            ? `\n🌟 **Featured Depth!** +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% payout active.`
            : '';

        // Pushing hard for coins that the daily throttle will swallow is all risk and
        // no reward, so say so before the choice rather than after the cave-in.
        const throttleWarning =
            m.dailyCoins >= LIMITS.DAILY_HARD_CAP
                ? `\n🛑 **Daily cap reached** — this dig pays no coins. Cave-in risk is still real.`
                : m.dailyCoins >= LIMITS.DAILY_SOFT_CAP
                ? `\n⚠️ Past the daily soft cap — payouts are halved until it resets.`
                : '';

        const surveyText = describeSurvey(survey, pickaxe.name);

        // ── How hard to push ───────────────────────────────────────────────────────
        const requestedIntensity = interaction.options.getInteger('intensity');
        let pickedIntensity = CHOOSABLE_INTENSITY.find(l => l.level === requestedIntensity) ?? null;

        const fallbackLevel = CHOOSABLE_INTENSITY.find(l => l.level === (m.preferredIntensity ?? DEFAULT_INTENSITY_LEVEL))
            ?? CHOOSABLE_INTENSITY.find(l => l.level === DEFAULT_INTENSITY_LEVEL);

        const intensityRow = new ActionRowBuilder().addComponents(
            ...CHOOSABLE_INTENSITY.map(l => new ButtonBuilder()
                .setCustomId(`digint_${l.level}`)
                .setLabel(intensityButtonLabel(l, survey))
                .setEmoji(l.emoji)
                .setStyle(l.level >= 4 ? ButtonStyle.Danger : l.level === 3 ? ButtonStyle.Primary : ButtonStyle.Secondary)
            )
        );

        if (!pickedIntensity) {
            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(isFeaturedDepth ? '#FFD700' : '#8B4513')
                    .setTitle(`⛏️ ${depth.emoji} ${depth.name} — read the rock`)
                    .setDescription(
                        `*Your lamp plays across the face…*\n\n${surveyText}\n\n` +
                        `**How hard do you want to push?** Risk shown is for the rock as you read it.` +
                        featuredDepthNote + throttleWarning
                    )
                    .setFooter({ text: `${timeBand.emoji} ${timeBand.label} · ${INTENSITY_PICK_MS / 1000}s to choose — defaults to ${fallbackLevel.name}. Pass intensity: to dig blind.` })],
                components: [intensityRow],
            });
            const promptMsg = await interaction.fetchReply();

            const chosenId = await new Promise(resolve => {
                const col = promptMsg.createMessageComponentCollector({
                    filter: ownedBy(interaction.user.id, i => i.customId.startsWith('digint_'), "This isn't your dig."),
                    time: INTENSITY_PICK_MS,
                    max: 1,
                });
                col.on('collect', async i => { await i.deferUpdate().catch(() => {}); resolve(i.customId); });
                col.on('end', (_, reason) => { if (reason !== 'limit') resolve(null); });
            });
            pickedIntensity = CHOOSABLE_INTENSITY.find(l => `digint_${l.level}` === chosenId) ?? fallbackLevel;
        }

        const chosenIntensity = digIntensity(pickedIntensity, survey);

        // One swing beat: the prompt's buttons come off, or — with `intensity:`
        // passed — this is the first thing the player sees.
        const swingEmbed = new EmbedBuilder()
            .setColor('#8B4513')
            .setTitle(`${pickedIntensity.emoji} Digging ${pickedIntensity.name} in ${depth.emoji} ${depth.name}…`)
            .setDescription(`${surveyText}${featuredDepthNote}${throttleWarning}`);
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({ embeds: [swingEmbed], components: [] });
        } else {
            await interaction.reply({ embeds: [swingEmbed] });
        }

        // Remembered so the timeout default is the miner's own habit, not ours.
        if (m.preferredIntensity !== pickedIntensity.level) {
            m.preferredIntensity = pickedIntensity.level;
            user.markModified('mining');
        }

        // Crystal Fox pet: +15% mine yield (only if hunger >= 30)
        const { getTotalBonus, petCompanionLine, tryGrantRarePet } = require('../../../services/petService');
        const petMineYieldPct = getTotalBonus(user.pets || [], 'mine_yield');

        const marketplaceActive = isDistrictActive(guildSettings, 'marketplace');
        const result = executeMine(user, depthId, { intensity: chosenIntensity, marketplaceActive });
        result.survey = survey;

        // ── Cave-in Interactive Event ─────────────────────────────────────────────
        // Resolved FIRST: pity, find counters, and yield bonuses below must only
        // apply to rewards the player actually keeps, not ore abandoned in a collapse.
        if (result.caveIn) {
            const m = user.mining;
            const equippedPickaxe = m.pickaxes?.[m.equippedPickaxeIndex];
            const pickaxeStaticData = equippedPickaxe ? PICKAXE_BY_TIER[equippedPickaxe.tier] : null;
            const chargeType = pickaxeStaticData?.chargeType;
            const chargesAvailable = chargeType ? (m.charges?.[chargeType] ?? 0) : 0;
            const blastCost = Math.max(1, chosenIntensity.blastCost ?? 1);
            const canBlast  = chargesAvailable >= blastCost;
            const canDigOut = (m.stamina ?? 0) >= CAVE_IN_DIG_OUT_STAMINA;
            const orePayout = result.caveInPayout ?? 0;
            const escrow    = result.caveInEscrow ?? 0;

            const options = [
                canBlast
                    ? `💥 **Blast clear** — ${blastCost} charge${blastCost === 1 ? '' : 's'} (you have ${chargesAvailable}). Keeps all **${(orePayout + escrow).toLocaleString()}** coins.`
                    : chargeType
                    ? `💥 ~~Blast clear~~ — needs ${blastCost} charge${blastCost === 1 ? '' : 's'}, you have ${chargesAvailable}.`
                    : `💥 ~~Blast clear~~ — your ${pickaxe.name} takes no charges.`,
                canDigOut
                    ? `⛏️ **Dig out** — ${CAVE_IN_DIG_OUT_STAMINA} stamina (you have ${m.stamina}). Keeps the ore's **${orePayout.toLocaleString()}**` +
                      (escrow > 0 ? `, loses the ${escrow.toLocaleString()} ${chosenIntensity.name} bonus.` : '.')
                    : `⛏️ ~~Dig out~~ — needs ${CAVE_IN_DIG_OUT_STAMINA} stamina, you have ${m.stamina}.`,
                `🏃 **Flee** — keep your skin, lose the haul.`,
            ];

            const caveInEmbed = new EmbedBuilder()
                .setColor('#8B0000')
                .setTitle('🌑 CAVE-IN!')
                .setDescription(
                    `The tunnel is collapsing around you. Dust fills the air.\n` +
                    `⚡ **At stake:** ${(orePayout + escrow).toLocaleString()} coins of ${result.ore?.emoji ?? ''} ${result.ore?.name ?? 'ore'}\n\n` +
                    options.join('\n')
                )
                .setFooter({ text: canBlast
                    ? `${CAVE_IN_DECIDE_MS / 1000}s to decide — if you freeze, you blast clear.`
                    : `${CAVE_IN_DECIDE_MS / 1000}s to decide — if you freeze, you flee.` });

            const caveInId = `cavein_${interaction.id}`;
            const caveInRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`${caveInId}_blast`)
                    .setLabel(`💥 Blast (${blastCost})`)
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(!canBlast),
                new ButtonBuilder()
                    .setCustomId(`${caveInId}_digout`)
                    .setLabel(`⛏️ Dig out (${CAVE_IN_DIG_OUT_STAMINA} stamina)`)
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(!canDigOut),
                new ButtonBuilder()
                    .setCustomId(`${caveInId}_abandon`)
                    .setLabel('🏃 Flee')
                    .setStyle(ButtonStyle.Danger),
            );

            await interaction.editReply({ embeds: [caveInEmbed], components: [caveInRow] });
            const caveInMsg = await interaction.fetchReply();

            const caveInChoice = await new Promise(resolve => {
                const col = caveInMsg.createMessageComponentCollector({
                    filter: ownedBy(interaction.user.id, i => i.customId.startsWith(caveInId), "This isn't your dig."),
                    time: CAVE_IN_DECIDE_MS,
                    max: 1,
                });
                col.on('collect', async i => {
                    await i.deferUpdate().catch(() => {});
                    resolve(i.customId.slice(caveInId.length + 1));
                });
                // A timeout takes the choice a player holding enough charges would
                // make — a notification should not cost them a haul they could have
                // saved. It never spends stamina they did not agree to spend.
                col.on('end', (_, reason) => { if (reason !== 'limit') resolve(canBlast ? 'blast' : 'abandon'); });
            });

            // Strip the buttons as soon as the choice is locked in, the same way the
            // hunt stealth prompt does — the final result edit only sets embeds, so
            // leaving them here would keep dead buttons under the finished dig.
            await interaction.editReply({ components: [] }).catch(() => {});

            if (caveInChoice === 'blast' && canBlast) {
                blastClearCaveIn(user, result, chargeType, blastCost);
            } else if (caveInChoice === 'digout' && canDigOut) {
                digOutCaveIn(user, result, CAVE_IN_DIG_OUT_STAMINA);
            } else {
                abandonCaveIn(user, result, { refundEffectCharge });
            }
        }

        // Pity counter, featured-depth / pet / Wilderness bonuses, forfeited
        // scaling and best payout — the full post-roll bonus stack.
        applyDigBonuses(user, result, {
            isFeaturedDepth,
            featuredPayoutBonus: FEATURED_PAYOUT_BONUS,
            petMineYieldPct,
            wildernessActive: isDistrictActive(guildSettings, 'wilderness'),
            intensityMultiplier: chosenIntensity?.multiplier ?? 1,
        });

        updateMineQuestProgress(user, result, depthId);

        // Update the persistent mine map with this dig's result
        updateMineMap(user, result);

        await ensureQuests(user, guildSettings);
        const { completed: questsDone, nearComplete: questsNear } = await onMine(user, guildSettings);
        // Season pass daily missions listen for the same actions quests do.
        recordMissionProgress(user, 'mine', 1, guildSettings);
        if (result.success && result.finalPayout > 0) {
            const earn = await onEconomyEarn(user, guildSettings, result.finalPayout);
            questsDone.push(...earn.completed);
            questsNear.push(...earn.nearComplete);
        }

        // Rare companions are found, not bought: a legendary result is the only
        // thing that can turn one up. Rolled before the save below persists it.
        // An abandoned haul was never brought up, so it cannot turn one up either.
        const kept = keptFind(result);
        const rarePetDrop = kept
            ? tryGrantRarePet(user, 'mine', result.tier)
            : null;
        if (rarePetDrop) user.markModified('pets');

        const mineAchievements = await checkAndAward(user, guildSettings).catch(() => []);

        // Persist and credit through the service. A path that reverses its own
        // reward nets to zero and issues no coin write.
        let payoutOwed = 0;
        try {
            ({ payoutOwed } = await commitDig(user, balanceAtLoad, {
                payoutKey: gatherPayoutKey('mine', interaction.id, 'run'),
            }));
            mineCommitted = true;
            if (mineAchievements.length) {
                announceAchievements(interaction.client, guildSettings, user, interaction.member, mineAchievements).catch(() => null);
            }
            notifyQuestComplete(guildSettings, interaction.member, questsDone, interaction.channel, user).catch(() => null);
            notifyQuestNearComplete(guildSettings, interaction.member, questsNear, interaction.channel).catch(() => null);
        } catch (err) {
            // Nothing was saved, so give the cooldown slot back before telling them to retry.
            await releaseMineClaim();
            if (isVersionError(err)) {
                return interaction.editReply({ content: 'A simultaneous request conflicted with your mine. Please try `/mine dig` again.', embeds: [], components: [] });
            }
            console.error('[mine] save error:', err);
            return interaction.editReply({ content: 'Something went wrong saving your mine. Please try again.', embeds: [], components: [] });
        }

        // Log big win, then await the weekly tally update and re-fetch for accurate footer
        if (result.success && result.finalPayout > 0) {
            const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
            if (result.finalPayout >= bigWinThreshold || ['legendary', 'event'].includes(result.tier)) {
                logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: result.finalPayout, source: 'mine', details: { itemName: result.ore?.name, rarity: result.tier }, client: interaction.client });
            }
            await addWeeklyChampionProgress({ guildId: interaction.guild.id, category: 'mine', userId: interaction.user.id, username: interaction.user.username, value: result.finalPayout, details: result.ore ? `${result.ore.emoji ?? ''} ${result.ore.name} (${currency}${result.finalPayout.toLocaleString()})`.trim() : `${currency}${result.finalPayout.toLocaleString()}` }).catch(() => null);
        }
        const weeklyLeader = await getWeeklyChampionLeader(interaction.guild.id, 'mine').catch(() => null);

        const embed = buildMineEmbed(result, user, depth, pickaxe, currency, interaction.user);

        if (payoutOwed > 0) {
            embed.addFields({
                name: '⚠️ Payout Not Yet Credited',
                value: `The **${currency}${payoutOwed.toLocaleString()}** from this haul could not be paid out just now and has been recorded as owed — the balance shown below does not include it. It will be applied once the problem clears; tell an admin if it does not.`,
            });
        }
        {
            const desc = embed.data.description ?? '';
            embed.setDescription(desc + '\n' + digSummaryLines(result, pickedIntensity, chosenIntensity, survey).join('\n'));
        }
        if (result.featuredDepthBonus > 0) {
            embed.addFields({ name: '🌟 Featured Depth Bonus', value: `+${result.featuredDepthBonus.toLocaleString()} coins (+${Math.round(FEATURED_PAYOUT_BONUS * 100)}%)`, inline: true });
        }
        if (result.petYieldBonus > 0) {
            embed.addFields({ name: '💎 Pet Bonus', value: `+${result.petYieldBonus.toLocaleString()} coins (${petMineYieldPct}% yield)`, inline: true });
        }
        if (result.wildernessBonus > 0) {
            embed.addFields({ name: '🌲 Wilderness District', value: `+${result.wildernessBonus.toLocaleString()} coins (+${Math.round(WILDERNESS_YIELD_BONUS * 100)}% yield)`, inline: true });
        }

        // Weekly champion race footer
        const leaderNote = weeklyLeader
            ? `👑 Miner of the Week so far: ${weeklyLeader.username} — ${(weeklyLeader.total ?? 0).toLocaleString()} coins mined`
            : '👑 No Miner of the Week yet — be the first!';
        const existingFooter = embed.data.footer?.text ?? '';
        embed.setFooter({ text: existingFooter ? `${existingFooter} · ${timeBand.emoji} ${timeBand.label} · ${leaderNote}` : `${timeBand.emoji} ${timeBand.label} · ${leaderNote}` });

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

        // Pet narrative: the companion helping with this activity says its line.
        const petLine = kept ? petCompanionLine(user.pets, 'mine') : null;
        if (petLine) embed.setDescription(`${embed.data.description ?? ''}\n${petLine}`);

        // Result artwork — the mined ore's icon as the embed thumbnail (emoji
        // fallback). An abandoned haul shows no ore art, gets no staged reveal and
        // is not announced: fanfare for ore left behind in a collapse reads as a
        // find the player does not have.
        const oreFiles = kept
            ? await attachResultThumbnail(embed, 'mine', result.ore, interaction.guild.id)
            : [];

        // Staged loot reveal for rare+ drops
        await stagedLootReveal(interaction, kept ? result.tier : null, embed, 'mine', oreFiles);

        if (kept && ['epic', 'legendary', 'event'].includes(result.tier) && guildSettings?.economy?.announceRareDrops !== false) {
            const announceChannelId = guildSettings?.economy?.announcementChannelId;
            const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
            const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
            const announceTier = TIER_NUM[result.tier] ?? 4;
            const ANNOUNCE_COPY = {
                4: { color: '#9c27b0', title: '🔮 Epic Ore Unearthed!',      line: 'A rare find in these tunnels.' },
                5: { color: '#ff9800', title: '✨ Legendary Strike! ✨',      line: 'That vein runs deep — and dangerous.' },
                6: { color: '#e74c3c', title: '☄️ Primordial Strike! ☄️',    line: 'Ore like this is not supposed to exist. The whole server should know.' },
            };
            const copy = ANNOUNCE_COPY[announceTier] ?? ANNOUNCE_COPY[4];
            const announcementEmbed = new EmbedBuilder()
                .setColor(copy.color)
                .setTitle(copy.title)
                .setDescription(
                    `<@${interaction.user.id}> just unearthed ${result.ore.emoji} **${result.ore.name}** [${TIER_STARS[announceTier]}]\n` +
                    `at the **${depth.name}** depth.\n\n` +
                    copy.line
                )
                .setTimestamp();
            announceChannel.send({ embeds: [announcementEmbed] }).catch(() => null);
        }

        // Catastrophic cave-in server announcement: a Deep dig that lost both the
        // haul and the pickaxe. Blasting clear saved the ore, so that one is not a
        // catastrophe worth the channel's attention.
        if (result.caveIn && result.caveInAbandoned && result.pickaxeBroke && chosenIntensity.level >= 4 && guildSettings?.economy?.announceRareDrops !== false) {
            const announceChannelId = guildSettings?.economy?.announcementChannelId;
            const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
            const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
            const caveEmbed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle('💥 Catastrophic Cave-in!')
                .setDescription(
                    `<@${interaction.user.id}> just suffered a **catastrophic cave-in** in ${depth.emoji} **${depth.name}**, digging ${chosenIntensity.emoji} **${chosenIntensity.name}**!\n` +
                    `The haul is buried and their **${pickaxe.name}** broke in the collapse.\n\n` +
                    `*Others are warned: the tunnel grows less stable the deeper you go.*`
                )
                .setTimestamp();
            announceChannel.send({ embeds: [caveEmbed] }).catch(() => null);
        }
    } catch (err) {
        if (!mineCommitted) await releaseMineClaim();
        throw err;
    }
}

/**
 * The quoted lines under a result: what the miner chose, what the seam paid,
 * what the rock really was against what they read, and how a cave-in ended.
 */
function digSummaryLines(result, picked, chosen, survey) {
    const seamPart = chosen.promoted
        ? ` on a ${survey.seam.name.toLowerCase()} (up from ${picked.multiplier}×)`
        : ` on a ${survey.seam.name.toLowerCase()}`;
    const misread = survey.read.id !== survey.stability.id ? ` — you read ${survey.read.name.toLowerCase()}` : '';
    const lines = [
        `> ${picked.emoji} *Dug **${picked.name}** — ${chosen.multiplier}×${seamPart} · ` +
        `${survey.stability.emoji} ${survey.stability.name}${misread} · ${pct(chosen.caveInRisk)} risk*`,
    ];
    if (result.caveIn && result.caveInDugOut) {
        lines.push(result.caveInEscrowLost > 0
            ? `> ⛏️ *Cave-in! You dug out by hand (${result.caveInStaminaSpent} stamina) — the ore came with you, the ${result.caveInEscrowLost.toLocaleString()}-coin ${picked.name} bonus stayed buried.*`
            : `> ⛏️ *Cave-in! You dug out by hand (${result.caveInStaminaSpent} stamina) — ore saved.*`);
    } else if (result.caveIn && result.caveInEscaped) {
        const charges = `${result.caveInChargesSpent} charge${result.caveInChargesSpent === 1 ? '' : 's'}`;
        lines.push(result.caveInBonusPaid > 0
            ? `> 💥 *Cave-in! You blasted clear (${charges}) — ore saved, and the ${chosen.multiplier}× held.*`
            : `> 💥 *Cave-in! You blasted clear (${charges}) — ore saved.*`);
    } else if (result.caveIn) {
        lines.push(`> 💥 *${randomFrom(MINE_CAVE_LINES)}*`);
    }
    return lines;
}

/** Percent, rounded, for display. */
const pct = x => `${Math.round(x * 100)}%`;

/**
 * The lamp's reading as the miner sees it: the seam exactly, the stability as
 * read, and how far the read can be trusted with this pickaxe.
 */
function describeSurvey(survey, pickaxeName) {
    const { seam, read, accuracy } = survey;
    const seamNote = seam.promote > 0
        ? ` — pays **${seam.promote === 1 ? 'one rung' : 'two rungs'} higher** at the same risk`
        : ' — no bonus';
    const riskNote = read.riskMult === 1 ? 'normal cave-in risk' : `cave-in risk ×${read.riskMult}`;
    return `${seam.emoji} **${seam.name}**${seamNote}
` +
           `${read.emoji} **${read.name}** — ${riskNote} *(your ${pickaxeName} reads rock right ${pct(accuracy)} of the time)*`;
}

/**
 * A rung's button: the payout it would pay on this seam and the risk on the rock
 * as read. Discord caps labels at 80 characters; these stay well under.
 */
function intensityButtonLabel(level, survey) {
    const pays = promoteIntensity(level, survey.seam.promote).multiplier;
    const risk = riskAt(level, survey.read);
    return `${level.name} · ${pays}× · ${risk > 0 ? `~${pct(risk)}` : 'no'} risk`;
}

// Renders a failed dig preflight (mineService.validateDigPreflight) as the
// reply the player sees. Pure presentation — every check lives in the service.
function replyDigPreflightFailure(interaction, preflight) {
    const ephemeral = { flags: MessageFlags.Ephemeral };
    switch (preflight.reason) {
        case 'unknown_depth':
            return interaction.reply({ content: `Unknown depth \`${preflight.depthId}\`. Use \`/mine shop list\` to see available depths.`, ...ephemeral });
        case 'depth_locked': {
            const gate = preflight.depth.defaultUnlocked
                ? ''
                : ` (Miner Level ${preflight.depth.unlockLevel}, ${preflight.depth.unlockCost.toLocaleString()} coins)`;
            return interaction.reply({
                content: `You haven't unlocked **${preflight.depth.name}** yet. Use \`/mine shop unlock\` to unlock it${gate}.`,
                ...ephemeral
            });
        }
        case 'injured':
            return interaction.reply({
                embeds: [buildCooldownEmbed({
                    title: '🤕 Still Pinned',
                    description: "That slab did a number on your leg. Rest up before heading back underground.",
                    color: '#b5651d',
                    nextAt: preflight.nextAt,
                })],
                ...ephemeral,
            });
        case 'cooldown':
            // The miner picks the intensity; a correct vein read pays one rung above it.
            return interaction.reply({
                embeds: [buildCooldownEmbed({
                    title: '⛏️ Catching Your Breath',
                    description: 'You just came up from a dig.\nTake a short break before heading back down.',
                    color: '#b5651d',
                    nextAt: preflight.nextAt,
                    nextRewardPreview: 'Read the rock, then pick how hard to push — a rich seam pays up to 3×',
                })],
                ...ephemeral,
            });
        case 'no_stamina': {
            // Report the fail-streak pity that actually exists, through the shared
            // curve so this cannot drift from what calculateSuccessChance applies.
            // Mining has no rare-material guarantee — only hunting implements one —
            // so sinceRare is reported as the stat it is.
            const pityBits = [];
            if (preflight.pityBonus > 0) {
                pityBits.push(`🎯 ${preflight.consecutiveFails} ${PITY_COPY.mining.streakNoun} • +${Math.round(preflight.pityBonus * 100)}% success on your next dig`);
            }
            if (preflight.sinceRare >= 5) pityBits.push(`⛏️ ${preflight.sinceRare} digs since your last Rare+ material`);
            return interaction.reply({
                embeds: [buildCooldownEmbed({
                    title: '😮‍💨 Out of Stamina',
                    description: "You've dug yourself to exhaustion.\nBuy an **Energy Tonic** from `/mine shop` to recover faster.",
                    color: '#b5651d',
                    nextAt: preflight.nextAt,
                    pityStat: pityBits.length ? pityBits.join('\n') : null,
                    // Stamina buys swings, not luck: tier odds come from the depth you
                    // dig, your pickaxe and an active magnet. Don't imply otherwise.
                    nextRewardPreview: 'Deeper depths, a better pickaxe and an Ore Magnet are what move your rare odds',
                })],
                ...ephemeral,
            });
        }
        case 'no_pickaxe':
            return interaction.reply({
                content: `You don't have a pickaxe equipped! Buy one with \`/mine shop pickaxe\` and equip it with \`/mine equip 1\`.`,
                ...ephemeral
            });
        case 'pickaxe_broken':
            return interaction.reply({
                content: `Your **${preflight.pickaxe.name}** is broken! Repair it with \`/mine shop repair\` or buy a new one with \`/mine shop pickaxe\`.`,
                ...ephemeral
            });
        case 'no_charge':
            return interaction.reply({
                content: `You're out of **${preflight.pickaxeData.chargeType.replace(/_/g, ' ')}**! Buy more with \`/mine shop buy\`.`,
                ...ephemeral
            });
        default:
            return interaction.reply({ content: 'You cannot dig right now.', ...ephemeral });
    }
}

module.exports = {
    CAVE_IN_DECIDE_MS,
    INTENSITY_PICK_MS,
    describeSurvey,
    digSummaryLines,
    intensityButtonLabel,
    handleDig,
    replyDigPreflightFailure,
};
