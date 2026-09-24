'use strict';

// /hunt start — the hunt itself, from preflight through the approach and the
// shot to the staged reveal of what was taken, the apex duel it can trigger,
// and the buttons the result card ends on.
//
// Every beat of an encounter wears the same header (the zone, see
// embeds.sceneAuthor) so the prompts read as one scene changing rather than a
// slideshow of unrelated cards.

const { TIER_NUM, TIER_STARS } = require('../../../data/materialRarity');
const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
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
    huntSuccessChance,
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
const { addWeeklyChampionProgress, getWeeklyChampionLeader } = require('../../../utils/weeklyChampion');
const { getTimeBand } = require('../../../utils/timeBand');
const { gatherPayoutKey } = require('../../../utils/payoutKey');
const { secureRandom } = require('../../../utils/secureRandom');
const {
    pickApproachProfile, runAimPhase, resolveStealth, shuffled,
    STEALTH_OUTCOMES, AIM_FAKEOUT_CHANCE,
} = require('./aim');
const { buildBonusLines, buildHuntEmbed, sceneAuthor, fitEmbeds } = require('./embeds');
const { buildResultActions, attachResultActions } = require('./actions');
const { runApexDuel } = require('./apex');
const { cardChips, renderHuntResultCard } = require('./resultCard');
const { ownedBy } = require('../../../utils/collectorOwner');
const { stagedLootReveal } = require('../../../utils/stagedLootReveal');
const { attachResultThumbnail } = require('../../../utils/itemImageHelper');

// How long the approach prompt waits for a read.
const STEALTH_MS = 15_000;
// The beat the approach result holds before the sights come up.
const STEALTH_RESULT_MS = 1_200;
// A perfect approach on common prey can flush out the bigger animal the hint
// pointed at behind it.
const LURKER_FLUSH_CHANCE = 0.30;

const pct = p => `${Math.round(p * 100)}%`;
const tsRel = date => `<t:${Math.floor(date.getTime() / 1000)}:R>`;
const delay = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Runs one hunt. Resolves `{ started: true }` once a hunt has claimed its
 * cooldown and run — the "Hunt again" button uses it to know whether to retire
 * the card it was pressed on — and undefined when the hunt was refused.
 */
