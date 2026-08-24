'use strict';

// /hunt start — the hunt itself, from preflight through the aim phase to the
// staged reveal of what was taken.

const { TIER_NUM, TIER_STARS } = require('../../../data/materialRarity');
const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Guild = require('../../../models/Guild');
const User = require('../../../models/User');
const {
    prepareHuntUser,
    validateHuntPreflight,
    claimHuntCooldown,
    rollHuntEncounter,
    rollAnimal,
    executeHunt,
    applyHuntBonuses,
    updateHuntQuestProgress,
    commitHunt,
    rollApexType,
    apexNerveMax,
    apexNerveAfter,
    ensureHuntData,
    resolveApexEncounter,
    applyPayoutModifiers,
    recordBestPayout,
    formatMs
} = require('../../../services/huntService');
const { buildCooldownEmbed } = require('../../../utils/cooldownEmbed');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS } = require('../../../data/featuredRotation');
const { isDistrictActive } = require('../../../services/districtService');
const { ensureQuests, onHunt, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../../services/questService');
const { recordMissionProgress } = require('../../../services/seasonMissionService');
const { checkAndAward, announceAchievements } = require('../../../services/achievementService');
const { isVersionError } = require('../../../utils/versionRetry');
const { logBigWin } = require('../../../utils/bigWinLogger');
const { tryUpdateHourlyWinner, getCurrentHourlyLeader } = require('../../../utils/hourlyWinner');
const { getTimeBand } = require('../../../utils/timeBand');
const { attachGrind } = require('../../../utils/grindProfile');
const { ZONES } = require('../../../data/huntData');
const { saveWithBalanceDelta } = require('../../../utils/balanceDelta');
const { pickApproachProfile, runAimPhase } = require('./aim');
const { buildBonusLines, buildHuntEmbed } = require('./embeds');
const { ownedBy } = require('../../../utils/collectorOwner');

// ─── Staged loot reveal for rare+ drops ──────────────────────────────────────
// tier: 'common'|'uncommon'|'rare'|'epic'|'legendary'|'event'|null
async function stagedLootReveal(interaction, tier, finalEmbed) {
    const tierNum = TIER_NUM[tier] ?? 0;
    if (tierNum < 3) {
        await interaction.editReply({ embeds: [finalEmbed] });
        return;
    }
    const wait = ms => new Promise(r => setTimeout(r, ms));

    const fogEmbed = new EmbedBuilder()
        .setColor('#4a4a4a')
        .setTitle('🌫️ Something stirs in the shadows...')
        .setDescription('━━━━━━━━━━━━━━━\n*The shadows shift. Something is here.*\n━━━━━━━━━━━━━━━');

    if (tierNum === 3) {
        await interaction.editReply({ embeds: [fogEmbed] });
        await wait(1500);
    } else {
        // Epic or Legendary: stage 1 — fog
        await interaction.editReply({ embeds: [fogEmbed] });
        await wait(1500);
        // Stage 2 — partial reveal
        const midColor = tierNum === 6 ? '#e74c3c' : tierNum === 4 ? '#9c27b0' : '#ff9800';
        const midTitle = tierNum === 6 ? '☄️ Every animal in the forest has gone silent...' : tierNum === 4 ? '🔮 Something exceptional emerges...' : '⚡ The air crackles with power...';
        const midTierLabel = tierNum === 6 ? 'EVENT' : tierNum === 4 ? 'EPIC' : 'LEGENDARY';
        const midEmbed = new EmbedBuilder()
            .setColor(midColor)
            .setTitle(midTitle)
            .setDescription(`━━━━━━━━━━━━━━━\n❓❓❓  **${midTierLabel}**  ❓❓❓\n━━━━━━━━━━━━━━━`);
        await interaction.editReply({ embeds: [midEmbed] });
        await wait(1500);
        if (tierNum >= 5) {
            // Stage 3 — legendary fanfare
            const isEvent = tierNum === 6;
            const fanfareEmbed = new EmbedBuilder()
                .setColor(isEvent ? '#e74c3c' : '#ff9800')
                .setTitle(isEvent ? '☄️ ⚡ 𝗠 𝗬 𝗧 𝗛 𝗜 𝗖 𝗔 𝗟 ⚡ ☄️' : '⚡ ✨ 𝗟 𝗘 𝗚 𝗘 𝗡 𝗗 𝗔 𝗥 𝗬 ✨ ⚡')
                .setDescription(isEvent ? '━━━━━━━━━━━━━━━\n*Nothing like this has been seen in living memory.*\n━━━━━━━━━━━━━━━' : '━━━━━━━━━━━━━━━\n*The air crackles. This is once in a lifetime.*\n━━━━━━━━━━━━━━━');
            await interaction.editReply({ embeds: [fanfareEmbed] });
            await wait(1500);
        }
    }
    await interaction.editReply({ embeds: [finalEmbed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// START (was /hunt)
// ═══════════════════════════════════════════════════════════════════════════════

async function executeStart(interaction) {
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

    // Quick-hunt preference: passing the option flips the stored setting, so it
    // never has to be retyped; omitting it uses whatever was chosen last.
    const quick = await prepareHuntUser(user, { quickHunt: interaction.options.getBoolean('quick') });
    const h = user.hunt;

    // ── Preflight (read-only; the cooldown slot is claimed atomically below) ──
    const preflight = validateHuntPreflight(user, interaction.options.getString('zone'));
    if (!preflight.ok) {
        return replyHuntPreflightFailure(interaction, preflight);
    }
    const { zoneId, zone, weapon, weaponData } = preflight;

    // Atomically claim the cooldown slot now that all preflight checks have
    // passed — see huntService.claimHuntCooldown for the guarantees.
    const claim = await claimHuntCooldown(user);
    if (!claim.claimed) {
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🫁 Catching Your Breath',
                description: 'You just came back from a hunt.\nGive it a moment before heading back out.',
                color: '#5a8a3c',
                nextAt: claim.nextAt,
            })],
            flags: MessageFlags.Ephemeral,
        });
    }
    const releaseHuntClaim = claim.release;

    // Everything between here and the save can still fail — a Discord API error
    // while collecting the approach prompts, a service throwing — and until the
    // result is persisted the player has nothing to show for the cooldown they
    // just paid for. Hand the slot back on the way out unless the hunt committed.
    let huntCommitted = false;

    // Everything below runs across the interactive prompts, during which the
    // player can spend coins elsewhere. The run's own coin movement is
    // collected as a delta against this reading and applied as an atomic
    // `$inc` at the save, so `save()` never writes an absolute balance read
    // before that window. See src/utils/balanceDelta.js.
    const balanceAtLoad = user.balance ?? 0;

    try {

        // Ammo comes out only once the cooldown slot is ours, so a lost race never
        // costs the player a round.
        if (weaponData.requiresAmmo) {
            h.ammo[weaponData.ammoType] = (h.ammo[weaponData.ammoType] ?? 0) - 1;
            user.markModified('hunt');
        }

        // ── Stealth Approach + Precision Aim ─────────────────────────────────────
        // Phase 1 — Stealth: the prey is rolled first, and the player reads a
        // behaviour hint about *that animal* and picks the matching approach.
        //   Correct  → stealthBonus = +0.25 success chance, common→uncommon upgrade ~30%
        //   Partial  → stealthBonus = +0.05 (safe but suboptimal)
        //   Wrong    → stealthBonus = −0.10 (spooked the animal)
        //   Timeout  → stealthBonus = 0
        // Phase 2 — Aim: hold the shot until the target lines up, then fire.
        //   In the window  → aimBonus = +0.18 crit chance
        //   Late           → aimBonus = +0.08 crit chance
        //   Early          → aimBonus = −0.05 crit chance (rushed the shot)
        //   Timeout        → aimBonus = 0

        let stealthBonus = 0;
        let aimBonus     = 0;

        // Rolled before the prompt so the hint can be truthful and the correct
        // answer can follow the animal rather than the zone.
        let encounter = rollHuntEncounter(user, zoneId);

        const delay = ms => new Promise(r => setTimeout(r, ms));

        // A quick hunt trades both phase bonuses for the ~6-10 seconds of
        // prompts and forced waits the interactive path costs — a real trade
        // the player opts into, so it needs no rebalancing.
        if (!quick) {
            const approachData = pickApproachProfile(encounter.animal);
            // Shuffle the 3 options
            const shuffled = [...approachData.options].sort(() => Math.random() - 0.5);

            const stealthEmbed = new EmbedBuilder()
                .setColor('#556B2F')
                .setTitle(`🌿 Approaching ${zone.emoji} ${zone.name}…`)
                .setDescription(
                    `*${approachData.hint(encounter.animal)}*\n\n` +
                    `**How do you close in on your prey?**\n` +
                    `Choose wisely — the animal will react to your approach.`
                )
                .setFooter({ text: 'You have 15 seconds — or the hunt begins without a stealth bonus.' });

            const stealthRow = new ActionRowBuilder().addComponents(
                ...shuffled.map(opt => new ButtonBuilder()
                    .setCustomId(`stealth_${opt.id}`)
                    .setLabel(opt.label)
                    .setStyle(ButtonStyle.Primary)
                )
            );

            await interaction.reply({ embeds: [stealthEmbed], components: [stealthRow] });
            const huntMsg = await interaction.fetchReply();

            const pickedId = await new Promise(resolve => {
                const col = huntMsg.createMessageComponentCollector({
                    filter: ownedBy(interaction.user.id, i => i.customId.startsWith('stealth_'), "This isn't your hunt."),
                    time: 15_000,
                    max: 1,
                });
                col.on('collect', async i => { await i.deferUpdate(); resolve(i.customId.replace('stealth_', '')); });
                col.on('end',     (_, reason) => { if (reason !== 'limit') resolve(null); });
            });

            const chosen = shuffled.find(o => o.id === pickedId);
            if (chosen) {
                const isCorrectChoice = pickedId === approachData.correctId;
                const isNeutralChoice = !isCorrectChoice && chosen.stealthBonus >= 0;
                // Probabilistic outcome: correct=80% success, neutral=50%, wrong=20%
                const successChance = isCorrectChoice ? 0.80 : isNeutralChoice ? 0.50 : 0.20;
                const approachSucceeded = Math.random() < successChance;
                if (approachSucceeded) {
                    stealthBonus = chosen.stealthBonus;
                } else {
                    // Correct/neutral failed: animal startled; wrong: already bad, just slightly worse
                    stealthBonus = isNeutralChoice ? 0 : -0.10;
                }
            }

            const isCorrect  = pickedId === approachData.correctId;
            const isTimeout  = pickedId === null;
            const chosenLabel = chosen?.label ?? '';
            const stealthResultEmbed = new EmbedBuilder()
                .setColor(
                    isTimeout ? '#888888' :
                    stealthBonus > 0 ? '#00FF7F' :
                    stealthBonus < 0 ? '#FF6B6B' : '#FFA500'
                )
                .setTitle(
                    isTimeout  ? '⏰ Hesitated too long…' :
                    isCorrect && stealthBonus > 0 ? '🤫 Perfect approach!' :
                    isCorrect && stealthBonus <= 0 ? '🐾 So close — it sensed you anyway…' :
                    stealthBonus > 0 ? '🤔 Decent approach…' :
                    stealthBonus < 0 ? '🔊 You spooked the animal!' :
                    '🤔 No harm done…'
                )
                .setDescription(
                    isTimeout
                        ? `You weighed your options too long — the window closed.\n\nNo stealth bonus this hunt.`
                        : isCorrect && stealthBonus > 0
                        ? `**${chosenLabel}**\n\n*You read the terrain perfectly. The animal froze for a moment — then relaxed. It never sensed you.*\n\n**+25% success chance** and a chance of better prey.`
                        : isCorrect && stealthBonus <= 0
                        ? `**${chosenLabel}**\n\n*The right call — but the animal picked up something off. A twig snapped, the wind shifted. No bonus this time.*\n\n**No stealth bonus.**`
                        : stealthBonus > 0
                        ? `**${chosenLabel}**\n\n*Not the ideal approach, but you kept your noise down. The animal stirred — then settled.*\n\n**+5% success chance.**`
                        : stealthBonus < 0
                        ? `**${chosenLabel}**\n\n*The animal heard you before you got within range. It fixed you with a stare — every advantage lost.*\n\n**−10% success chance** this hunt.`
                        : `**${chosenLabel}**\n\n*Could've gone worse. The animal wasn't alarmed, but you didn't gain any ground either.*\n\n**No stealth bonus.**`
                );

            await interaction.editReply({ embeds: [stealthResultEmbed], components: [] });
            await delay(800);

            // A patient, correct approach can turn common prey into something
            // better — the "chance of better prey" the result copy promises.
            // Applied here, once the stealth outcome is known, because the
            // encounter itself is rolled before the prompt now.
            if (stealthBonus > 0 && encounter.tier === 'common' && Math.random() < 0.30) {
                encounter = { tier: 'uncommon', animal: rollAnimal('uncommon', zoneId) };
            }

            aimBonus = (await runAimPhase(interaction, huntMsg)).bonus;

        } else {
            await interaction.deferReply();
        }

        // Wolf pet: +10% coin yield; Eagle pet: +15% XP (only if hunger >= 30)
        const { getTotalBonus, PET_DEFINITIONS: PET_DEFS, isPetActive, TRAIT_FLAVOR, tryGrantRarePet } = require('../../../services/petService');
        const petYieldPct = getTotalBonus(user.pets || [], 'hunt_yield');
        const petXpPct    = getTotalBonus(user.pets || [], 'hunt_xp');

        const featured       = getDailyFeatured(interaction.guild.id);
        const isFeaturedZone = zoneId === featured.huntZone.id;

        const marketplaceActive = isDistrictActive(guildSettings, 'marketplace');
        const result = executeHunt(user, zoneId, { stealthBonus, aimBonus, marketplaceActive, encounter });

        // Pity counter, pet coin/XP yield, featured-zone and Wilderness
        // bonuses, best-payout record — the full post-roll bonus stack.
        applyHuntBonuses(user, result, zoneId, {
            petYieldPct,
            petXpPct,
            isFeaturedZone,
            featuredPayoutBonus: FEATURED_PAYOUT_BONUS,
            wildernessActive: isDistrictActive(guildSettings, 'wilderness'),
        });

        updateHuntQuestProgress(user, result, zoneId);
        await ensureQuests(user, guildSettings);
        const { completed: questsDone, nearComplete: questsNear } = await onHunt(user, guildSettings);
        // Season pass daily missions listen for the same actions quests do.
        recordMissionProgress(user, 'hunt', 1, guildSettings);
        if (result.success && result.finalPayout > 0) {
            const earn = await onEconomyEarn(user, guildSettings, result.finalPayout);
            questsDone.push(...earn.completed);
            questsNear.push(...earn.nearComplete);
        }

        // Rare companions are found, not bought: a legendary result is the only
        // thing that can turn one up. Rolled before the save below persists it.
        const rarePetDrop = result.success ? tryGrantRarePet(user, 'hunt', result.tier) : null;
        if (rarePetDrop) user.markModified('pets');

        const huntAchievements = await checkAndAward(user, guildSettings).catch(() => []);

        // Persist and credit through the service. A path that reverses its own
        // reward nets to zero and issues no coin write.
        let payoutOwed = 0;
        try {
            ({ payoutOwed } = await commitHunt(user, balanceAtLoad));
            huntCommitted = true;
            if (huntAchievements.length) {
                announceAchievements(interaction.client, guildSettings, user, interaction.member, huntAchievements).catch(() => null);
            }
            notifyQuestComplete(guildSettings, interaction.member, questsDone, interaction.channel, user).catch(() => null);
            notifyQuestNearComplete(guildSettings, interaction.member, questsNear, interaction.channel).catch(() => null);
        } catch (err) {
            // Nothing was saved, so give the cooldown slot back before telling them to retry.
            await releaseHuntClaim();
            if (isVersionError(err)) {
                return interaction.editReply({ content: 'A simultaneous request conflicted with your hunt. Please try `/hunt start` again.' });
            }
            console.error('[hunt] save error:', err);
            return interaction.editReply({ content: 'Something went wrong saving your hunt. Please try again.' });
        }

        // Log big win, then await hourly leader update and re-fetch for accurate footer
        if (result.success && result.finalPayout > 0) {
            const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
            if (result.finalPayout >= bigWinThreshold || ['legendary', 'event'].includes(result.tier)) {
                logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: result.finalPayout, source: 'hunt', details: { itemName: result.animal?.name, rarity: result.tier }, client: interaction.client });
            }
            await tryUpdateHourlyWinner({ guildId: interaction.guild.id, category: 'hunt', userId: interaction.user.id, username: interaction.user.username, value: result.finalPayout, details: result.animal ? `${result.animal.emoji} ${result.animal.name} (${currency}${result.finalPayout.toLocaleString()})` : null }).catch(() => null);
        }
        const hourlyLeader = await getCurrentHourlyLeader(interaction.guild.id, 'hunt').catch(() => null);

        const timeBand = getTimeBand();
        const embed = buildHuntEmbed(result, user, zone, weapon, currency, interaction.user);

        if (payoutOwed > 0) {
            embed.addFields({
                name: '⚠️ Payout Not Yet Credited',
                value: `The **${currency}${payoutOwed.toLocaleString()}** from this hunt could not be paid out just now and has been recorded as owed — the balance shown below does not include it. It will be applied once the problem clears; tell an admin if it does not.`,
            });
        }
        {
            const desc = embed.data.description ?? '';
            const lines = [];
            if (stealthBonus > 0.10) lines.push(`> 🤫 *Perfect approach — +25% success, chance of better prey*`);
            else if (stealthBonus > 0) lines.push(`> 🌿 *Decent approach — +5% success*`);
            else if (stealthBonus < 0) lines.push(`> 🔊 *Spooked the animal — −10% success*`);
            if (aimBonus >= 0.18) lines.push(`> 🎯 *Perfect shot — +18% crit chance*`);
            else if (aimBonus > 0) lines.push(`> ✅ *Clean shot — +8% crit chance*`);
            else if (aimBonus < 0) lines.push(`> 💨 *Rushed shot — −5% crit chance*`);
            if (quick) lines.push(`> ⚡ *Quick hunt — stealth & aim skipped · turn off with \`/hunt start quick:false\`*`);
            if (lines.length) embed.setDescription(desc + '\n' + lines.join('\n'));
        }
        // One consolidated field rather than one per bonus: Discord caps an embed at
        // 25 fields, and giving each its own put a maximal hunt within one of the
        // limit. Grouping them also reads better — they are all the same idea.
        const bonusLines = buildBonusLines(result, petYieldPct, petXpPct);
        if (bonusLines.length) {
            embed.addFields({ name: '✨ Bonuses', value: bonusLines.join('\n'), inline: false });
        }

        // Hourly leader footer
        const leaderNote = hourlyLeader
            ? `🏆 Hourly leader: ${hourlyLeader.username} — ${hourlyLeader.details ?? hourlyLeader.value.toLocaleString() + ' coins'}`
            : '🏆 No hourly leader yet — be the first!';
        const footerBase = `${timeBand.emoji} ${timeBand.label}`;
        const currentFooter = embed.data.footer?.text ?? '';
        embed.setFooter({ text: currentFooter ? `${currentFooter} · ${footerBase} · ${leaderNote}` : `${footerBase} · ${leaderNote}` });

        if (isFeaturedZone) {
            const desc = embed.data.description ?? '';
            embed.setDescription(desc + `\n> 🌟 *Featured Zone: ${zone.emoji} ${zone.name} — +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% payout bonus active!*`);
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
        if (result.success) {
            const activePet = (user.pets || []).find(p => isPetActive(p));
            if (activePet) {
                const petDef = PET_DEFS[activePet.petId];
                const petName = activePet.name || petDef?.name || activePet.petId;
                const flavorFn = TRAIT_FLAVOR[activePet.personality]?.hunt;
                if (flavorFn && petDef) {
                    const desc = embed.data.description ?? '';
                    embed.setDescription(desc + `\n> ${flavorFn(petName, petDef.emoji)}`);
                }
            }
        }

        // Discord rejects an embed with more than 25 fields. A maximal hunt — crit,
        // traits, trait effects, special drop, booster proc, level-up, both buffs
        // expiring, weapon warning, pity, plus the pet / featured-zone / district
        // bonuses — now reaches 24. Trim rather than lose the whole result embed to
        // an exception if another field is added later.
        if (embed.data.fields && embed.data.fields.length > 25) {
            embed.data.fields.length = 25;
        }

        // Staged loot reveal for rare+ drops. A quick hunt skips the ceremony
        // here too — the fog-and-fanfare build-up is the same forced wait the
        // player opted out of, and the tier is still announced on the embed.
        await stagedLootReveal(interaction, !quick && result.success ? result.tier : null, embed);

        if (result.success && ['epic', 'legendary', 'event'].includes(result.tier) && guildSettings?.economy?.announceRareDrops !== false) {
            const announceChannelId = guildSettings?.economy?.announcementChannelId;
            const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
            const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
            const announceTier = TIER_NUM[result.tier] ?? 4;
            const ANNOUNCE_COPY = {
                4: { color: '#9c27b0', title: '🔮 Epic Find!',              line: 'A rare moment in the wild.' },
                5: { color: '#ff9800', title: '✨ Legendary Trophy! ✨',     line: 'Only a handful of hunters have ever managed that.' },
                6: { color: '#e74c3c', title: '☄️ Mythical Quarry! ☄️',     line: 'Nothing like it has been seen in living memory.' },
            };
            const copy = ANNOUNCE_COPY[announceTier] ?? ANNOUNCE_COPY[4];
            const announcementEmbed = new EmbedBuilder()
                .setColor(copy.color)
                .setTitle(copy.title)
                .setDescription(
                    `<@${interaction.user.id}> just brought down ${result.animal.emoji} **${result.animal.name}** [${TIER_STARS[announceTier]}]\n` +
                    `deep in the **${zone.name}**.\n\n` +
                    copy.line
                )
                .setTimestamp();
            announceChannel.send({ embeds: [announcementEmbed] }).catch(() => null);
        }

        // ── Apex encounter — multi-phase showdown (mirrors the fishing boss UI) ──
        if (result.apexEncounter) {
            // Pin the weapon that was actually equipped for this encounter so durability
            // loss can't land on a different weapon if the player re-equips mid-flow.
            const apexWeaponIndex = user.hunt.equippedWeaponIndex;
            const apexType    = rollApexType();
            const choicesMade = [];
            const phaseCount  = apexType.phases.length;

            const buildApexPhaseEmbed = (phaseIndex, prevResults) => {
                const phase  = apexType.phases[phaseIndex];
                const nerveMax  = apexNerveMax(user);
                const nerve     = apexNerveAfter(prevResults, user);
                const nerveBar  = '❤️'.repeat(nerve) + '🖤'.repeat(nerveMax - nerve);
                const histLines = prevResults.map((p, i) => {
                    const icon = p.correct ? '✅' : p.chosen === 'safe' ? '🛡️' : '❌';
                    return `Phase ${i + 1}: ${icon}`;
                }).join('  ');

                return new EmbedBuilder()
                    .setColor('#3b1f04')
                    .setTitle(`${apexType.emoji} ${apexType.name} — Phase ${phaseIndex + 1}/${phaseCount}`)
                    .setDescription(
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `  ${result.apexEncounter.animal.emoji}  The pack leader of your **${result.apexEncounter.animal.name}** appears!\n` +
                        `  Nerve: ${nerveBar}\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `${phase.hint}\n\n` +
                        (histLines ? `${histLines}\n\n` : '') +
                        `**Choose your move — NOW:**`
                    )
                    .setFooter({ text: `⏱️ 30 seconds per phase • 3/3=1.5x bonus | 2/3=1x | 1/3=0.4x • A wrong read costs 2 nerve — at 0 it escapes. Backing off is safe but never counts.` });
            };

            const buildPhaseRow = (phaseIndex) => {
                const choices = apexType.phases[phaseIndex].choices;
                return new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('apex_match').setLabel(choices.match.label).setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('apex_hold').setLabel(choices.hold.label).setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('apex_safe').setLabel(choices.safe.label).setStyle(ButtonStyle.Secondary)
                );
            };

            const validIds = ['apex_match', 'apex_hold', 'apex_safe'];
            const idToKey  = { apex_match: 'match', apex_hold: 'hold', apex_safe: 'safe' };

            await interaction.editReply({ embeds: [embed, buildApexPhaseEmbed(0, [])], components: [buildPhaseRow(0)] });

            const runPhase = async (phaseIndex, prevResults, prevBtn) => {
                const fetchReply = prevBtn ? await prevBtn.fetchReply() : await interaction.fetchReply();
                return new Promise(resolve => {
                    const collector = fetchReply.createMessageComponentCollector({
                        filter: ownedBy(interaction.user.id, i => validIds.includes(i.customId), "This isn't your hunt."),
                        time: 30_000, max: 1
                    });
                    collector.on('collect', async btn => {
                        const chosen  = idToKey[btn.customId];
                        const phase   = apexType.phases[phaseIndex];
                        const correct = chosen === phase.correct;
                        const results = [...prevResults, { correct, chosen, correctChoice: phase.correct }];
                        choicesMade.push(chosen);

                        if (phaseIndex < phaseCount - 1) {
                            await btn.update({ embeds: [embed, buildApexPhaseEmbed(phaseIndex + 1, results)], components: [buildPhaseRow(phaseIndex + 1)] });
                            resolve({ btn, results });
                        } else {
                            resolve({ btn, results, done: true });
                        }
                    });
                    collector.on('end', (collected, reason) => {
                        if (reason === 'time' && collected.size === 0) {
                            resolve({ btn: null, results: prevResults, timedOut: true });
                        }
                    });
                });
            };

            let state = { btn: null, results: [], done: false, timedOut: false };
            for (let i = 0; i < phaseCount; i++) {
                state = await runPhase(i, state.results, state.btn);
                if (state.timedOut) {
                    const timeoutEmbed = new EmbedBuilder()
                        .setColor('#3b1f04')
                        .setTitle(`💨 ${apexType.emoji} The ${apexType.name} Escaped`)
                        .setDescription('You hesitated too long — it melted back into the wild. No bonus this time.')
                        .setTimestamp();
                    interaction.editReply({ embeds: [embed, timeoutEmbed], components: [] }).catch(() => {});
                    return;
                }
            }

            // Resolve outcome on a fresh user document
            const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            if (!freshUser) {
                console.error(`[hunt apex] user document vanished mid-encounter — user=${interaction.user.id} guild=${interaction.guild.id}`);
                return state.btn.update({ content: 'Something went wrong resolving the encounter — your hunt rewards were already saved.', embeds: [embed], components: [] }).catch(() => {});
            }
            await attachGrind(freshUser);
            ensureHuntData(freshUser);
            // The duel is priced off the kill that spawned it — crit, trophy
            // quality, streak and traits included — rather than a fresh roll of
            // the animal's base range (#744). Caps are still applied below.
            const apexResult = resolveApexEncounter(
                freshUser, result.apexEncounter.animal, result.apexEncounter.tier,
                choicesMade, apexType, apexWeaponIndex,
                { killPayout: result.apexEncounter.killPayout },
            );

            // The reload above is already seconds old by the time the fight
            // resolves, and `save()` writes `balance` as an absolute `$set` — so
            // the bonus is applied as its own `$inc` and `balance` stays out of
            // the save, exactly as the hunt itself does.
            const apexBalanceAtLoad = freshUser.balance ?? 0;

            let apexQuestsDone = [], apexQuestsNear = [];
            if (apexResult.bonusPayout > 0) {
                const apexZone = ZONES[freshUser.hunt.activeZone] ?? zone;
                // The apex fight is part of this hunt, so it rides on the gathering
                // charge the kill already spent rather than burning a second one —
                // otherwise a booster drains fastest on exactly the rare kills that
                // trigger an apex in the first place.
                const { adjustedPayout } = applyPayoutModifiers(freshUser, apexResult.bonusPayout, apexZone, {
                    reuseGatheringYield: !!result.gatheringYield,
                });
                apexResult.bonusPayout = adjustedPayout;
                freshUser.balance          += adjustedPayout;
                freshUser.hunt.totalEarned += adjustedPayout;
                freshUser.hunt.dailyCoins  += adjustedPayout;
                recordBestPayout(freshUser.hunt, adjustedPayout, {
                    animal: result.apexEncounter.animal,
                    tier:   result.apexEncounter.tier,
                    zoneId: freshUser.hunt.activeZone,
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
                });
                if (!apexPaid.credited) apexPayoutOwed = apexResult.bonusPayout;
                if (apexQuestsDone.length || apexQuestsNear.length) {
                    notifyQuestComplete(guildSettings, interaction.member, apexQuestsDone, interaction.channel, freshUser).catch(() => null);
                    notifyQuestNearComplete(guildSettings, interaction.member, apexQuestsNear, interaction.channel).catch(() => null);
                }
            } catch (saveErr) {
                console.error('[hunt apex] save error:', saveErr);
                return state.btn.update({ content: 'Something went wrong saving your apex result — the encounter is lost and cannot be retried. Your original hunt rewards were already saved.', embeds: [], components: [] }).catch(() => {});
            }

            if (apexResult.bonusPayout > 0) {
                const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
                if (apexResult.bonusPayout >= bigWinThreshold) {
                    logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: apexResult.bonusPayout, source: 'hunt', details: { itemName: result.apexEncounter.animal.name, rarity: 'apex' }, client: interaction.client });
                }
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

            const apexEmbed = new EmbedBuilder()
                .setColor(outcomeColors[apexResult.outcome])
                .setTitle(outcomeTitles[apexResult.outcome])
                .setDescription(
                    `${apexResult.message}\n\n${phaseScoreLine}\n\n` +
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

            await state.btn.update({ embeds: [embed, apexEmbed], components: [] }).catch(() => {});
            return;
        }
    } catch (err) {
        if (!huntCommitted) await releaseHuntClaim();
        throw err;
    }
}

// Renders a failed hunt preflight (huntService.validateHuntPreflight) as the
// reply the player sees. Pure presentation — every check lives in the service.
function replyHuntPreflightFailure(interaction, preflight) {
    const ephemeral = { flags: MessageFlags.Ephemeral };
    switch (preflight.reason) {
        case 'unknown_zone':
            return interaction.reply({ content: `Unknown zone \`${preflight.zoneId}\`. Use \`/hunt zone list\` to see available zones.`, ...ephemeral });
        case 'zone_locked':
            return interaction.reply({
                content: `You haven't unlocked **${preflight.zone.name}** yet. Use \`/hunt shop unlock\` to unlock it.`,
                ...ephemeral
            });
        case 'level_too_low':
            return interaction.reply({
                content: `You need to be Hunter Level **${preflight.zone.unlockLevel}** to hunt in **${preflight.zone.name}**.`,
                ...ephemeral
            });
        case 'injured':
            return interaction.reply({
                content: `You're injured and need to rest. Back in action in **${formatMs(preflight.remainingMs)}**.`,
                ...ephemeral
            });
        case 'cooldown':
            return interaction.reply({
                embeds: [buildCooldownEmbed({
                    title: '🫁 Catching Your Breath',
                    description: 'You just came back from a hunt.\nGive it a moment before heading back out.',
                    color: '#5a8a3c',
                    nextAt: preflight.nextAt,
                })],
                ...ephemeral,
            });
        case 'no_stamina':
            return interaction.reply({
                embeds: [buildCooldownEmbed({
                    title: '😮‍💨 Out of Stamina',
                    description: "You've pushed yourself to the limit.\nRest up — the wilderness will wait.\nBuy a **Stamina Tonic** from `/hunt shop` to recover faster.",
                    color: '#5a8a3c',
                    nextAt: preflight.nextAt,
                    pityStat: preflight.sinceRare >= 5
                        ? `🎯 ${preflight.sinceRare} hunts since last Rare+ • guaranteed at ${preflight.pityCap} in ${preflight.zone.name}`
                        : null,
                    nextRewardPreview: `Full stamina = ${preflight.maxStamina} hunts · Rare+ guaranteed after ${preflight.pityCap} dry hunts here`,
                })],
                ...ephemeral,
            });
        case 'no_weapon':
            return interaction.reply({
                content: `You don't have a weapon equipped! Buy one with \`/hunt shop weapon\` and equip it with \`/hunt inv equip 1\`.`,
                ...ephemeral
            });
        case 'weapon_broken':
            return interaction.reply({
                content: preflight.condemned
                    ? `Your **${preflight.weapon.name}** is broken beyond repair — too many shop repairs have worn it out. Buy a replacement with \`/hunt shop weapon\` and discard this one with \`/hunt inv discard\`.`
                    : `Your **${preflight.weapon.name}** is broken! Repair it with \`/hunt shop repair\` or buy a new one with \`/hunt shop weapon\`.`,
                ...ephemeral
            });
        case 'no_ammo':
            return interaction.reply({
                content: `You're out of **${preflight.weaponData.ammoType.replace(/_/g, ' ')}**! Buy more with \`/hunt shop buy\`.`,
                ...ephemeral
            });
        default:
            return interaction.reply({ content: 'You cannot hunt right now.', ...ephemeral });
    }
}

module.exports = {
    executeStart,
    replyHuntPreflightFailure,
    stagedLootReveal,
};
