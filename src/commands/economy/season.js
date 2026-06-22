const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const SeasonRecord = require('../../models/SeasonRecord');
const { generateDailyMissions } = require('../../data/seasonMissions');
const { SEASONAL_EVENTS } = require('../../data/seasonalEvents');
const { getEventCurrencyBalance } = require('../../services/seasonalEventService');
const { progressBar } = require('../../utils/progressBar');
const { rewardReveal } = require('../../utils/rewardReveal');
const { logTransaction } = require('../../utils/logTransaction');
const { awardSeasonXp } = require('../../services/questService');

// Reset a user's season sub-document to the fresh shape when their stored
// seasonId is stale (a new season started). Prevents carrying old xp / claimed
// tiers / premium across seasons. Returns true if a reset happened.
function normalizeSeason(user, seasonId) {
    if (!seasonId) return false;
    if (user.season?.seasonId === seasonId) return false;
    user.season = { seasonId, xp: 0, tier: 0, claimedTiers: [], premium: false, claimedPremiumTiers: [], weekXp: 0, weekStart: null };
    user.markModified('season');
    return true;
}

// ── Battle pass tier definitions ─────────────────────────────────────────────
// 50 tiers across a free track and a premium track (see src/data/seasonPass.js).
// Premium is unlocked with a large coin payment (/season unlock) — the economy's
// primary deliberate money sink.
const { TIER_COUNT, XP_PER_TIER, TIER_TABLE, loreForTier } = require('../../data/seasonPass');

const MAX_TIERS = TIER_COUNT;
const DEFAULT_PREMIUM_COST = 100_000;

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

async function ensureMissions(user) {
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    if (!user.seasonMissionsDate || new Date(user.seasonMissionsDate).getTime() < todayUtc.getTime()) {
        user.seasonMissions = generateDailyMissions();
        user.seasonMissionsDate = todayUtc;
        user.markModified('seasonMissions');
        user.markModified('seasonMissionsDate');
    }
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function executeView(interaction) {
    const [user, guildSettings] = await Promise.all([
        User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        ),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);

    const season = guildSettings?.season;
    if (!season?.enabled || !season?.seasonId) {
        return interaction.reply({ content: 'No active season pass is running on this server right now.', flags: MessageFlags.Ephemeral });
    }

    await ensureMissions(user);
    normalizeSeason(user, season.seasonId); // drop stale cross-season progress

    const userXp = user.season?.xp ?? 0;
    const currentTier = getTierFromXp(userXp);
    const premium = user.season?.premium === true;
    const claimedFree    = new Set(user.season?.claimedTiers ?? []);
    const claimedPremium = new Set(user.season?.claimedPremiumTiers ?? []);
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
    const weekXp    = user.season?.weekXp ?? 0;
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

    await user.save().catch(() => {});
    return interaction.reply({ embeds: [embed] });
}

async function executeClaim(interaction) {
    const tier = interaction.options.getInteger('tier');
    const [user, guildSettings] = await Promise.all([
        User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        ),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);

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

    if (reward.coins > 0) user.balance += reward.coins;
    if (reward.itemId) user.inventory.push({ itemId: reward.itemId, quantity: 1 });
    (wantsPremium ? user.season.claimedPremiumTiers : user.season.claimedTiers).push(tier);
    user.markModified('season');
    if (reward.itemId) user.markModified('inventory');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.reply({ content: 'Edit conflict — try again.', flags: MessageFlags.Ephemeral });
        throw err;
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
            (reward.coins > 0 ? `\n+**${reward.coins.toLocaleString()} ${currency}** added to your wallet` : '')
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
    const [user, guildSettings] = await Promise.all([
        User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        ),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);

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
        .setColor('#ffd700')
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
    const [user, guildSettings] = await Promise.all([
        User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        ),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);

    const season = guildSettings?.season;
    if (!season?.enabled) {
        return interaction.reply({ content: 'No active season on this server.', flags: MessageFlags.Ephemeral });
    }

    await ensureMissions(user);
    const currency = guildSettings?.economy?.currency ?? '💰';

    const missionLines = (user.seasonMissions ?? []).map((m, i) => {
        const status = m.claimed ? '✅ Claimed' : m.completed ? '🎯 Complete — use /season claim-mission' : `🔲 ${m.progress}/${m.target}`;
        return `**Mission ${i + 1}:** ${m.description}\n${status} → +${m.seasonXp} Season XP, ${m.coinReward.toLocaleString()} ${currency}`;
    });

    const resetAt = new Date();
    resetAt.setUTCHours(24, 0, 0, 0);

    const embed = new EmbedBuilder()
        .setColor('#5865f2')
        .setTitle('📋 Daily Missions')
        .setDescription(missionLines.join('\n\n') || '*No missions generated*')
        .setFooter({ text: `Resets at midnight UTC` })
        .addFields({ name: '⏰ Next Reset', value: `<t:${Math.floor(resetAt.getTime() / 1000)}:R>`, inline: true })
        .setTimestamp();

    await user.save().catch(() => {});
    return interaction.reply({ embeds: [embed] });
}

async function executeClaimMission(interaction) {
    const missionIndex = interaction.options.getInteger('mission') - 1;
    const [user, guildSettings] = await Promise.all([
        User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        ),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);

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

    user.seasonMissions[missionIndex].claimed = true;
    normalizeSeason(user, season.seasonId);
    // Route through the shared grant so the weekly XP cap and rollover apply.
    // awardSeasonXp returns the actual granted amount (may be < mission.seasonXp if capped).
    const grantedXp = await awardSeasonXp(user, mission.seasonXp, guildSettings);
    user.balance += mission.coinReward;
    user.markModified('seasonMissions');
    user.markModified('season');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.reply({ content: 'Edit conflict — try again.', flags: MessageFlags.Ephemeral });
        throw err;
    }

    return interaction.reply({
        content: `✅ Mission claimed! +**${grantedXp} Season XP** and +**${mission.coinReward.toLocaleString()} ${currency}**`,
        flags: MessageFlags.Ephemeral
    });
}