async function executeStart(interaction) {
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
    const weaponIndex = h.equippedWeaponIndex;
    const scene = embed => embed.setAuthor(sceneAuthor(zone, interaction.user));

    try {

        // Ammo comes out only once the cooldown slot is ours, so a lost race never
        // costs the player a round.
        if (weaponData.requiresAmmo) {
            h.ammo[weaponData.ammoType] = (h.ammo[weaponData.ammoType] ?? 0) - 1;
            user.markModified('hunt');
        }

        // Rolled before the prompt so the hint describes the animal that is
        // actually there and the correct approach follows from it.
        let encounter = rollHuntEncounter(user, zoneId);
        // Common prey can have something bigger behind it. It is rolled — and
        // named in the hint — up front, so a perfect approach that flushes it
        // out delivers the animal the player was told about, not a surprise
        // swap for one they never saw.
        const lurker = encounter.tier === 'common' ? rollAnimal('uncommon', zoneId) : null;

        let stealth = { outcome: 'skipped', bonus: 0 };
        let aim = null;
        let flushed = false;

        if (!quick) {
            ({ stealth, flushed, encounter } = await runApproach(interaction, {
                user, weapon, zone, encounter, lurker, scene,
            }));

            // Armoured prey cannot be crit, and the aim phase only moves crit
            // chance — so against it the phase would be a minigame that pays
            // nothing while promising "+18% crit chance". It is skipped, and
            // the result card says why.
            if (!(encounter.animal.traits ?? []).includes('armored')) {
                aim = await runAimPhase(interaction, await interaction.fetchReply(), {
                    scene,
                    fakeOut: secureRandom() < AIM_FAKEOUT_CHANCE,
                });
            }
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
        const result = executeHunt(user, zoneId, {
            stealthBonus: stealth.bonus, aimBonus: aim?.bonus ?? 0, marketplaceActive, encounter,
        });

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
            ({ payoutOwed } = await commitHunt(user, balanceAtLoad, {
                payoutKey: gatherPayoutKey('hunt', interaction.id, 'run'),
            }));
            huntCommitted = true;
        } catch (err) {
            // Nothing was saved, so give the cooldown slot back before telling them to retry.
            await releaseHuntClaim();
            if (isVersionError(err)) {
                return interaction.editReply({ content: 'A simultaneous request conflicted with your hunt. Please try `/hunt start` again.', embeds: [], components: [] });
            }
            console.error('[hunt] save error:', err);
            return interaction.editReply({ content: 'Something went wrong saving your hunt. Please try again.', embeds: [], components: [] });
        }

        if (result.success && result.finalPayout > 0) {
            await addWeeklyChampionProgress({ guildId: interaction.guild.id, category: 'hunt', userId: interaction.user.id, username: interaction.user.username, value: result.finalPayout, details: result.animal ? `${result.animal.emoji} ${result.animal.name} (${currency}${result.finalPayout.toLocaleString()})` : null }).catch(() => null);
        }
        const weeklyLeader = await getWeeklyChampionLeader(interaction.guild.id, 'hunt').catch(() => null);

        // ── The result card ──────────────────────────────────────────────────
        const embed = buildHuntEmbed(result, user, zone, weapon, currency, interaction.user);

        // The picture card leads a kill: the animal's art, the payout and how
        // the run went, drawn above this text (hunt/resultCard). If it cannot
        // be drawn the art falls back to the embed's thumbnail, as before.
        // Either attachment rides every later render of the message, apex
        // phases included.
        const cardArgs = {
            result, zone,
            chips: cardChips({
                result, stealth, aim, quick, flushed, isFeaturedZone, rarePetDrop,
                featuredPct: Math.round(FEATURED_PAYOUT_BONUS * 100),
            }),
        };
        const card = await renderHuntResultCard(cardArgs);
        const lead = card ? [card.embed] : [];
        const catchFiles = card
            ? [card.file]
            : result.success
                ? await attachResultThumbnail(embed, 'hunt', result.animal, interaction.guild.id)
                : [];

        const chips = buildRunChips({ stealth, aim, quick, flushed, encounter, isFeaturedZone, zone });
        const petLine = result.success ? petFlavorLine(user, { isPetActive, PET_DEFS, TRAIT_FLAVOR }) : null;
        if (chips || petLine) {
            embed.setDescription([embed.data.description, '', chips, petLine].filter(v => v !== null && v !== undefined).join('\n'));
        }

        // Rare companion drop — the rarest thing the game hands out, so it
        // leads the fields (and is the last thing a trim would ever touch).
        if (rarePetDrop) {
            embed.spliceFields(0, 0, {
                name: `${rarePetDrop.emoji} A Rare Companion Appears!`,
                value: `A wild **${rarePetDrop.name}** followed you home! It joined your pets at full hunger.\n`
                     + `Passive: **+${rarePetDrop.bonusPct}% ${rarePetDrop.bonusType.replace(/_/g, ' ')}** · Favourite food: \`${rarePetDrop.favoriteMaterial}\`\n`
                     + `*Name it with \`/pet rename\` and keep it fed with \`/pet feed\`.*`,
                inline: false,
            });
        }
        if (payoutOwed > 0) {
            embed.spliceFields(rarePetDrop ? 1 : 0, 0, {
                name: '⚠️ Payout Not Yet Credited',
                value: `The **${currency}${payoutOwed.toLocaleString()}** from this hunt could not be paid out just now and has been recorded as owed — the balance shown below does not include it. It will be applied once the problem clears; tell an admin if it does not.`,
            });
        }

        // One consolidated field rather than one per bonus — they are all the same idea.
        const bonusLines = buildBonusLines(result, petYieldPct, petXpPct);
        if (bonusLines.length) {
            const kitAt = (embed.data.fields ?? []).findIndex(f => f.name === '🎒 Kit');
            embed.spliceFields(kitAt >= 0 ? kitAt : (embed.data.fields?.length ?? 0), 0,
                { name: '✨ Bonuses', value: bonusLines.join('\n'), inline: false });
        }

        // Footer: whatever the card already carries (active buffs), then the
        // time of day and the week's race on a line of their own. Footers
        // cannot render a custom currency emoji, hence "coins".
        const timeBand = getTimeBand();
        const leaderNote = weeklyLeader
            ? `👑 Hunter of the Week: ${weeklyLeader.username} — ${(weeklyLeader.total ?? 0).toLocaleString()} coins`
            : '👑 No Hunter of the Week yet — be the first!';
        const currentFooter = embed.data.footer?.text;
        embed.setFooter({ text: [currentFooter, `${timeBand.emoji} ${timeBand.label} · ${leaderNote}`].filter(Boolean).join('\n') });

        fitEmbeds([...lead, embed]);

        // Staged loot reveal for rare+ drops. A quick hunt skips the ceremony —
        // the fog-and-fanfare build-up is the same forced wait the player opted
        // out of, and the tier is still announced on the card. The buttons ride
        // the final render only, so nothing can be pressed under the fog; an
        // apex duel follows instead of them when one triggers.
        const components = result.apexEncounter ? [] : buildResultActions(user, weapon, quick);
        await stagedLootReveal(interaction, !quick && result.success ? result.tier : null, [...lead, embed], 'hunt', catchFiles, { components });

        // Everything the channel hears about this hunt comes after the card
        // has landed: a "quest complete" posted under the fog gave the result
        // away before the reveal did.
        announceAfterReveal(interaction, guildSettings, user, { huntAchievements, questsDone, questsNear });
        if (result.success && result.finalPayout > 0) {
            const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
            if (result.finalPayout >= bigWinThreshold || ['legendary', 'event'].includes(result.tier)) {
                logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: result.finalPayout, source: 'hunt', details: { itemName: result.animal?.name, rarity: result.tier }, client: interaction.client });
            }
        }
        announceRareDrop(interaction, guildSettings, result, zone);

        if (result.apexEncounter) {
            await runApexDuel(interaction, {
                embed, lead, cardArgs: card ? cardArgs : null, catchFiles,
                result, user, zone, zoneId, weaponIndex, currency, guildSettings,
            });
        } else {
            await attachResultActions(interaction, weaponIndex);
        }
        return { started: true };
    } catch (err) {
        if (!huntCommitted) await releaseHuntClaim();
        throw err;
    }
}

