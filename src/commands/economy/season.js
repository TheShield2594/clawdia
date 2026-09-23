const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const SeasonRecord = require('../../models/SeasonRecord');
const { ensureMissions: ensureMissionsShared, withTodaysMissions } = require('../../services/seasonMissionService');
const { SEASONAL_EVENTS } = require('../../data/seasonalEvents');
const { getEventCurrencyBalance } = require('../../services/seasonalEventService');
const { progressBar } = require('../../utils/progressBar');
const { isVersionError } = require('../../utils/versionRetry');
const { rewardReveal } = require('../../utils/rewardReveal');
const { logTransaction } = require('../../utils/logTransaction');
const { awardSeasonXp } = require('../../services/questService');
const { saveWithBalanceDelta } = require('../../utils/balanceDelta');
const { grantItemsOrOwe } = require('../../utils/creditOrOwe');
const { seasonTierCoinPayoutKey, seasonTierItemPayoutKey, seasonClaimAllCoinsPayoutKey, seasonMissionCoinPayoutKey } = require('../../utils/payoutKey');
const { packFieldsCapped } = require('../../utils/embedFields');
const { seasonLabel, SEASON_NAME_MAX } = require('../../utils/seasonLabel');
const { resolveOneSeason } = require('../../services/economySeasonService');
const { freshSeason, recordSeasonReset, recordTierClaim, claimMissionSlot, resetStaleSeason } = require('../../models/seasonWrites');

// Reset a stale season sub-document (a new season started), so no xp, claimed
// tiers or premium carry across seasons. Returns true if a reset happened.
function normalizeSeason(user, seasonId) {
    if (!seasonId) return false;
    if (user.season?.seasonId === seasonId) return false;
    user.season = freshSeason(seasonId);
    recordSeasonReset(user, seasonId); // committed after the save (#873, pass 19)
    return true;
}

// ── Battle pass tier definitions ─────────────────────────────────────────────
// 50 tiers across a free track and a premium track (see src/data/seasonPass.js).
// Premium is unlocked with a large coin payment (/season unlock) — the economy's
// primary deliberate money sink.
const { TIER_COUNT, XP_PER_TIER, TIER_TABLE, loreForTier } = require('../../data/seasonPass');
const COLORS = require('../../utils/embedColors');

const MAX_TIERS = TIER_COUNT;
const DEFAULT_PREMIUM_COST = 100_000;
// Fields the seasonal event's milestone list may spill into before it is
// cut short — the embed's other budget is 6,000 characters across all of
// them, and this embed carries three more.
const MILESTONE_FIELDS = 3;

function tierDef(tier)     { return TIER_TABLE[tier - 1] ?? null; }
function rewardFor(tier, premium) {
    const def = tierDef(tier);
    return def ? (premium ? def.premium : def.free) : null;
}

function getTierFromXp(xp) {
    return Math.min(MAX_TIERS, Math.floor(xp / XP_PER_TIER));
}

