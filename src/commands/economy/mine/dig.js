'use strict';

// /mine dig — the intensity prompt, the vein read, the roll itself, and the
// staged reveal of what came out of the rock.

const { TIER_NUM, TIER_STARS } = require('../../../data/materialRarity');
const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Guild = require('../../../models/Guild');
const User = require('../../../models/User');
const {
    prepareDigUser,
    validateDigPreflight,
    claimDigCooldown,
    promoteIntensity,
    executeMine,
    applyDigBonuses,
    updateMineQuestProgress,
    updateMineMap,
    commitDig
} = require('../../../services/mineService');
const { buildCooldownEmbed } = require('../../../utils/cooldownEmbed');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS } = require('../../../data/featuredRotation');
const { getTimeBand } = require('../../../utils/timeBand');
const { LIMITS, CHOOSABLE_INTENSITY, DEFAULT_INTENSITY_LEVEL, PICKAXE_BY_TIER } = require('../../../data/mineData');
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

// Presentation timings for the pre-dig prompt and the vein read. The ladder itself
// and the promotion rule live with the rest of the mine's rules, in mineData and
// mineService.
const INTENSITY_PICK_MS = 20_000;

const VEIN_FLASH_MS     = 1_400;

const VEIN_ANSWER_MS    = 10_000;

// ─── Staged loot reveal for rare+ drops ──────────────────────────────────────
async function stagedLootReveal(interaction, tier, finalEmbed) {
    const tierNum = TIER_NUM[tier] ?? 0;
    if (tierNum < 3) {
        await interaction.editReply({ embeds: [finalEmbed] });
        return;
    }
    const wait = ms => new Promise(r => setTimeout(r, ms));

    const fogEmbed = new EmbedBuilder()
        .setColor('#4a4a4a')
        .setTitle('🌫️ Your pickaxe strikes something unusual...')
        .setDescription('━━━━━━━━━━━━━━━\n*The rock face glints in your lantern light.*\n━━━━━━━━━━━━━━━');

    if (tierNum === 3) {
        await interaction.editReply({ embeds: [fogEmbed] });
        await wait(1500);
    } else {
        await interaction.editReply({ embeds: [fogEmbed] });
        await wait(1500);
        const midColor = tierNum === 6 ? '#e74c3c' : tierNum === 4 ? '#9c27b0' : '#ff9800';
        const midTitle = tierNum === 6 ? '☄️ The rock itself begins to hum...' : tierNum === 4 ? '🔮 A rare vein reveals itself...' : '⚡ The tunnel fills with an impossible glow...';
        const midTierLabel = tierNum === 6 ? 'EVENT' : tierNum === 4 ? 'EPIC' : 'LEGENDARY';
        const midEmbed = new EmbedBuilder()
            .setColor(midColor)
            .setTitle(midTitle)
            .setDescription(`━━━━━━━━━━━━━━━\n❓❓❓  **${midTierLabel}**  ❓❓❓\n━━━━━━━━━━━━━━━`);
        await interaction.editReply({ embeds: [midEmbed] });
        await wait(1500);
        if (tierNum >= 5) {
            const isEvent = tierNum === 6;
            const fanfareEmbed = new EmbedBuilder()
                .setColor(isEvent ? '#e74c3c' : '#ff9800')
                .setTitle(isEvent ? '☄️ 🌋 𝗣 𝗥 𝗜 𝗠 𝗢 𝗥 𝗗 𝗜 𝗔 𝗟 🌋 ☄️' : '⚡ ✨ 𝗟 𝗘 𝗚 𝗘 𝗡 𝗗 𝗔 𝗥 𝗬 ✨ ⚡')
                .setDescription(isEvent ? '━━━━━━━━━━━━━━━\n*This ore has no business existing. Nobody will believe you.*\n━━━━━━━━━━━━━━━' : '━━━━━━━━━━━━━━━\n*Miners dream of this their whole careers.*\n━━━━━━━━━━━━━━━');
            await interaction.editReply({ embeds: [fanfareEmbed] });
            await wait(1500);
        }
    }
    await interaction.editReply({ embeds: [finalEmbed] });
}

// ─── DIG ──────────────────────────────────────────────────────────────────────