// ── Economy season (issue #238) subcommands ───────────────────────────────────

async function executeLeaderboard(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
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
        .setColor('#ffd700')
        .setTitle(`📊 Season Leaderboard — ${currentSeason.name ?? currentSeason.id}`)
        .setDescription(lines.join('\n'))
        .addFields({ name: '⏰ Season Ends', value: endsAt, inline: true })
        .setFooter({ text: 'Only season coins earned this season count — wallet is never reset!' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeSeasonMe(interaction) {
    const [user, guildSettings] = await Promise.all([
        User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
        Guild.findOne({ guildId: interaction.guild.id })
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
        .setColor('#5865f2')
        .setTitle(`📊 Your Season Stats — ${currentSeason.name ?? currentSeason.id}`)
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
        name: `${r.seasonName ?? r.seasonId} (ended <t:${Math.floor(new Date(r.endedAt).getTime() / 1000)}:D>)`,
        value: r.top10.slice(0, 3).map((u, i) => {
            const medals = ['🥇', '🥈', '🥉'];
            return `${medals[i]} <@${u.userId}> — ${u.coins.toLocaleString()} coins`;
        }).join('\n') || 'No data',
        inline: false
    }));

    const embed = new EmbedBuilder()
        .setColor('#9e9e9e')
        .setTitle('📜 Season History')
        .addFields(fields)
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// Admin: start economy season
async function executeAdminStart(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Administrator only.', flags: MessageFlags.Ephemeral });
    }

    const name = interaction.options.getString('name') ?? `Season ${Date.now()}`;
    const durationDays = interaction.options.getInteger('duration') ?? 90;
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

    if (guildSettings?.currentSeason?.id) {
        return interaction.reply({ content: 'A season is already active. End it first with `/season end`.', flags: MessageFlags.Ephemeral });
    }

    const seasonId = `season_${Date.now()}`;
    const now = new Date();
    const endsAt = new Date(now.getTime() + durationDays * 86400000);

    await Guild.findOneAndUpdate(
        { guildId: interaction.guild.id },
        { $set: { currentSeason: { id: seasonId, name, startedAt: now, endsAt } } }
    );

    return interaction.reply({
        content: `✅ Economy season **${name}** started! Ends <t:${Math.floor(endsAt.getTime() / 1000)}:R>.`,
    });
}

// Admin: end economy season
async function executeAdminEnd(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Administrator only.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    const currentSeason = guildSettings?.currentSeason;

    if (!currentSeason?.id) {
        return interaction.editReply('No active economy season to end.');
    }

    const topUsers = await User.find({ guildId: interaction.guild.id })
        .sort({ seasonCoins: -1 })
        .limit(10)
        .select('userId seasonCoins');

    let resolvedNames = {};
    try {
        for (const u of topUsers.slice(0, 3)) {
            const member = await interaction.guild.members.fetch(u.userId).catch(() => null);
            resolvedNames[u.userId] = member?.user?.username ?? 'Unknown';
        }
    } catch {}

    await SeasonRecord.create({
        guildId: interaction.guild.id,
        seasonId: currentSeason.id,
        seasonName: currentSeason.name,
        startedAt: currentSeason.startedAt,
        endedAt: new Date(),
        top10: topUsers.map(u => ({
            userId: u.userId,
            username: resolvedNames[u.userId] ?? 'Unknown',
            coins: u.seasonCoins ?? 0
        }))
    });

    // Reset all seasonCoins for this guild
    await User.updateMany({ guildId: interaction.guild.id }, { $set: { seasonCoins: 0 } });

    // Clear currentSeason from guild
    await Guild.findOneAndUpdate(
        { guildId: interaction.guild.id },
        { $set: { currentSeason: { id: null, name: null, startedAt: null, endsAt: null } } }
    );

    const medals = ['🥇', '🥈', '🥉'];
    const winners = topUsers.slice(0, 3);
    const winnerLines = winners.map((u, i) =>
        `${medals[i]} <@${u.userId}> — ${(u.seasonCoins ?? 0).toLocaleString()} coins`
    ).join('\n') || '*No participants*';

    const embed = new EmbedBuilder()
        .setColor('#ffd700')
        .setTitle(`🏁 Season Ended: ${currentSeason.name ?? currentSeason.id}`)
        .setDescription('The season leaderboard has been frozen and season coins have been reset.')
        .addFields({ name: '🏆 Final Top 3', value: winnerLines })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

// ── Seasonal event progress subcommand ───────────────────────────────────────

async function executeSeasonEvent(interaction) {
    const [user, guildSettings] = await Promise.all([
        User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        ),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);

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

    // Milestone list with ✅ / ▶ / ○ indicators
    const milestoneList = milestones.map(m => {
        if (balance >= m.threshold) return `✅ ${m.threshold.toLocaleString()} ${currency.emoji} → ${m.label}`;
        if (m === nextMilestone)    return `▶ ${m.threshold.toLocaleString()} ${currency.emoji} → **${m.label}**  ← next`;
        return `○ ${m.threshold.toLocaleString()} ${currency.emoji} → ${m.label}`;
    }).join('\n') || '*No milestones defined*';

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
            { name: '🏆 Milestone Rewards', value: milestoneList },
        );

    if (bonusLines.length > 0) {
        embed.addFields({ name: '✨ Active Bonuses', value: bonusLines.join('\n') });
    }

    embed.setFooter({ text: '🛍️ Season shop: /eventshop' }).setTimestamp();

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
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            if (sub === 'view')          return await executeView(interaction);
            if (sub === 'claim')         return await executeClaim(interaction);
            if (sub === 'unlock')        return await executeUnlock(interaction);
            if (sub === 'missions')      return await executeMissions(interaction);
            if (sub === 'claim-mission') return await executeClaimMission(interaction);
            if (sub === 'leaderboard')   return await executeLeaderboard(interaction);
            if (sub === 'me')            return await executeSeasonMe(interaction);
            if (sub === 'history')       return await executeHistory(interaction);
            if (sub === 'start')         return await executeAdminStart(interaction);
            if (sub === 'end')           return await executeAdminEnd(interaction);
            if (sub === 'event')         return await executeSeasonEvent(interaction);
        } catch (err) {
            console.error('[season] error:', err);
            const msg = { content: 'Something went wrong with the season command.', flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) return interaction.followUp(msg);
            return interaction.reply(msg);
        }
    }
};