// ─── THE APPROACH ─────────────────────────────────────────────────────────────

/**
 * The stealth prompt and its result. Returns { stealth, flushed, encounter } —
 * `encounter` is the lurker when a perfect approach flushed it out.
 */
async function runApproach(interaction, { user, weapon, zone, encounter, lurker, scene }) {
    const prey = encounter.animal;
    const profile = pickApproachProfile(prey);
    const options = shuffled(profile.options, secureRandom);
    const oddsBefore = huntSuccessChance(user, weapon, zone, prey.traits ?? [], 0);
    const deadline = new Date(Date.now() + STEALTH_MS);

    const promptEmbed = scene(new EmbedBuilder()
        .setColor('#556B2F')
        .setTitle(`🌿 Stalking ${prey.emoji} ${prey.name}`)
        .setDescription(
            `*${profile.hint(prey)}*` +
            (lurker ? `\n*Behind it, something bigger shifts in the brush — a ${lurker.emoji} **${lurker.name}**?*` : '') +
            `\n\n**How do you close in?**\n` +
            `🎯 Shot odds right now: **${pct(oddsBefore)}**\n` +
            `⏳ Decide ${tsRel(deadline)}`
        )
        .setFooter({ text: 'Read the animal — the right approach raises your odds, the wrong one spooks it.' }));

    const row = new ActionRowBuilder().addComponents(
        ...options.map(opt => new ButtonBuilder()
            .setCustomId(`stealth_${opt.id}`)
            .setLabel(opt.label)
            .setStyle(ButtonStyle.Primary))
    );

    await interaction.reply({ embeds: [promptEmbed], components: [row] });
    const huntMsg = await interaction.fetchReply();

    const pickedId = await new Promise(resolve => {
        const col = huntMsg.createMessageComponentCollector({
            filter: ownedBy(interaction.user.id, i => i.customId.startsWith('stealth_'), "This isn't your hunt."),
            time: STEALTH_MS,
            max: 1,
        });
        // Resolve before acknowledging: an ack that rejects must not leave the
        // hunt — and the economy lock it holds — waiting forever.
        col.on('collect', i => {
            resolve(i.customId.replace('stealth_', ''));
            i.deferUpdate().catch(() => {});
        });
        col.on('end', (_, reason) => { if (reason !== 'limit') resolve(null); });
    });

    const stealth = resolveStealth(profile, pickedId);

    let flushed = false;
    let target = encounter;
    if (stealth.outcome === 'perfect' && lurker && secureRandom() < LURKER_FLUSH_CHANCE) {
        target = { tier: 'uncommon', animal: lurker };
        flushed = true;
    }

    const oddsAfter = huntSuccessChance(user, weapon, zone, target.animal.traits ?? [], stealth.bonus);
    const copy = STEALTH_OUTCOMES[stealth.outcome];
    const lines = [];
    if (stealth.label) lines.push(`**${stealth.label}**`, '');
    lines.push(copy.body, '');
    if (flushed) {
        lines.push(`${lurker.emoji} *Your patience pays — the **${lurker.name}** breaks cover. You shift your aim to the bigger prize.*`, '');
    }
    lines.push(oddsAfter === oddsBefore
        ? `🎯 Shot odds: **${pct(oddsAfter)}**`
        : `🎯 Shot odds: **${pct(oddsBefore)}** → **${pct(oddsAfter)}**`);
    if ((target.animal.traits ?? []).includes('armored')) {
        lines.push(`🛡️ *Its hide turns any critical strike — no point lining up a crit. You fire on instinct.*`);
    }

    await interaction.editReply({
        embeds: [scene(new EmbedBuilder().setColor(copy.color).setTitle(copy.title).setDescription(lines.join('\n')))],
        components: [],
    });
    await delay(STEALTH_RESULT_MS);

    return { stealth, flushed, encounter: target };
}