async function handleDig(interaction) {
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

        // ── Risk choice, then one vein read ────────────────────────────────────────
        // The miner picks how hard to push; a correct vein read promotes the payout
        // one rung without touching the risk they accepted.
        //
        // This replaced three rounds of a puzzle that displayed its own answer — the
        // grid marked the ore cell with ✨ and asked which direction it was, so every
        // attentive player scored 3/3 and every dig funnelled to Deep. The five-rung
        // risk ladder existed but nothing ever chose from it, and the only way to dig
        // more safely was to answer deliberately wrong, which nothing explained.

        const featured         = getDailyFeatured(interaction.guild.id);
        const isFeaturedDepth  = depthId === featured.mineDepth.id;
        const timeBand         = getTimeBand();
        const delay = ms => new Promise(r => setTimeout(r, ms));

        const DIRS = [
            { id: 'N', label: '⬆️ North', row: 0, col: 1 },
            { id: 'S', label: '⬇️ South', row: 2, col: 1 },
            { id: 'W', label: '⬅️ West',  row: 1, col: 0 },
            { id: 'E', label: '➡️ East',  row: 1, col: 2 },
        ];

        /** The 3×3 tunnel view. With `oreDir` the trace shows; without it, it doesn't. */
        function buildGrid(oreDir) {
            const grid = [
                ['🪨', '🪨', '🪨'],
                ['🪨', '⛏️', '🪨'],
                ['🪨', '🪨', '🪨'],
            ];
            if (oreDir) {
                const d = DIRS.find(d => d.id === oreDir);
                grid[d.row][d.col] = '✨';
            }
            return grid.map(row => row.join(' ')).join('\n');
        }

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

        // ── 1. How hard to push ────────────────────────────────────────────────────
        const requestedIntensity = interaction.options.getInteger('intensity');
        let pickedIntensity = CHOOSABLE_INTENSITY.find(l => l.level === requestedIntensity) ?? null;

        const intensityRow = new ActionRowBuilder().addComponents(
            ...CHOOSABLE_INTENSITY.map(l => new ButtonBuilder()
                .setCustomId(`digint_${l.level}`)
                .setLabel(`${l.name} · ${l.multiplier}× · ${Math.round(l.caveInRisk * 100)}%`)
                .setEmoji(l.emoji)
                .setStyle(l.level >= 4 ? ButtonStyle.Danger : l.level === 3 ? ButtonStyle.Primary : ButtonStyle.Secondary)
            )
        );

        const fallbackLevel = CHOOSABLE_INTENSITY.find(l => l.level === (m.preferredIntensity ?? DEFAULT_INTENSITY_LEVEL))
            ?? CHOOSABLE_INTENSITY.find(l => l.level === DEFAULT_INTENSITY_LEVEL);

        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor(isFeaturedDepth ? '#FFD700' : '#8B4513')
                .setTitle(`⛏️ Entering ${depth.emoji} ${depth.name}…`)
                .setDescription(
                    `*You lower yourself into the shaft. Dust settles. Your lamp catches a glint…*\n\n` +
                    (pickedIntensity
                        ? `**${pickedIntensity.emoji} ${pickedIntensity.name}** — ${pickedIntensity.multiplier}× payout, ${Math.round(pickedIntensity.caveInRisk * 100)}% cave-in risk.`
                        : `**How hard do you want to push?** Deeper pays more and risks bringing the roof down.`) +
                    featuredDepthNote + throttleWarning
                )
                .setFooter({ text: pickedIntensity
                    ? `${timeBand.emoji} ${timeBand.label}`
                    : `${timeBand.emoji} ${timeBand.label} · ${INTENSITY_PICK_MS / 1000}s to choose — defaults to ${fallbackLevel.name}. Pass \`intensity:\` to skip this.` })],
            components: pickedIntensity ? [] : [intensityRow],
        });
        const mineMsg = await interaction.fetchReply();

        if (!pickedIntensity) {
            const chosenId = await new Promise(resolve => {
                const col = mineMsg.createMessageComponentCollector({
                    filter: ownedBy(interaction.user.id, i => i.customId.startsWith('digint_'), "This isn't your dig."),
                    time: INTENSITY_PICK_MS,
                    max: 1,
                });
                col.on('collect', async i => { await i.deferUpdate().catch(() => {}); resolve(i.customId); });
                col.on('end', (_, reason) => { if (reason !== 'limit') resolve(null); });
            });
            pickedIntensity = CHOOSABLE_INTENSITY.find(l => `digint_${l.level}` === chosenId) ?? fallbackLevel;
        }

        // Remembered so the timeout default is the miner's own habit, not ours.
        if (m.preferredIntensity !== pickedIntensity.level) {
            m.preferredIntensity = pickedIntensity.level;
            user.markModified('mining');
        }

        // ── 2. One vein read, and a real one ───────────────────────────────────────
        const oreDir = DIRS[Math.floor(Math.random() * DIRS.length)];

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor('#B8860B')
                .setTitle('⛏️ Reading the vein…')
                .setDescription(
                    `*A mineral trace catches the lamplight. Mark where it runs.*\n\n` +
                    `\`\`\`\n${buildGrid(oreDir.id)}\n\`\`\``
                )
                .setFooter({ text: 'Remember it — the dust is about to settle.' })],
            components: [],
        });
        await delay(VEIN_FLASH_MS);

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor('#8B4513')
                .setTitle('⛏️ Which way did it run?')
                .setDescription(
                    `*Dust swallows the seam. Call it.*\n\n` +
                    `\`\`\`\n${buildGrid(null)}\n\`\`\``
                )
                .setFooter({ text: `${VEIN_ANSWER_MS / 1000}s · a correct read pays one rung higher at the same risk.` })],
            components: [new ActionRowBuilder().addComponents(
                ...DIRS.map(d => new ButtonBuilder()
                    .setCustomId(`vein_${d.id}`)
                    .setLabel(d.label)
                    .setStyle(ButtonStyle.Primary)
                )
            )],
        });

        const picked = await new Promise(resolve => {
            const col = mineMsg.createMessageComponentCollector({
                filter: ownedBy(interaction.user.id, i => i.customId.startsWith('vein_'), "This isn't your dig."),
                time: VEIN_ANSWER_MS,
                max: 1,
            });
            col.on('collect', async i => { await i.deferUpdate().catch(() => {}); resolve(i.customId.replace('vein_', '')); });
            col.on('end', (_, reason) => { if (reason !== 'limit') resolve(null); });
        });

        const veinRead = picked === oreDir.id;
        const chosenIntensity = veinRead ? promoteIntensity(pickedIntensity) : pickedIntensity;

        const confirmEmbed = new EmbedBuilder()
            .setColor(veinRead ? '#00CC55' : picked ? '#CC4400' : '#888888')
            .setTitle(veinRead
                ? `✅ Vein read — digging ${chosenIntensity.emoji} ${chosenIntensity.name}`
                : picked
                ? `❌ Misread the seam — digging ${chosenIntensity.emoji} ${chosenIntensity.name}`
                : `⏰ Too slow — digging ${chosenIntensity.emoji} ${chosenIntensity.name}`)
            .setDescription(
                (veinRead
                    ? `The vein ran **${oreDir.label}** and you called it. The seam is richer than it looked.\n\n`
                    : `The vein ran **${oreDir.label}**.\n\n`) +
                `**${chosenIntensity.multiplier}×** payout` +
                (veinRead ? ` *(up from ${pickedIntensity.multiplier}×)*` : '') +
                `  |  **${(chosenIntensity.caveInRisk * 100).toFixed(0)}%** cave-in risk`
            );
        await interaction.editReply({ embeds: [confirmEmbed], components: [] });

        // Crystal Fox pet: +15% mine yield (only if hunger >= 30)
        const { getTotalBonus, PET_DEFINITIONS: PET_DEFS, isPetActive, TRAIT_FLAVOR, tryGrantRarePet } = require('../../../services/petService');
        const petMineYieldPct = getTotalBonus(user.pets || [], 'mine_yield');

        const marketplaceActive = isDistrictActive(guildSettings, 'marketplace');
        const result = executeMine(user, depthId, { intensity: chosenIntensity, marketplaceActive });

        // ── Cave-in Interactive Event ─────────────────────────────────────────────
        // Resolved FIRST: pity, find counters, and yield bonuses below must only
        // apply to rewards the player actually keeps, not ore abandoned in a collapse.
        if (result.caveIn) {
            const m = user.mining;
            const equippedPickaxe = m.pickaxes?.[m.equippedPickaxeIndex];
            const pickaxeStaticData = equippedPickaxe ? PICKAXE_BY_TIER[equippedPickaxe.tier] : null;
            const chargeType = pickaxeStaticData?.chargeType;
            const chargesAvailable = chargeType ? (m.charges?.[chargeType] ?? 0) : 0;

            const caveInEmbed = new EmbedBuilder()
                .setColor('#8B0000')
                .setTitle('🌑 CAVE-IN!')
                .setDescription(
                    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `The tunnel is collapsing around you. Dust fills the air.\n` +
                    `You have seconds to decide.\n\n` +
                    `⚡ **Ore at stake:** ${((result.caveInPayout ?? 0) + (result.caveInEscrow ?? 0)).toLocaleString()} coins` +
                    (result.caveInEscrow > 0
                        ? ` *(includes the ${chosenIntensity.multiplier}× you ${chosenIntensity.promoted ? 'read out of the seam' : 'dug for'})*\n\n`
                        : `\n\n`) +
                    (chargesAvailable > 0
                        ? `💥 You have **${chargesAvailable}** blast charge${chargesAvailable !== 1 ? 's' : ''} — enough to blow an escape route.`
                        : `⚠️ You have no blast charges — you'll have to run.`)
                )
                .setFooter({ text: 'You have 20 seconds to decide.' });

            const caveInId = `cavein_${interaction.id}`;
            const blastBtn = new ButtonBuilder()
                .setCustomId(`${caveInId}_blast`)
                .setLabel('💥 Use a Blast Charge — save your ore')
                .setStyle(ButtonStyle.Success)
                .setDisabled(chargesAvailable <= 0);
            const abandonBtn = new ButtonBuilder()
                .setCustomId(`${caveInId}_abandon`)
                .setLabel('🏃 Abandon the Dig — flee empty-handed')
                .setStyle(ButtonStyle.Danger);
            const caveInRow = new ActionRowBuilder().addComponents(blastBtn, abandonBtn);

            await interaction.editReply({ embeds: [caveInEmbed], components: [caveInRow] });
            const caveInMsg = await interaction.fetchReply();

            const caveInChoice = await new Promise(resolve => {
                const col = caveInMsg.createMessageComponentCollector({
                    filter: ownedBy(interaction.user.id, i => i.customId.startsWith(caveInId), "This isn't your dig."),
                    time: 20_000,
                    max: 1,
                });
                col.on('collect', async i => { await i.deferUpdate().catch(() => {}); resolve(i.customId.endsWith('_blast') ? 'blast' : 'abandon'); });
                col.on('end', (_, reason) => { if (reason !== 'limit') resolve('abandon'); });
            });

            if (caveInChoice === 'blast' && chargesAvailable > 0) {
                // Deduct one blast charge and keep the payout
                if (chargeType) {
                    m.charges[chargeType] = chargesAvailable - 1;
                    user.markModified('mining');
                }
                // Digging clear releases the escrowed intensity bonus — the charge buys
                // back the whole haul, multiplier included. Clamped to the daily hard
                // cap the same way the uninterrupted path clamps it.
                if (result.caveInEscrow > 0) {
                    const remainingCap = Math.max(0, LIMITS.DAILY_HARD_CAP - m.dailyCoins);
                    const bonus        = Math.min(result.caveInEscrow, remainingCap);
                    if (bonus > 0) {
                        user.balance       += bonus;
                        m.totalEarned      += bonus;
                        m.dailyCoins       += bonus;
                        result.finalPayout  = (result.finalPayout ?? 0) + bonus;
                        result.caveInBonusPaid = bonus;
                    }
                }
                result.caveInEscaped = true;
            } else {
                // Abandon: reverse the payout and any tier-find counters executeMine already booked
                if (result.caveInPayout) {
                    user.balance       -= result.caveInPayout;
                    m.totalEarned      -= result.caveInPayout;
                    m.dailyCoins       -= result.caveInPayout;
                    result.finalPayout  = 0;
                }
                // The doubling charge bought ore that is now buried — hand it back
                // rather than billing a Black Market item for coins never kept.
                if (result.gatheringYield) {
                    refundEffectCharge(user, result.gatheringYield.effect);
                    result.gatheringYield = null;
                }
                if (result.tier === 'legendary') m.legendaryFinds = Math.max(0, m.legendaryFinds - 1);
                if (result.tier === 'event')     m.eventFinds     = Math.max(0, m.eventFinds - 1);
                result.caveInAbandoned = true;
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
        // Mirrors the keptRareFind predicate above: a cave-in the player fled leaves
        // result.success true while revoking the find, and an abandoned haul must not
        // hand out a companion either.
        const rarePetDrop = result.success && !result.caveInAbandoned
            ? tryGrantRarePet(user, 'mine', result.tier)
            : null;
        if (rarePetDrop) user.markModified('pets');

        const mineAchievements = await checkAndAward(user, guildSettings).catch(() => []);

        // Persist and credit through the service. A path that reverses its own
        // reward nets to zero and issues no coin write.
        let payoutOwed = 0;
        try {
            ({ payoutOwed } = await commitDig(user, balanceAtLoad));
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
                return interaction.editReply({ content: 'A simultaneous request conflicted with your mine. Please try `/mine dig` again.' });
            }
            console.error('[mine] save error:', err);
            return interaction.editReply({ content: 'Something went wrong saving your mine. Please try again.' });
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
            const lines = [
                `> ${chosenIntensity.emoji} *Dug **${chosenIntensity.name}** — ${chosenIntensity.multiplier}× at ${(chosenIntensity.caveInRisk * 100).toFixed(0)}% risk`
                + (veinRead ? ` · vein read ✅ (up from ${pickedIntensity.multiplier}×)*` : `*`),
            ];
            if (result.caveIn && result.caveInEscaped) {
                lines.push(result.caveInBonusPaid > 0
                    ? `> 💥 *Cave-in! You blasted clear — ore saved, and the ${chosenIntensity.multiplier}× held.*`
                    : `> 💥 *Cave-in! You used a blast charge — ore saved.*`);
            }
            else if (result.caveIn) lines.push(`> 💥 *${randomFrom(MINE_CAVE_LINES)}*`);
            embed.setDescription(desc + '\n' + lines.join('\n'));
        }
        if (result.featuredDepthBonus > 0) {
            embed.addFields({ name: '🌟 Featured Depth Bonus', value: `+${result.featuredDepthBonus.toLocaleString()} coins (+${Math.round(FEATURED_PAYOUT_BONUS * 100)}%)`, inline: true });
        }
        if (result.petYieldBonus > 0) {
            embed.addFields({ name: '💎 Pet Bonus', value: `+${result.petYieldBonus.toLocaleString()} coins (${petMineYieldPct}% yield)`, inline: true });
        }
        if (result.wildernessBonus > 0) {
            embed.addFields({ name: '🌲 Wilderness District', value: `+${result.wildernessBonus.toLocaleString()} coins (+10% yield)`, inline: true });
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

        // Pet narrative: show active pet's personality flavor in description
        if (result.success) {
            const activePet = (user.pets || []).find(p => isPetActive(p));
            if (activePet) {
                const petDef = PET_DEFS[activePet.petId];
                const petName = activePet.name || petDef?.name || activePet.petId;
                const flavorFn = TRAIT_FLAVOR[activePet.personality]?.mine;
                if (flavorFn && petDef) {
                    const desc = embed.data.description ?? '';
                    embed.setDescription(desc + `\n> ${flavorFn(petName, petDef.emoji)}`);
                }
            }
        }

        // Staged loot reveal for rare+ drops
        await stagedLootReveal(interaction, result.success ? result.tier : null, embed);

        if (result.success && ['epic', 'legendary', 'event'].includes(result.tier) && guildSettings?.economy?.announceRareDrops !== false) {
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

        // Catastrophic cave-in server announcement (Deep or Abyss intensity, pickaxe destroyed)
        if (result.caveIn && result.pickaxeBroke && chosenIntensity.level >= 4 && guildSettings?.economy?.announceRareDrops !== false) {
            const announceChannelId = guildSettings?.economy?.announcementChannelId;
            const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
            const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
            const caveEmbed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle('💥 Catastrophic Cave-in!')
                .setDescription(
                    `<@${interaction.user.id}> just suffered a **catastrophic cave-in** at Depth **${chosenIntensity.name}** (${depth.name})!\n` +
                    `Their **${pickaxe.name}** has been destroyed.\n\n` +
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
                    title: '🤕 Recovering from Cave-in',
                    description: "You took a hit down there. Rest up before heading back underground.",
                    color: '#b5651d',
                    nextAt: preflight.nextAt,
                })],
                ...ephemeral,
            });
        case 'cooldown':
            // Intensity is earned in the vein-reading rounds, not picked from a menu —
            // so the preview promises what a good read pays, not a setting to choose.
            return interaction.reply({
                embeds: [buildCooldownEmbed({
                    title: '⛏️ Catching Your Breath',
                    description: 'You just came up from a dig.\nTake a short break before heading back down.',
                    color: '#b5651d',
                    nextAt: preflight.nextAt,
                    nextRewardPreview: 'Pick how hard to push next dig — up to 2×, and 3× if you read the vein right',
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
                content: `You don't have a pickaxe equipped! Buy one with \`/mine shop pickaxe\` and equip it with \`/mine inv equip 1\`.`,
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
    INTENSITY_PICK_MS,
    VEIN_ANSWER_MS,
    VEIN_FLASH_MS,
    handleDig,
    replyDigPreflightFailure,
    stagedLootReveal,
};