function xpProgressBar(xp) {
    const currentTier = getTierFromXp(xp);
    if (currentTier >= MAX_TIERS) return 'MAX TIER ✅';
    const xpInTier = xp % XP_PER_TIER;
    const pct = xpInTier / XP_PER_TIER;
    const filled = Math.round(pct * 10);
    return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${xpInTier}/${XP_PER_TIER} XP (Tier ${currentTier} → ${currentTier + 1})`;
}

// The rollover lives in seasonMissionService so that opening this menu and
// acting in the world deal from the same deck — two copies would drift, and the
// copy that ran first would decide which day's missions the other one advanced.
async function ensureMissions(user) {
    ensureMissionsShared(user);
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

// Every player-facing subcommand opens the same way, and did so in seven
// identical copies: the caller's row, created on first use, and the guild's
// settings read beside it. The settings read goes through the cache (#877), so
// the round trip this waits on is the upsert alone.
async function loadPlayerAndSettings(interaction) {
    return Promise.all([
        User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        ),
        getGuildSettings(interaction.guild.id),
    ]);
}

async function executeView(interaction) {
    const [loaded, guildSettings] = await loadPlayerAndSettings(interaction);

    const season = guildSettings?.season;
    if (!season?.enabled || !season?.seasonId) {
        return interaction.reply({ content: 'No active season pass is running on this server right now.', flags: MessageFlags.Ephemeral });
    }

    const user = await withTodaysMissions(User, { userId: interaction.user.id, guildId: interaction.guild.id }, loaded);
    // Progress stored under an earlier season shows as a fresh pass. Only for
    // display: the view writes nothing (#873, pass 18) — it used to reset the
    // stored season sub-document here and save it, a whole-object `$set` over
    // anything granted in between. The reward paths normalise where they write.
    const pass = user.season?.seasonId === season.seasonId ? user.season : {};

    const userXp = pass.xp ?? 0;
    const currentTier = getTierFromXp(userXp);
    const premium = pass.premium === true;
    const claimedFree    = new Set(pass.claimedTiers ?? []);
    const claimedPremium = new Set(pass.claimedPremiumTiers ?? []);
    const currency = guildSettings?.economy?.currency ?? '💰';

    // Upcoming rewards across both tracks
    const upcoming = TIER_TABLE
        .filter(t => t.tier > currentTier)
        .slice(0, 4)
        .map(t => `**Tier ${t.tier}** — 🆓 ${t.free.label}  ·  ✨ ${t.premium.label}`)
        .join('\n') || 'All tiers unlocked! 🎉';

    // Unclaimed rewards already available
    const claimableFree = TIER_TABLE.filter(t => t.tier <= currentTier && !claimedFree.has(t.tier)).length;
    const claimablePrem = premium
        ? TIER_TABLE.filter(t => t.tier <= currentTier && !claimedPremium.has(t.tier)).length
        : 0;

    const endsIn = season.endDate
        ? `<t:${Math.floor(new Date(season.endDate).getTime() / 1000)}:R>`
        : '*No end date set*';

    const premiumCost = season.premiumCost ?? DEFAULT_PREMIUM_COST;
    const premiumLine = premium
        ? '✨ **Premium unlocked** — claim premium rewards on every tier you reach.'
        : `🔒 Premium locked — unlock both tracks for **${currency}${premiumCost.toLocaleString()}** with \`/season unlock\`.`;

    const weeklyCap = season.weeklyXpCap ?? 0;
    const weekXp    = pass.weekXp ?? 0;
    const weeklyLine = weeklyCap > 0
        ? `\n🗓️ Weekly XP: **${Math.min(weekXp, weeklyCap)}/${weeklyCap}**`
        : '';

    const embed = new EmbedBuilder()
        .setColor(premium ? '#ffd700' : '#5865f2')
        .setTitle(`🎫 ${season.name ?? 'Season Pass'}`)
        .setDescription(`${premiumLine}${weeklyLine}`)
        .addFields(
            { name: '📊 Your Progress', value: xpProgressBar(userXp) },
            { name: '🏆 Current Tier', value: `**Tier ${currentTier} / ${MAX_TIERS}**`, inline: true },
            { name: '⏰ Season Ends', value: endsIn, inline: true },
            { name: '🎁 Unclaimed', value: `🆓 ${claimableFree} free${premium ? `  ·  ✨ ${claimablePrem} premium` : ''}`, inline: true },
            { name: '🪜 Upcoming Rewards', value: upcoming },
            {
                name: '📋 Today\'s Missions',
                value: (user.seasonMissions ?? []).map(m =>
                    `${m.completed ? '✅' : '🔲'} ${m.description} (${m.progress}/${m.target}) → +${m.seasonXp} XP, ${m.coinReward} ${currency}`
                ).join('\n') || '*No missions generated*'
            }
        )
        .setFooter({ text: `Season XP: ${userXp} total | /season claim tier:<n> [premium:true]` })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeClaim(interaction) {
    const tier = interaction.options.getInteger('tier');
    const [user, guildSettings] = await loadPlayerAndSettings(interaction);

    const season = guildSettings?.season;
    if (!season?.enabled || !season?.seasonId) {
        return interaction.reply({ content: 'No active season pass is running.', flags: MessageFlags.Ephemeral });
    }

    const wantsPremium = interaction.options.getBoolean('premium') ?? false;
    const currency = guildSettings?.economy?.currency ?? '💰';
    normalizeSeason(user, season.seasonId); // drop stale cross-season progress
    const userXp = user.season?.xp ?? 0;
    const unlockedTier = getTierFromXp(userXp);

    // Guard against missing sub-document arrays on old docs
    if (!user.season) user.season = {};
    if (!Array.isArray(user.season.claimedTiers))        user.season.claimedTiers = [];
    if (!Array.isArray(user.season.claimedPremiumTiers)) user.season.claimedPremiumTiers = [];

    const claimedTiers = new Set(wantsPremium ? user.season.claimedPremiumTiers : user.season.claimedTiers);

    if (tier > MAX_TIERS || tier < 1) {
        return interaction.reply({ content: `Tier must be between 1 and ${MAX_TIERS}.`, flags: MessageFlags.Ephemeral });
    }
    if (wantsPremium && user.season.premium !== true) {
        const premiumCost = season.premiumCost ?? DEFAULT_PREMIUM_COST;
        return interaction.reply({ content: `You haven't unlocked the premium track. Unlock it for **${currency}${premiumCost.toLocaleString()}** with \`/season unlock\`.`, flags: MessageFlags.Ephemeral });
    }
    if (tier > unlockedTier) {
        return interaction.reply({
            content: `You haven't unlocked Tier ${tier} yet! You're at Tier ${unlockedTier}.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (claimedTiers.has(tier)) {
        return interaction.reply({ content: `You've already claimed Tier ${tier}'s ${wantsPremium ? 'premium' : 'free'} reward!`, flags: MessageFlags.Ephemeral });
    }

    const reward = rewardFor(tier, wantsPremium);
    if (!reward) return interaction.reply({ content: 'Invalid tier.', flags: MessageFlags.Ephemeral });

    // The reward coins ride out as an `$inc`, not as part of the save: `save()`
    // writes `balance` as an absolute `$set` computed from the read at the top of
    // this command, which would erase anything the player earned or spent since.
    const balanceAtLoad = user.balance ?? 0;

    if (reward.coins > 0) user.balance += reward.coins;
    (wantsPremium ? user.season.claimedPremiumTiers : user.season.claimedTiers).push(tier);
    const track = wantsPremium ? 'premium' : 'free';
    recordTierClaim(user, season.seasonId, track, tier); // an $addToSet after the save (#873, pass 19)

    let coinsOwed = 0;
    try {
        // The `payoutKey` makes the owed record replayable and the credit
        // exactly-once (#873, pass 7): unkeyed, a failed credit left the coins in
        // a keyless `FailedJob` `payouts:replay` cannot pay, tier already claimed.
        const paid = await saveWithBalanceDelta(User, user, balanceAtLoad,
            { service: 'season', jobName: 'tierRewardCoins', guildId: interaction.guild.id, payoutKey: seasonTierCoinPayoutKey(season.seasonId, interaction.user.id, tier, track) });
        if (!paid.credited) coinsOwed = reward.coins ?? 0;
    } catch (err) {
        if (isVersionError(err)) return interaction.reply({ content: 'Edit conflict — try again.', flags: MessageFlags.Ephemeral });
        throw err;
    }

    // The claim is recorded; the item now lands as its own atomic upsert rather
    // than riding the save — an inventory array written through `save()` would
    // flatten any credit that landed since the read, and a slot pushed in memory
    // can duplicate one a concurrent credit is creating
    // (src/utils/inventoryGrant.js). A grant that fails is owed and logged, not
    // lost silently — same posture as the coins above.
    let itemOwed = false;
    if (reward.itemId) {
        // Keyed through the shared helper (#873, pass 7): the bare
        // `grantInventoryItem` read `null` (a pruned document) as success, so a
        // claimed tier could report an item it never granted. The helper reads
        // the result back, records a replayable owed payload, and never throws.
        const granted = await grantItemsOrOwe({ userId: interaction.user.id, guildId: interaction.guild.id }, reward.itemId, 1,
            { payoutKey: seasonTierItemPayoutKey(season.seasonId, interaction.user.id, tier, track), service: 'season', jobName: 'tierRewardItem' });
        if (!granted.granted) itemOwed = true;
    }

    // Social proof: how many users in this guild have claimed this tier (this track)
    const claimedCount = await User.countDocuments({
        guildId: interaction.guild.id,
        [wantsPremium ? 'season.claimedPremiumTiers' : 'season.claimedTiers']: tier
    }).catch(() => null);

    // Next tier teaser (same track)
    const nextTier = tier + 1 <= MAX_TIERS ? tierDef(tier + 1) : null;
    const nextReward = nextTier ? rewardFor(tier + 1, wantsPremium) : null;
    const xpToNext = nextTier ? Math.max(0, (tier + 1) * XP_PER_TIER - (user.season?.xp ?? 0)) : 0;

    const lore = loreForTier(tier);

    const trackLabel = wantsPremium ? '✨ Premium' : '🆓 Free';
    const embed = new EmbedBuilder()
        .setColor(wantsPremium ? '#ffd700' : '#5865f2')
        .setTitle(`${trackLabel} — Tier ${tier}`)
        .setDescription(
            `> *${lore}*\n\n` +
            `You received: **${reward.label}**` +
            (reward.coins > 0
                ? (coinsOwed > 0
                    ? `\n⚠️ **${reward.coins.toLocaleString()} ${currency}** could not be credited just now and has been recorded as owed — your wallet does not include it yet.`
                    : `\n+**${reward.coins.toLocaleString()} ${currency}** added to your wallet`)
                : '') +
            (itemOwed
                ? `\n⚠️ **${reward.label}** could not be added to your inventory just now — it has been logged and an admin can restore it.`
                : '')
        );

    if (nextTier && nextReward) {
        embed.addFields({
            name: `⏭️ Next: Tier ${nextTier.tier} (${wantsPremium ? 'premium' : 'free'})`,
            value: `${nextReward.label}${xpToNext > 0 ? ` — ${xpToNext} XP away` : ' — **Ready to claim!**'}`
        });
    }

    if (claimedCount !== null) {
        embed.setFooter({ text: `${claimedCount.toLocaleString()} player${claimedCount === 1 ? '' : 's'} have unlocked Tier ${tier}` });
    }

    embed.setTimestamp();

    // Broadcast milestone tiers (every 10th) to the announcement channel —
    // with 50 tiers, broadcasting everything past 10 would be spam.
    if (tier % 10 === 0) {
        const announceChannelId = guildSettings?.economy?.announcementChannelId;
        if (announceChannelId) {
            const announceChannel = interaction.guild.channels.cache.get(announceChannelId);
            if (announceChannel?.isTextBased?.()) {
                const broadcastEmbed = new EmbedBuilder()
                    .setColor('#ff6200')
                    .setTitle('🌟 Mythic Tier Unlocked!')
                    .setDescription(
                        `<@${interaction.user.id}> just claimed **Tier ${tier}** of the Season Pass!\n` +
                        `Reward: **${reward.label}**`
                    )
                    .setTimestamp();
                announceChannel.send({ embeds: [broadcastEmbed] }).catch(() => {});
            }
        }
    }

    return rewardReveal({
        interaction,
        suspenseTitle: `🎫 Opening Tier ${tier} Reward…`,
        suspenseText: '*Unlocking your season pass reward…*',
        suspenseColor: '#5865f2',
        resultEmbed: embed,
        delayMs: 900,
    });
}

async function executeUnlock(interaction) {
    const [user, guildSettings] = await loadPlayerAndSettings(interaction);

    const season = guildSettings?.season;
    if (!season?.enabled || !season?.seasonId) {
        return interaction.reply({ content: 'No active season pass is running.', flags: MessageFlags.Ephemeral });
    }

    const currency = guildSettings?.economy?.currency ?? '💰';
    const cost = season.premiumCost ?? DEFAULT_PREMIUM_COST;

    // If the user's season state is stale, reset it to the current season first.
    if (user.season?.seasonId !== season.seasonId) {
        await User.updateOne(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $set: { 'season.seasonId': season.seasonId, 'season.premium': false, 'season.claimedPremiumTiers': [] } }
        );
    } else if (user.season?.premium === true) {
        return interaction.reply({ content: '✨ You already have the premium track unlocked this season.', flags: MessageFlags.Ephemeral });
    }

    // Atomic: debit the cost and flip premium on in one guarded update (coin sink).
    const unlocked = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: cost }, 'season.premium': { $ne: true } },
        { $inc: { balance: -cost }, $set: { 'season.premium': true } },
        { new: true }
    );
    if (!unlocked) {
        const bal = (await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }, 'balance'))?.balance ?? 0;
        return interaction.reply({ content: `You need **${currency}${cost.toLocaleString()}** to unlock the premium track — you have **${currency}${bal.toLocaleString()}**.`, flags: MessageFlags.Ephemeral });
    }
    logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'season_premium', amount: -cost, balance: unlocked.balance, note: 'Season pass premium unlock' });

    const unlockedTier = getTierFromXp(unlocked.season?.xp ?? 0);
    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle('✨ Premium Season Pass Unlocked!')
        .setDescription(
            `You paid **${currency}${cost.toLocaleString()}** to unlock the **premium track** for **${season.name ?? 'this season'}**.\n\n` +
            `Premium rewards are now claimable on every tier you've reached` +
            (unlockedTier > 0 ? ` — that's **${unlockedTier}** tier${unlockedTier === 1 ? '' : 's'} ready right now!` : '.') +
            `\n\nClaim them with \`/season claim tier:<n> premium:true\`.`
        )
        .setFooter({ text: 'Premium rewards include exclusive items and richer coin payouts.' })
        .setTimestamp();
    return interaction.reply({ embeds: [embed] });
}

async function executeMissions(interaction) {
    const [loaded, guildSettings] = await loadPlayerAndSettings(interaction);

    const season = guildSettings?.season;
    if (!season?.enabled) {
        return interaction.reply({ content: 'No active season on this server.', flags: MessageFlags.Ephemeral });
    }

    const user = await withTodaysMissions(User, { userId: interaction.user.id, guildId: interaction.guild.id }, loaded);
    const currency = guildSettings?.economy?.currency ?? '💰';

    const missionLines = (user.seasonMissions ?? []).map((m, i) => {
        const status = m.claimed ? '✅ Claimed' : m.completed ? '🎯 Complete — use /season claim-mission' : `🔲 ${m.progress}/${m.target}`;
        return `**Mission ${i + 1}:** ${m.description}\n${status} → +${m.seasonXp} Season XP, ${m.coinReward.toLocaleString()} ${currency}`;
    });

    const resetAt = new Date();
    resetAt.setUTCHours(24, 0, 0, 0);

    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle('📋 Daily Missions')
        .setDescription(missionLines.join('\n\n') || '*No missions generated*')
        .setFooter({ text: `Resets at midnight UTC` })
        .addFields({ name: '⏰ Next Reset', value: `<t:${Math.floor(resetAt.getTime() / 1000)}:R>`, inline: true })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeClaimMission(interaction) {
    const missionIndex = interaction.options.getInteger('mission') - 1;
    const [user, guildSettings] = await loadPlayerAndSettings(interaction);

    const season = guildSettings?.season;
    if (!season?.enabled) return interaction.reply({ content: 'No active season.', flags: MessageFlags.Ephemeral });

    await ensureMissions(user);
    const currency = guildSettings?.economy?.currency ?? '💰';
    const mission = user.seasonMissions?.[missionIndex];

    if (!mission) return interaction.reply({ content: 'Invalid mission number.', flags: MessageFlags.Ephemeral });
    // Derive completion from progress vs target (completed flag is set by action handlers)
    const isDone = mission.completed || mission.progress >= mission.target;
    if (!isDone) return interaction.reply({ content: 'Mission not completed yet.', flags: MessageFlags.Ephemeral });
    if (mission.claimed) return interaction.reply({ content: 'Already claimed!', flags: MessageFlags.Ephemeral });

    // Its own guarded write; the missions array no longer rides the save (#873, pass 19).
    const filter = { userId: interaction.user.id, guildId: interaction.guild.id };
    if (!await claimMissionSlot(User, filter, missionIndex, mission, user.seasonMissionsDate)) {
        return interaction.reply({ content: 'Already claimed!', flags: MessageFlags.Ephemeral });
    }
    const balanceAtLoad = user.balance ?? 0;
    user.seasonMissions[missionIndex].claimed = true;
    normalizeSeason(user, season.seasonId);
    // Route through the shared grant so the weekly XP cap and rollover apply.
    // awardSeasonXp returns the actual granted amount (may be < mission.seasonXp if capped).
    const grantedXp = await awardSeasonXp(user, mission.seasonXp, guildSettings);
    user.balance += mission.coinReward;

    // Names this mission instance for the key: the slot in a set dealt fresh
    // each UTC day, so today's slot 2 and tomorrow's are different credits (#873).
    const missionDay = user.seasonMissionsDate ? new Date(user.seasonMissionsDate).getTime() : 'na';
    let missionCoinsOwed = 0;
    try {
        // Keyed so the owed record is replayable and the credit exactly-once;
        // unkeyed, a failed credit locked the mission as claimed with coins lost.
        const paid = await saveWithBalanceDelta(User, user, balanceAtLoad,
            { service: 'season', jobName: 'missionRewardCoins', guildId: interaction.guild.id, payoutKey: seasonMissionCoinPayoutKey(season.seasonId, interaction.user.id, missionDay, missionIndex) });
        if (!paid.credited) missionCoinsOwed = mission.coinReward ?? 0;
    } catch (err) {
        if (isVersionError(err)) return interaction.reply({ content: 'Edit conflict — try again.', flags: MessageFlags.Ephemeral });
        throw err;
    }

    return interaction.reply({
        content: missionCoinsOwed > 0
            ? `✅ Mission claimed! +**${grantedXp} Season XP**. ⚠️ The **${missionCoinsOwed.toLocaleString()} ${currency}** could not be credited just now and has been recorded as owed — your wallet does not include it yet.`
            : `✅ Mission claimed! +**${grantedXp} Season XP** and +**${mission.coinReward.toLocaleString()} ${currency}**`,
        flags: MessageFlags.Ephemeral
    });
}

async function executeClaimAll(interaction) {
    const [user, guildSettings] = await loadPlayerAndSettings(interaction);

    const season = guildSettings?.season;
    if (!season?.enabled || !season?.seasonId) {
        return interaction.reply({ content: 'No active season pass is running.', flags: MessageFlags.Ephemeral });
    }

    normalizeSeason(user, season.seasonId);
    const currency = guildSettings?.economy?.currency ?? '💰';
    const wantsPremium = interaction.options.getBoolean('premium') ?? false;

    if (wantsPremium && user.season?.premium !== true) {
        const premiumCost = season.premiumCost ?? DEFAULT_PREMIUM_COST;
        return interaction.reply({
            content: `You haven't unlocked the premium track. Use \`/season unlock\` for **${currency}${premiumCost.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    if (!user.season) user.season = {};
    if (!Array.isArray(user.season.claimedTiers))        user.season.claimedTiers = [];
    if (!Array.isArray(user.season.claimedPremiumTiers)) user.season.claimedPremiumTiers = [];

    const userXp = user.season?.xp ?? 0;
    const unlockedTier = getTierFromXp(userXp);
    const claimedSet = new Set(wantsPremium ? user.season.claimedPremiumTiers : user.season.claimedTiers);

    const claimable = TIER_TABLE.filter(t => t.tier <= unlockedTier && !claimedSet.has(t.tier));

    if (claimable.length === 0) {
        return interaction.reply({
            content: `No unclaimed ${wantsPremium ? 'premium' : 'free'} rewards available. Keep earning Season XP to unlock more tiers!`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const trackId = wantsPremium ? 'premium' : 'free';
    const balanceAtLoad = user.balance ?? 0;
    let totalCoins = 0;
    const itemsClaimed = [];
    const itemsToGrant = [];

    for (const tierDef of claimable) {
        const reward = rewardFor(tierDef.tier, wantsPremium);
        if (!reward) continue;

        if (reward.coins > 0) {
            user.balance += reward.coins;
            totalCoins += reward.coins;
        }
        if (reward.itemId) {
            itemsClaimed.push(reward.label);
            // The tier rides along so each item grants under its own per-tier key
            // below — the same key a single claim would use (#873, pass 7).
            itemsToGrant.push({ tier: tierDef.tier, itemId: reward.itemId });
        }

        (wantsPremium ? user.season.claimedPremiumTiers : user.season.claimedTiers).push(tierDef.tier);
        recordTierClaim(user, season.seasonId, wantsPremium ? 'premium' : 'free', tierDef.tier);
    }

    // Names this batch for the coin key: the exact set of tiers claimed, so two
    // concurrent claim-alls compute the same key and the second is a no-op (#873).
    const tierSignature = claimable.map(t => t.tier).join('.');
    let batchCoinsOwed = 0;
    try {
        // The whole batch goes out as one `$inc`; keyed, an owed record is
        // replayable and the credit exactly-once (a batch is noticed if missing).
        const paid = await saveWithBalanceDelta(User, user, balanceAtLoad,
            { service: 'season', jobName: 'claimAllRewardCoins', guildId: interaction.guild.id, payoutKey: seasonClaimAllCoinsPayoutKey(season.seasonId, interaction.user.id, trackId, tierSignature) });
        if (!paid.credited) batchCoinsOwed = totalCoins;
    } catch (err) {
        if (isVersionError(err)) return interaction.reply({ content: 'Edit conflict — try again.', flags: MessageFlags.Ephemeral });
        throw err;
    }

    // Each reward item lands through the shared helper, keyed per tier, rather
    // than one bare pipeline that read nothing back and filed nothing on failure
    // (#873, pass 7). The helper grants each exactly once and records a
    // replayable owed payload for any that miss.
    let itemsOwedCount = 0;
    for (const { tier: itemTier, itemId } of itemsToGrant) {
        const granted = await grantItemsOrOwe({ userId: interaction.user.id, guildId: interaction.guild.id }, itemId, 1,
            { payoutKey: seasonTierItemPayoutKey(season.seasonId, interaction.user.id, itemTier, trackId), service: 'season', jobName: 'claimAllRewardItem' });
        if (!granted.granted) itemsOwedCount++;
    }
    const itemsOwed = itemsOwedCount > 0;

    const track = wantsPremium ? '✨ Premium' : '🆓 Free';
    const tierNums = claimable.map(t => t.tier);
    const tierRange = tierNums.length === 1
        ? `Tier ${tierNums[0]}`
        : `Tiers ${tierNums[0]}–${tierNums[tierNums.length - 1]}`;

    const lines = [`Claimed **${claimable.length}** reward${claimable.length !== 1 ? 's' : ''}:`];
    if (totalCoins > 0) {
        lines.push(batchCoinsOwed > 0
            ? `⚠️ **${totalCoins.toLocaleString()} ${currency}** could not be credited just now and has been recorded as owed — your wallet does not include it yet.`
            : `💰 +**${totalCoins.toLocaleString()} ${currency}**`);
    }
    if (itemsClaimed.length > 0) {
        lines.push(itemsOwed
            ? `⚠️ Items (${itemsClaimed.join(', ')}) could not be added to your inventory just now — they have been logged and an admin can restore them.`
            : `🎁 Items: ${itemsClaimed.join(', ')}`);
    }

    const embed = new EmbedBuilder()
        .setColor(wantsPremium ? '#ffd700' : '#5865f2')
        .setTitle(`${track} — ${tierRange} Claimed!`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Balance: ${user.balance.toLocaleString()} coins` })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ── Economy season (issue #238) subcommands ───────────────────────────────────

async function executeLeaderboard(interaction) {
    const guildSettings = await getGuildSettings(interaction.guild.id);
    const currentSeason = guildSettings?.currentSeason;

    if (!currentSeason?.id) {
        return interaction.reply({ content: 'No active economy season on this server.', flags: MessageFlags.Ephemeral });
    }

    const topUsers = await User.find({ guildId: interaction.guild.id })
        .sort({ seasonCoins: -1 })
        .limit(10)
        .select('userId seasonCoins');

    if (topUsers.length === 0) {
        return interaction.reply({ content: 'No season data yet.', flags: MessageFlags.Ephemeral });
    }

    const currency = guildSettings?.economy?.currency ?? '💰';
    const medals = ['🥇', '🥈', '🥉'];
    const lines = topUsers.map((u, i) =>
        `${medals[i] ?? `${i + 1}.`} <@${u.userId}> — **${(u.seasonCoins ?? 0).toLocaleString()}** ${currency}`
    );

    const endsAt = currentSeason.endsAt
        ? `<t:${Math.floor(new Date(currentSeason.endsAt).getTime() / 1000)}:R>`
        : '*No end date*';

    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle(`📊 Season Leaderboard — ${seasonLabel(currentSeason)}`)
        .setDescription(lines.join('\n'))
        .addFields({ name: '⏰ Season Ends', value: endsAt, inline: true })
        .setFooter({ text: 'Only season coins earned this season count — wallet is never reset!' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeSeasonMe(interaction) {
    const [user, guildSettings] = await Promise.all([
        User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
        getGuildSettings(interaction.guild.id)
    ]);

    const currentSeason = guildSettings?.currentSeason;
    if (!currentSeason?.id) {
        return interaction.reply({ content: 'No active economy season on this server.', flags: MessageFlags.Ephemeral });
    }

    if (!user) {
        return interaction.reply({ content: 'No profile found. Use an economy command first.', flags: MessageFlags.Ephemeral });
    }

    const currency = guildSettings?.economy?.currency ?? '💰';
    const rank = await User.countDocuments({
        guildId: interaction.guild.id,
        seasonCoins: { $gt: user.seasonCoins ?? 0 }
    }) + 1;

    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(`📊 Your Season Stats — ${seasonLabel(currentSeason)}`)
        .addFields(
            { name: 'Season Rank', value: `#${rank}`, inline: true },
            { name: 'Season Coins', value: `${(user.seasonCoins ?? 0).toLocaleString()} ${currency}`, inline: true }
        )
        .setFooter({ text: 'Season coins track earnings only — your wallet balance is unaffected' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeHistory(interaction) {
    const records = await SeasonRecord.find({ guildId: interaction.guild.id })
        .sort({ endedAt: -1 })
        .limit(5);

    if (records.length === 0) {
        return interaction.reply({ content: 'No past seasons recorded for this server.', flags: MessageFlags.Ephemeral });
    }

    const fields = records.map(r => ({
        name: `${seasonLabel({ name: r.seasonName, id: r.seasonId })} (ended <t:${Math.floor(new Date(r.endedAt).getTime() / 1000)}:D>)`,
        value: (r.top10 ?? []).slice(0, 3).map((u, i) => {
            const medals = ['🥇', '🥈', '🥉'];
            return `${medals[i]} <@${u.userId}> — ${u.coins.toLocaleString()} coins`;
        }).join('\n') || 'No data',
        inline: false
    }));

    const embed = new EmbedBuilder()
        .setColor(COLORS.NEUTRAL)
        .setTitle('📜 Season History')
        .addFields(fields)
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// Admin: start economy season
// The two admin writes below read currentSeason to decide whether to write it, so
// they go to the model rather than getGuildSettings: a cached read would put a TTL
// between the check and the write. Projected, which is what the cache was for.
// `/season end` hands the result to the resolver, which also needs the
// currency, announcement channel and AI settings its recap uses.
const readSeasonForWrite = guildId => Guild.findOne({ guildId }, 'guildId name currentSeason economy ai').lean();

async function executeAdminStart(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Administrator only.', flags: MessageFlags.Ephemeral });
    }

    const name = interaction.options.getString('name') ?? `Season ${Date.now()}`;
    const durationDays = interaction.options.getInteger('duration') ?? 90;
    const guildSettings = await readSeasonForWrite(interaction.guild.id);

    if (guildSettings?.currentSeason?.id) {
        return interaction.reply({ content: 'A season is already active. End it first with `/season end`.', flags: MessageFlags.Ephemeral });
    }

    const seasonId = `season_${Date.now()}`;
    const now = new Date();
    const endsAt = new Date(now.getTime() + durationDays * 86400000);

    // Guarded on no season being active (#873, pass 18). The check above is a
    // read; two admins running /season start together both passed it, and the
    // second unguarded `$set` replaced the first season — its id, and the
    // SeasonRecord it would have been frozen under — without either being told.
    const started = await Guild.findOneAndUpdate(
        { guildId: interaction.guild.id, 'currentSeason.id': null },
        { $set: { currentSeason: { id: seasonId, name, startedAt: now, endsAt } } }
    );
    if (!started) {
        return interaction.reply({ content: 'A season is already active. End it first with `/season end`.', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({
        content: `✅ Economy season **${seasonLabel({ name })}** started! Ends <t:${Math.floor(endsAt.getTime() / 1000)}:R>.`,
    });
}

// Admin: end economy season
//
// Ends the season through the same resolver the scheduler's sweep uses (#873,
// pass 18). This handler used to carry its own copy of the ending — freeze,
// reset, clear — with none of the resolver's claim: an admin's end racing the
// sweep ran the freeze and the reset twice, and its closing `$set`, unguarded on
// which season it cleared, could erase a season a second admin had started in
// between. One path now, claimed atomically; the admin additionally gets the
// recap DMs and announcement an automatic end already sent.
async function executeAdminEnd(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Administrator only.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    const guildDoc = await readSeasonForWrite(interaction.guild.id);
    if (!guildDoc?.currentSeason?.id) {
        return interaction.editReply('No active economy season to end.');
    }

    const ended = await resolveOneSeason(interaction.client, guildDoc);
    if (!ended) {
        // Claimed by someone else between the read and the claim — the sweep,
        // or another admin. It is ended either way; this call just didn't do it.
        return interaction.editReply('That season has just been ended already — its results are being posted.');
    }

    const currency = guildDoc.economy?.currency ?? '💰';
    const medals = ['🥇', '🥈', '🥉'];
    const winnerLines = ended.topUsers.slice(0, 3).map((u, i) =>
        `${medals[i]} <@${u.userId}> — ${(u.seasonCoins ?? 0).toLocaleString()} ${currency}`
    ).join('\n') || '*No participants*';

    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle(`🏁 Season Ended: ${seasonLabel(ended.season)}`)
        .setDescription('The season leaderboard has been frozen and season coins have been reset.')
        .addFields({ name: '🏆 Final Top 3', value: winnerLines })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

// ── Seasonal event progress subcommand ───────────────────────────────────────

async function executeSeasonEvent(interaction) {
    const [user, guildSettings] = await loadPlayerAndSettings(interaction);

    const activeEvent = guildSettings?.activeEvent;
    if (!activeEvent?.type) {
        return interaction.reply({ content: 'No seasonal event is running on this server right now.', flags: MessageFlags.Ephemeral });
    }

    const eventDef = SEASONAL_EVENTS[activeEvent.type];
    if (!eventDef) {
        return interaction.reply({ content: 'No seasonal event data found.', flags: MessageFlags.Ephemeral });
    }

    const currency = eventDef.currency;
    const balance = getEventCurrencyBalance(user, currency.id);
    const milestones = eventDef.milestones ?? [];

    // Days remaining and date range
    const now = new Date();
    const endsAt = activeEvent.endsAt ? new Date(activeEvent.endsAt) : null;
    const startedAt = activeEvent.startedAt ? new Date(activeEvent.startedAt) : null;
    const daysRemaining = endsAt ? Math.max(0, Math.ceil((endsAt - now) / 86400000)) : null;

    const dateRange = startedAt && endsAt
        ? `<t:${Math.floor(startedAt.getTime() / 1000)}:D> – <t:${Math.floor(endsAt.getTime() / 1000)}:D>`
        : null;

    const descLines = [];
    if (dateRange) descLines.push(dateRange);
    if (daysRemaining !== null) descLines.push(`${daysRemaining} day${daysRemaining !== 1 ? 's' : ''} remaining`);
    if (daysRemaining !== null && daysRemaining <= 3 && daysRemaining > 0) descLines.push('⚠️ Event ending soon!');

    // Next milestone and progress bar
    const nextMilestone = milestones.find(m => m.threshold > balance);
    let progressValue;
    if (!milestones.length) {
        progressValue = '*No milestones defined for this event.*';
    } else if (!nextMilestone) {
        progressValue = `✅ All milestones completed! **${balance.toLocaleString()} ${currency.emoji}** earned total.`;
    } else {
        const prevThreshold = milestones.filter(m => m.threshold <= balance).at(-1)?.threshold ?? 0;
        const bar = progressBar(balance - prevThreshold, nextMilestone.threshold - prevThreshold);
        progressValue = [
            `${bar}  ${balance.toLocaleString()} / ${nextMilestone.threshold.toLocaleString()}`,
            `Next reward: ${nextMilestone.emoji} **${nextMilestone.label}** at ${nextMilestone.threshold.toLocaleString()} ${currency.emoji}`,
        ].join('\n');
    }

    // Milestone list with ✅ / ▶ / ○ indicators. Nothing caps how many
    // milestones an event carries or how long an admin makes a label, so this
    // is packed into as many fields as it needs rather than joined into one
    // that Discord rejects at 1,024 characters.
    const milestoneLines = milestones.map(m => {
        if (balance >= m.threshold) return `✅ ${m.threshold.toLocaleString()} ${currency.emoji} → ${m.label}`;
        if (m === nextMilestone)    return `▶ ${m.threshold.toLocaleString()} ${currency.emoji} → **${m.label}**  ← next`;
        return `○ ${m.threshold.toLocaleString()} ${currency.emoji} → ${m.label}`;
    });
    const { fields: milestoneFields, omitted: milestonesOmitted } =
        packFieldsCapped('🏆 Milestone Rewards', milestoneLines, { maxFields: MILESTONE_FIELDS });

    // Active multiplier info
    const bonusLines = [];
    if ((activeEvent.xpMultiplier ?? 1) > 1) bonusLines.push(`${activeEvent.xpMultiplier}x XP active during this event`);
    if ((activeEvent.coinMultiplier ?? 1) > 1) bonusLines.push(`${activeEvent.coinMultiplier}x Coins active during this event`);

    const embed = new EmbedBuilder()
        .setColor(activeEvent.color ?? '#5865F2')
        .setTitle(`${activeEvent.emoji ?? '🎉'} ${activeEvent.name}`)
        .setDescription(descLines.join('\n') || null)
        .addFields(
            { name: `${currency.emoji} Your ${currency.name}`, value: `**${balance.toLocaleString()}**`, inline: true },
            { name: 'Season Progress', value: progressValue },
        );

    if (milestoneFields.length) {
        embed.addFields(...milestoneFields);
        if (milestonesOmitted > 0) {
            embed.addFields({
                name: '🏆 Milestone Rewards — and more',
                value: `*${milestonesOmitted} further milestone${milestonesOmitted === 1 ? '' : 's'} not shown.*`,
            });
        }
    } else {
        embed.addFields({ name: '🏆 Milestone Rewards', value: '*No milestones defined*' });
    }

    if (bonusLines.length > 0) {
        embed.addFields({ name: '✨ Active Bonuses', value: bonusLines.join('\n') });
    }

    embed.setFooter({ text: '🛍️ Season shop: /eventshop' }).setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ── Tier Skip Token ───────────────────────────────────────────────────────────

const TIER_SKIP_ITEM_ID = 'tier_skip_token';

async function executeTierSkip(interaction) {
    const [user, guildSettings] = await Promise.all([
        User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
        getGuildSettings(interaction.guild.id)
    ]);

    const season = guildSettings?.season;
    if (!season?.enabled || !season?.seasonId) {
        return interaction.reply({ content: 'No active season pass is running on this server right now.', flags: MessageFlags.Ephemeral });
    }

    if (!user) {
        return interaction.reply({ content: "You don't have a profile yet.", flags: MessageFlags.Ephemeral });
    }

    normalizeSeason(user, season.seasonId);

    const currentTier = getTierFromXp(user.season?.xp ?? 0);
    if (currentTier >= MAX_TIERS) {
        return interaction.reply({ content: '✅ You\'re already at the maximum tier!', flags: MessageFlags.Ephemeral });
    }

    const invEntry = user.inventory?.find(e => e.itemId.toLowerCase() === TIER_SKIP_ITEM_ID && e.quantity > 0);
    if (!invEntry) {
        return interaction.reply({ content: `You don't have a **Tier Skip Token** in your inventory. Purchase one from the event shop.`, flags: MessageFlags.Ephemeral });
    }

    // Atomically consume the token and grant a tier of XP — to *this* season: a
    // stale pass is reset first, or the XP landed on it and died there (#873, pass 19).
    await resetStaleSeason(User, { userId: interaction.user.id, guildId: interaction.guild.id }, season.seasonId);
    const updatedUser = await User.findOneAndUpdate(
        {
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            'season.seasonId': season.seasonId,
            inventory: { $elemMatch: { itemId: invEntry.itemId, quantity: { $gt: 0 } } }
        },
        {
            $inc: {
                'inventory.$.quantity': -1,
                'season.xp': XP_PER_TIER,
            }
        },
        { new: true }
    );

    if (!updatedUser) {
        return interaction.reply({ content: 'Failed to consume the Tier Skip Token — it may have already been used.', flags: MessageFlags.Ephemeral });
    }

    // Prune the emptied slot with a targeted `$pull`, not a full-document
    // `save()` (#873, pass 7): the save rewrites `inventory` as an absolute
    // `$set` and would flatten a grant that landed after the atomic consume.
    await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $pull: { inventory: { quantity: { $lte: 0 } } } }).catch(() => {});
    updatedUser.inventory = updatedUser.inventory.filter(e => e.quantity > 0);

    const newTier = getTierFromXp(updatedUser.season?.xp ?? 0);
    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle('⏭️ Tier Skipped!')
        .setDescription(
            `Your Tier Skip Token was consumed.\n\n` +
            `**Tier:** ${currentTier} → **${newTier}**\n` +
            `**Tokens remaining:** ${updatedUser.inventory.find(e => e.itemId === invEntry.itemId)?.quantity ?? 0}x`
        )
        .setFooter({ text: 'Use /season claim to collect your new tier rewards.' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ── Module export ─────────────────────────────────────────────────────────────

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('season')
        .setDescription('Season pass and economy season commands.')
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('View your season pass progress and tier rewards.')
        )
        .addSubcommand(sub =>
            sub.setName('claim')
                .setDescription('Claim a tier reward from the season pass.')
                .addIntegerOption(opt =>
                    opt.setName('tier')
                        .setDescription('Tier number to claim (1–50)')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(50)
                )
                .addBooleanOption(opt =>
                    opt.setName('premium')
                        .setDescription('Claim the premium-track reward for this tier (requires /season unlock)')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('unlock')
                .setDescription('Unlock the premium season-pass track for a one-time coin payment.')
        )
        .addSubcommand(sub =>
            sub.setName('claim-all')
                .setDescription('Claim all available season pass tier rewards at once.')
                .addBooleanOption(opt =>
                    opt.setName('premium')
                        .setDescription('Claim premium-track rewards (requires /season unlock)')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('missions')
                .setDescription("View today's daily missions.")
        )
        .addSubcommand(sub =>
            sub.setName('claim-mission')
                .setDescription('Claim a completed daily mission reward.')
                .addIntegerOption(opt =>
                    opt.setName('mission')
                        .setDescription('Mission number (1, 2, or 3)')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(3)
                )
        )
        .addSubcommand(sub =>
            sub.setName('leaderboard')
                .setDescription('View the current economy season leaderboard (top 10).')
        )
        .addSubcommand(sub =>
            sub.setName('me')
                .setDescription('View your economy season rank and coins earned.')
        )
        .addSubcommand(sub =>
            sub.setName('history')
                .setDescription('View past economy season winners.')
        )
        .addSubcommand(sub =>
            sub.setName('start')
                .setDescription('[Admin] Start a new 90-day economy season.')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Season name (e.g. "Season 1")')
                        .setRequired(false)
                        .setMaxLength(SEASON_NAME_MAX)
                )
                .addIntegerOption(opt =>
                    opt.setName('duration')
                        .setDescription('Duration in days (default 90)')
                        .setRequired(false)
                        .setMinValue(7)
                        .setMaxValue(365)
                )
        )
        .addSubcommand(sub =>
            sub.setName('end')
                .setDescription('[Admin] End the current economy season and freeze the leaderboard.')
        )
        .addSubcommand(sub =>
            sub.setName('event')
                .setDescription('View your progress in the active seasonal event with milestone rewards.')
        )
        .addSubcommand(sub =>
            sub.setName('tier-skip')
                .setDescription('Use a Tier Skip Token from your inventory to advance one season pass tier.')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            if (sub === 'view')          return await executeView(interaction);
            if (sub === 'claim')         return await executeClaim(interaction);
            if (sub === 'claim-all')     return await executeClaimAll(interaction);
            if (sub === 'unlock')        return await executeUnlock(interaction);
            if (sub === 'missions')      return await executeMissions(interaction);
            if (sub === 'claim-mission') return await executeClaimMission(interaction);
            if (sub === 'leaderboard')   return await executeLeaderboard(interaction);
            if (sub === 'me')            return await executeSeasonMe(interaction);
            if (sub === 'history')       return await executeHistory(interaction);
            if (sub === 'start')         return await executeAdminStart(interaction);
            if (sub === 'end')           return await executeAdminEnd(interaction);
            if (sub === 'event')         return await executeSeasonEvent(interaction);
            if (sub === 'tier-skip')     return await executeTierSkip(interaction);
        } catch (err) {
            console.error('[season] error:', err);
            const msg = { content: 'Something went wrong with the season command.', flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) return interaction.followUp(msg);
            return interaction.reply(msg);
        }
    }
};