// ─── THE CARD'S RUN LINE ──────────────────────────────────────────────────────

const STEALTH_CHIPS = {
    perfect: '🤫 Perfect approach',
    decent:  '🌿 Decent approach',
    spooked: '🔊 Spooked it',
    timeout: '⏰ Hesitated',
};
const AIM_CHIPS = {
    perfect: '🎯 Perfect shot',
    late:    '✅ Clean shot',
    early:   '💨 Rushed shot',
    timeout: '⏰ Never fired',
};

/** One line of how this run went: the approach, the shot, and anything that bent the result. */
function buildRunChips({ stealth, aim, quick, flushed, encounter, isFeaturedZone, zone }) {
    const chips = [];
    if (STEALTH_CHIPS[stealth.outcome]) chips.push(STEALTH_CHIPS[stealth.outcome]);
    if (flushed) chips.push(`${encounter.animal.emoji} Flushed out bigger prey`);
    if (aim && AIM_CHIPS[aim.grade]) chips.push(AIM_CHIPS[aim.grade]);
    else if (!quick && (encounter.animal.traits ?? []).includes('armored')) chips.push('🛡️ Armored — no crit to aim for');
    if (quick) chips.push('⚡ Quick hunt');
    if (isFeaturedZone) chips.push(`🌟 Featured zone ${zone.emoji} +${Math.round(FEATURED_PAYOUT_BONUS * 100)}%`);
    return chips.length ? chips.join('  ·  ') : null;
}

function petFlavorLine(user, { isPetActive, PET_DEFS, TRAIT_FLAVOR }) {
    const activePet = (user.pets || []).find(p => isPetActive(p));
    if (!activePet) return null;
    const petDef = PET_DEFS[activePet.petId];
    const flavorFn = TRAIT_FLAVOR[activePet.personality]?.hunt;
    if (!flavorFn || !petDef) return null;
    return `> ${flavorFn(activePet.name || petDef.name || activePet.petId, petDef.emoji)}`;
}

// ─── ANNOUNCEMENTS ────────────────────────────────────────────────────────────

function announceAfterReveal(interaction, guildSettings, user, { huntAchievements, questsDone, questsNear }) {
    if (huntAchievements.length) {
        announceAchievements(interaction.client, guildSettings, user, interaction.member, huntAchievements).catch(() => null);
    }
    notifyQuestComplete(guildSettings, interaction.member, questsDone, interaction.channel, user).catch(() => null);
    notifyQuestNearComplete(guildSettings, interaction.member, questsNear, interaction.channel).catch(() => null);
}

/**
 * Epic-and-better finds are broadcast to the server's announcement channel.
 * Only there: with none configured, the find's own card is already in the
 * channel, and a second embed restating it underneath was noise.
 */
function announceRareDrop(interaction, guildSettings, result, zone) {
    if (!result.success || !['epic', 'legendary', 'event'].includes(result.tier)) return;
    if (guildSettings?.economy?.announceRareDrops === false) return;
    const announceChannelId = guildSettings?.economy?.announcementChannelId;
    const channel = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
    if (!channel?.isTextBased() || channel.id === interaction.channelId) return;

    const announceTier = TIER_NUM[result.tier] ?? 4;
    const ANNOUNCE_COPY = {
        4: { color: '#9c27b0', title: '🔮 Epic Find!',              line: 'A rare moment in the wild.' },
        5: { color: '#ff9800', title: '✨ Legendary Trophy! ✨',     line: 'Only a handful of hunters have ever managed that.' },
        6: { color: '#e74c3c', title: '☄️ Mythical Quarry! ☄️',     line: 'Nothing like it has been seen in living memory.' },
    };
    const copy = ANNOUNCE_COPY[announceTier] ?? ANNOUNCE_COPY[4];
    channel.send({ embeds: [new EmbedBuilder()
        .setColor(copy.color)
        .setTitle(copy.title)
        .setDescription(
            `<@${interaction.user.id}> just brought down ${result.animal.emoji} **${result.animal.name}** [${TIER_STARS[announceTier]}]\n` +
            `deep in the **${zone.name}**.\n\n` +
            copy.line
        )
        .setTimestamp()] }).catch(() => null);
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
                content: `You're injured and need to rest. Back in action <t:${Math.floor((Date.now() + preflight.remainingMs) / 1000)}:R> (${formatMs(preflight.remainingMs)}).`,
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
                content: `You don't have a weapon equipped! Buy one with \`/hunt shop weapon\` and equip it with \`/hunt equip 1\`.`,
                ...ephemeral
            });
        case 'weapon_broken':
            return interaction.reply({
                content: preflight.condemned
                    ? `Your **${preflight.weapon.name}** is broken beyond repair — too many shop repairs have worn it out. Buy a replacement with \`/hunt shop weapon\` and discard this one with \`/hunt discard\`.`
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
    LURKER_FLUSH_CHANCE,
    STEALTH_MS,
    buildRunChips,
    executeStart,
    replyHuntPreflightFailure,
    runApproach,
};
