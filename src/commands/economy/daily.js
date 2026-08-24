const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');
const { getCoinMultiplier, getServerCoinMultiplier } = require('../../services/effectsService');
const { logTransaction } = require('../../utils/logTransaction');
const { inventoryAddExpr } = require('../../utils/inventoryGrant');
const { MAX_COMBINED_MULTIPLIER, clampMultiplier } = require('../../config/economy');
const { generateDailyChallenge } = require('../../utils/dailyChallenge');
const { DROP_TABLE, RARE_DROP_TABLE, DROP_MILESTONES, DROP_BASE_CHANCE, weightedRandom } = require('../../data/dailyDropTable');
const { stackBar } = require('../../utils/rewardReveal');
const { buildCooldownEmbed, getNextStreakMilestone } = require('../../utils/cooldownEmbed');
const { getTimeBand } = require('../../utils/timeBand');
const { claimStarterKit } = require('../../utils/starterKit');
const { ensureQuests, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../services/questService');
const { saveWithBalanceDelta } = require('../../utils/balanceDelta');
const { recordMissionProgress } = require('../../services/seasonMissionService');
const COLORS = require('../../utils/embedColors');

function getStreakColor(streak) {
    if (streak >= 100) return '#9b59b6';
    if (streak >= 30)  return '#FFD700';
    if (streak >= 7)   return '#ff6b00';
    return '#f39c12';
}

function getStreakTitle(streak, isMilestone) {
    if (isMilestone) return `🔥 ${streak}-Day Milestone!`;
    if (streak >= 7)  return `🔥 Day ${streak} — Daily Streak`;
    return '☀️ Daily Reward';
}

function getStreakDescription(streak, isMilestone) {
    if (isMilestone) {
        if (streak === 100) return "One hundred days. You've made this a habit.\nThat's not luck — that's dedication.";
        if (streak === 30)  return "You've shown up 30 days in a row.\nThat kind of commitment pays off.";
        if (streak === 7)   return "A full week without missing a day.\nYou're just getting started.";
    }
    if (streak >= 100) return "Still going. Every day counts.";
    if (streak >= 30)  return "You've been showing up consistently.\nKeep the momentum going.";
    if (streak >= 7)   return "The streak is real. Don't break it.";
    return "Good to see you today.";
}

function buildRewardBlock(amount, streak, streakMult, coinMult, serverMult, combined, balance, capActive, droppedItem, isMilestone, streakCurrent, currency) {
    const div = '━━━━━━━━━━━━━━━━━━━━━━━━━━';
    const lines = [div];
    lines.push(`💰 Today's Reward: **${amount.toLocaleString()} coins**`);

    // Canonical stack-bar line when any multiplier is active
    const mults = [];
    if (streakMult > 1.0) mults.push({ emoji: '🔥', label: `${streak}d` });
    if (coinMult > 1.0)   mults.push({ emoji: '💰🚀', label: `${coinMult}x` });
    if (serverMult > 1.0) mults.push({ emoji: '🌐', label: `${serverMult}x` });
    const bar = stackBar(mults, combined, amount, currency);
    if (bar) lines.push(bar);
    if (capActive) lines.push(`⚠️ Combined multiplier capped at **${MAX_COMBINED_MULTIPLIER}x**.`);

    lines.push(div);
    lines.push(`Balance: **${balance.toLocaleString()} coins**`);
    if (droppedItem) {
        const dropLabel = isMilestone ? `🎁 Milestone Drop! (${streakCurrent}-day streak)` : '🎁 Surprise Drop!';
        lines.push('');
        lines.push(`${dropLabel}`);
        lines.push(`You found a ${droppedItem.emoji} **${droppedItem.name}** in today's reward!`);
    }
    return lines.join('\n');
}

const CALENDAR_BUTTON_ID = 'daily_calendar';

function buildCalendarEmbed(user, dailyAmount, currentStreak) {
    const div = '━━━━━━━━━━━━━━━━━━━━━━━━━━';
    const lines = [];

    // Past 6 days: infer claimed if streak covers them
    for (let i = 6; i >= 1; i--) {
        const dayNum = currentStreak - i;
        if (dayNum < 1) {
            lines.push(`\`D-${i}\` ❌ Missed`);
        } else {
            const suffix = i === 1 ? ' ← Yesterday' : '';
            lines.push(`\`D-${i}\` ✅ Day ${dayNum}${suffix}`);
        }
    }

    // Today
    const claimed = user.lastDaily && Date.now() - user.lastDaily.getTime() < 86400000;
    const todayIcon   = claimed ? '✅' : '🟢';
    const todayStatus = claimed ? 'Claimed!' : 'Ready now!';
    lines.push(`\`TODAY\` **▶ Day ${currentStreak} — ${todayIcon} ${todayStatus}**`);

    lines.push('');
    lines.push('*Upcoming days:*');

    // Next 6 days
    for (let i = 1; i <= 6; i++) {
        const futureStreak = currentStreak + i;
        const mult      = getStreakMultiplier(futureStreak);
        const estCoins  = Math.round(dailyAmount * Math.min(mult, MAX_COMBINED_MULTIPLIER));
        const milestone = DROP_MILESTONES.includes(futureStreak);
        if (milestone) {
            lines.push(`\`D+${i}\` ⭐ **Day ${futureStreak} — MILESTONE!** ~${estCoins.toLocaleString()} coins + guaranteed drop!`);
        } else {
            lines.push(`\`D+${i}\` 🔮 Day ${futureStreak} — ~${estCoins.toLocaleString()} coins · 5% item drop`);
        }
    }

    const timeBand = getTimeBand();
    const embed = new EmbedBuilder()
        .setColor(getStreakColor(currentStreak))
        .setTitle('📅 Daily Calendar')
        .setDescription(`**${currentStreak}-Day Streak**\n${div}\n${lines.join('\n')}\n${div}`)
        .setFooter({ text: `${timeBand.emoji} ${timeBand.label} · Claim daily to keep your streak alive!` })
        .setTimestamp();

    const freezes = user.streak?.freezes ?? 0;
    if (freezes > 0) {
        embed.addFields({
            name: '❄️ Streak Freezes',
            value: `${freezes} banked — automatically used if you miss a day`,
            inline: false
        });
    }

    return embed;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('daily')
        .setDescription('Claim your daily coin reward (amount set by server admins, default 100). Resets every 24 hours.'),
    cooldown: 5,
    async execute(interaction) {
        const MIN_ACCOUNT_AGE_MS = 7 * 24 * 3_600_000;
        if (Date.now() - interaction.user.createdTimestamp < MIN_ACCOUNT_AGE_MS) {
            return interaction.reply({
                content: '❌ Your Discord account must be at least 7 days old to claim daily rewards.',
                flags: MessageFlags.Ephemeral,
            });
        }
        try {
            const [user, guildSettings] = await Promise.all([
                User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
                    { upsert: true, new: true }
                ),
                Guild.findOne({ guildId: interaction.guild.id })
            ]);

            const now = Date.now();
            const dailyCooldown = 86400000;

            if (user.lastDaily && now - user.lastDaily.getTime() < dailyCooldown) {
                const streak = user.streak?.current ?? 0;
                const nextAt = new Date(user.lastDaily.getTime() + dailyCooldown);
                const dailyAmount = guildSettings?.economy?.dailyAmount ?? 100;
                const streakMult  = getStreakMultiplier(streak);
                const coinMult    = getCoinMultiplier(user);
                const serverMult  = getServerCoinMultiplier(guildSettings);
                const estNext     = Math.round(dailyAmount * clampMultiplier(streakMult * coinMult * serverMult));

                const topDrop = DROP_TABLE.reduce((best, d) => d.weight > best.weight ? d : best, DROP_TABLE[0]);
                const nextRewardPreview = `Coming tomorrow: **~${estNext.toLocaleString()} coins** · possible ${topDrop.emoji} ${topDrop.name} drop`;

                return interaction.reply({
                    embeds: [buildCooldownEmbed({
                        title: '☀️ Come Back Tomorrow',
                        description: "You've already claimed today's reward.\nCheck in again when the clock resets.",
                        color: getStreakColor(streak),
                        nextAt,
                        milestoneTeaser: getNextStreakMilestone(streak),
                        nextRewardPreview,
                    })],
                    flags: MessageFlags.Ephemeral,
                });
            }

            // ── Streak Revival Token (auto-apply, highest priority) ───────────────
            const pendingRestore = user.streak?.pendingRestore ?? 0;
            let usedFollowUp = false;

            if (pendingRestore > 0 && user.streak?.revivalToken) {
                await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    {
                        $set: {
                            'streak.current': pendingRestore,
                            'streak.pendingRestore': 0,
                            'streak.revivalToken': false,
                        }
                    }
                );
                user.streak.current       = pendingRestore;
                user.streak.pendingRestore = 0;
                user.streak.revivalToken  = false;

                const revivalEmbed = new EmbedBuilder()
                    .setColor(COLORS.RARE)
                    .setTitle('💫 Streak Revival Token Activated!')
                    .setDescription(
                        `Your **Streak Revival Token** automatically restored your streak!\n\n` +
                        `Your **${pendingRestore}-day streak** continues — the token has been consumed.`
                    )
                    .setTimestamp();

                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ embeds: [revivalEmbed] });
                    usedFollowUp = true;
                }
            }
            // ─────────────────────────────────────────────────────────────────────

            // ── Streak Freeze Restore Prompt ─────────────────────────────────────
            const freezesAvailable = user.streak?.freezes ?? 0;

            const currentPendingRestore = user.streak?.pendingRestore ?? 0;
            if (currentPendingRestore > 0 && freezesAvailable > 0) {
                const restoreRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('freeze_restore')
                        .setLabel('✅ Restore Streak')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('freeze_skip')
                        .setLabel('❌ Start Fresh')
                        .setStyle(ButtonStyle.Secondary),
                );

                const freezeEmbed = new EmbedBuilder()
                    .setColor(COLORS.ERROR)
                    .setTitle('💔 Your streak was broken!')
                    .setDescription(
                        `Your **${currentPendingRestore}-day streak** was broken!\n\n` +
                        `You have **${freezesAvailable}** Streak Freeze${freezesAvailable !== 1 ? 's' : ''} available.\n` +
                        `Would you like to use one to restore your streak?`
                    )
                    .addFields({ name: '❄️ Streak Freezes', value: `${freezesAvailable} banked`, inline: true })
                    .setTimestamp();

                const promptReply = await interaction.reply({ embeds: [freezeEmbed], components: [restoreRow], fetchReply: true });
                usedFollowUp = true;

                try {
                    const resp = await promptReply.awaitMessageComponent({
                        time: 30000,
                        filter: i => i.user.id === interaction.user.id,
                    });

                    if (resp.customId === 'freeze_restore') {
                        await User.findOneAndUpdate(
                            { userId: interaction.user.id, guildId: interaction.guild.id },
                            {
                                $set: { 'streak.current': currentPendingRestore, 'streak.pendingRestore': 0 },
                                $inc: { 'streak.freezes': -1 }
                            }
                        );
                        user.streak.current = currentPendingRestore;
                        user.streak.freezes = freezesAvailable - 1;
                        user.streak.pendingRestore = 0;

                        await resp.update({
                            embeds: [
                                EmbedBuilder.from(freezeEmbed)
                                    .setColor(COLORS.SUCCESS)
                                    .setDescription(
                                        `✅ Streak restored! Your **${currentPendingRestore}-day streak** continues!\n\n` +
                                        `1 Streak Freeze consumed. **${user.streak.freezes}** remaining.`
                                    )
                                    .setFields({ name: '❄️ Streak Freezes', value: `${user.streak.freezes} remaining`, inline: true })
                            ],
                            components: [],
                        });
                    } else {
                        await User.findOneAndUpdate(
                            { userId: interaction.user.id, guildId: interaction.guild.id },
                            { $set: { 'streak.pendingRestore': 0 } }
                        );
                        user.streak.pendingRestore = 0;

                        await resp.update({
                            embeds: [
                                EmbedBuilder.from(freezeEmbed)
                                    .setColor(COLORS.NEUTRAL)
                                    .setDescription('Starting fresh! Build that streak back up 💪')
                                    .setFields()
                            ],
                            components: [],
                        });
                    }
                } catch {
                    // Timeout — clear pending, continue with daily
                    await User.findOneAndUpdate(
                        { userId: interaction.user.id, guildId: interaction.guild.id },
                        { $set: { 'streak.pendingRestore': 0 } }
                    );
                    user.streak.pendingRestore = 0;
                    await interaction.editReply({ components: [] }).catch(() => {});
                }
            }
            // ─────────────────────────────────────────────────────────────────────

            // Grant starter kit on first economy command use
            let starterKitResult = null;
            if (!user.onboarding?.starterKitClaimed) {
                starterKitResult = await claimStarterKit(interaction.user.id, interaction.guild.id);
            }

            const dailyAmount  = guildSettings?.economy?.dailyAmount ?? 2500;
            const streakMult   = getStreakMultiplier(user.streak?.current ?? 0);
            const coinMult     = getCoinMultiplier(user);
            const serverMult   = getServerCoinMultiplier(guildSettings);
            const rawCombined  = streakMult * coinMult * serverMult;
            const combined     = clampMultiplier(rawCombined);
            const actualAmount = Math.round(dailyAmount * combined);
            const capActive    = rawCombined > MAX_COMBINED_MULTIPLIER;

            // Atomic update — cooldown condition in query prevents double-credit on concurrent requests
            const updated = await User.findOneAndUpdate(
                {
                    userId: interaction.user.id,
                    guildId: interaction.guild.id,
                    $or: [
                        { lastDaily: null },
                        { lastDaily: { $lt: new Date(now - dailyCooldown) } }
                    ]
                },
                {
                    $inc: { balance: actualAmount },
                    $set: { lastDaily: new Date(now) }
                },
                { new: true }
            );

            if (!updated) {
                const streak  = user.streak?.current ?? 0;
                const errorMsg = {
                    embeds: [buildCooldownEmbed({
                        title: '☀️ Already Claimed',
                        description: "You've already claimed today's reward.\nCheck in again when the clock resets.",
                        color: getStreakColor(streak),
                        milestoneTeaser: getNextStreakMilestone(streak),
                    })],
                    flags: MessageFlags.Ephemeral,
                };
                return usedFollowUp ? interaction.followUp(errorMsg) : interaction.reply(errorMsg);
            }

            logTransaction({
                userId: interaction.user.id,
                guildId: interaction.guild.id,
                type: 'daily',
                amount: actualAmount,
                balance: updated.balance,
                note: `streak ${user.streak?.current ?? 0}, mult ${combined.toFixed(2)}${capActive ? ' (capped)' : ''}`
            });

            // Quest progress for coins earned from today's claim. Any quest coins
            // go out as their own `$inc`: `save()` would write `balance` as an
            // absolute `$set` and erase whatever else the player spent or won
            // between the claim above and this write.
            try {
                const balanceAfterClaim = updated.balance ?? 0;
                await ensureQuests(updated, guildSettings);
                let questsDone = [], questsNear = [];
                if (actualAmount > 0) {
                    const earn = await onEconomyEarn(updated, guildSettings, actualAmount);
                    questsDone = earn.completed;
                    questsNear = earn.nearComplete;
                }
                // Season pass daily missions advance on the claim itself, not on
                // the coins — a capped or zero payout is still a claim. Recorded
                // in memory; the save below carries it.
                recordMissionProgress(updated, 'daily', 1, guildSettings);
                await saveWithBalanceDelta(User, updated, balanceAfterClaim, {
                    service: 'daily',
                    jobName: 'dailyQuestReward',
                    guildId: interaction.guild.id,
                });
                if (questsDone.length || questsNear.length) {
                    notifyQuestComplete(guildSettings, interaction.member, questsDone, interaction.channel, updated).catch(() => null);
                    notifyQuestNearComplete(guildSettings, interaction.member, questsNear, interaction.channel).catch(() => null);
                }
            } catch (err) {
                console.error('[daily] quest save error:', err);
            }

            // ── Item Drop Check ───────────────────────────────────────────────────
            const streakCurrent = user.streak?.current ?? 0;
            const claimedDropMilestones = new Set(user.streak?.claimedDropMilestones ?? []);
            const isMilestone = DROP_MILESTONES.includes(streakCurrent) && !claimedDropMilestones.has(streakCurrent);
            const rollDrop = isMilestone || Math.random() < DROP_BASE_CHANCE;

            let droppedItem = null;
            if (rollDrop) {
                droppedItem = weightedRandom(isMilestone ? RARE_DROP_TABLE : DROP_TABLE);

                // One atomic pipeline update so the drop and the milestone claim
                // commit together. The bare `$push` this replaced added a second
                // slot whenever the user already held the item, stranding the
                // quantity in it — every reader takes the first matching slot.
                //
                // `$setUnion` is the pipeline form of `$addToSet`: operator-syntax
                // updates can't be mixed into an aggregation-pipeline update.
                const dropSet = {};
                if (droppedItem.streakFlag) dropSet['streak.revivalToken'] = true;
                if (isMilestone) {
                    dropSet['streak.claimedDropMilestones'] = {
                        $setUnion: [{ $ifNull: ['$streak.claimedDropMilestones', []] }, [streakCurrent]],
                    };
                }
                await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    [{ $set: {
                        ...(droppedItem.streakFlag ? {} : { inventory: inventoryAddExpr(droppedItem.itemId, 1) }),
                        ...dropSet,
                    } }]
                );

                logTransaction({
                    userId: interaction.user.id,
                    guildId: interaction.guild.id,
                    type: 'daily_drop',
                    amount: 0,
                    balance: updated.balance,
                    note: `${droppedItem.itemId}${isMilestone ? ` (streak milestone ${streakCurrent}d)` : ''}`
                });
            }
            // ─────────────────────────────────────────────────────────────────────

            const currency = guildSettings?.economy?.currency || '💰';
            const streakColor = getStreakColor(streakCurrent);
            // ── Streak rank lookup ────────────────────────────────────────────────
            let streakRank = null;
            if (streakCurrent > 0) {
                const aheadCount = await User.countDocuments({
                    guildId: interaction.guild.id,
                    'streak.current': { $gt: streakCurrent }
                });
                streakRank = aheadCount + 1;
            }
            // ─────────────────────────────────────────────────────────────────────

            const isFirstDaily = !user.onboarding?.firstDailyClaimed;
            if (isFirstDaily) {
                User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    { $set: { 'onboarding.firstDailyClaimed': true } }
                ).catch(err => console.error('[daily] onboarding flag update failed:', err.message));
            }

            const rankMedals = { 1: '🥇', 2: '🥈', 3: '🥉' };
            const rankMedal = streakRank && rankMedals[streakRank] ? `${rankMedals[streakRank]} ` : '';
            const baseRankText = streakRank
                ? `🔥 Your ${streakCurrent}-day streak · ${rankMedal}Ranked #${streakRank} on this server  •  Cooldown: 24h`
                : 'Cooldown: 24h';
            const rankText = isFirstDaily
                ? 'Tip: Claim daily every day to build your streak — streaks multiply your earnings!'
                : baseRankText;

            const rewardEmbed = new EmbedBuilder()
                .setColor(streakColor)
                .setTitle(getStreakTitle(streakCurrent, isMilestone))
                .setDescription(
                    getStreakDescription(streakCurrent, isMilestone) + '\n\n' +
                    buildRewardBlock(actualAmount, streakCurrent, streakMult, coinMult, serverMult, combined, updated.balance, capActive, droppedItem, isMilestone, streakCurrent, currency)
                )
                .setFooter({ text: rankText })
                .setTimestamp();

            const freezeCount = user.streak?.freezes ?? 0;
            if (freezeCount > 0) {
                rewardEmbed.addFields({ name: '❄️ Streak Freezes', value: `${freezeCount} banked`, inline: true });
            }

            const milestoneTeaser = getNextStreakMilestone(streakCurrent);
            if (milestoneTeaser) {
                rewardEmbed.addFields({ name: '📊 Streak Progress', value: milestoneTeaser, inline: false });
            }

            if (starterKitResult) {
                rewardEmbed.addFields({
                    name: '🎁 Welcome to Clawdia!',
                    value: `Starter kit claimed: **+${starterKitResult.coins.toLocaleString()} coins** · 🛟 Lifesaver · 🍀 Lucky Charm`,
                    inline: false,
                });
            }

            const challenge = generateDailyChallenge();
            const challengeEmbed = new EmbedBuilder()
                .setColor(COLORS.INFO)
                .setTitle('⚡ Quick Challenge — Earn +50%')
                .setDescription(`> ${challenge.description}\n\nYou have **${Math.round(challenge.timeLimit / 1000)} seconds**.`);

            const sendOpts = { embeds: [rewardEmbed, challengeEmbed], components: [challenge.row], fetchReply: true };
            const reply = usedFollowUp
                ? await interaction.followUp(sendOpts)
                : await interaction.reply(sendOpts);

            // ── Milestone public announcement ─────────────────────────────────────
            if (isMilestone && guildSettings?.economy?.announceStreakMilestones !== false) {
                const announcementChannelId = guildSettings?.economy?.announcementChannelId;
                const channel = announcementChannelId
                    ? interaction.guild.channels.cache.get(announcementChannelId)
                    : null;

                if (channel?.isTextBased()) {
                    const milestoneConfigs = {
                        7: {
                            title: '🔥 One Week Strong',
                            description: `${interaction.user} has claimed their daily reward 7 days in a row.\nThat streak is just getting started.`,
                            color: '#f39c12'
                        },
                        30: {
                            title: '🔥 30-Day Streak Milestone',
                            description: `${interaction.user} has kept their streak alive for a full month.\nConsistent. Relentless.` +
                                (droppedItem ? `\n\nThey received a ${droppedItem.emoji} **${droppedItem.name}** for the dedication.` : ''),
                            color: '#FFD700'
                        },
                        100: {
                            title: '🏆 100-Day Streak — Legendary Dedication',
                            description: `${interaction.user} has claimed their daily reward every single day\nfor 100 days straight.\n\nThis server has witnessed something rare.`,
                            color: '#9b59b6'
                        }
                    };
                    const cfg = milestoneConfigs[streakCurrent] ?? {
                        title: `🔥 ${streakCurrent}-Day Streak Milestone!`,
                        description: `${interaction.user} just hit a **${streakCurrent}-day streak**!` +
                            (droppedItem ? `\nThey found a ${droppedItem.emoji} **${droppedItem.name}** from their milestone drop!` : ''),
                        color: streakColor
                    };
                    const milestoneAnnounce = new EmbedBuilder()
                        .setColor(cfg.color)
                        .setTitle(cfg.title)
                        .setDescription(cfg.description)
                        .setTimestamp();
                    channel.send({ embeds: [milestoneAnnounce] }).catch(() => {});
                }
            }
            // ─────────────────────────────────────────────────────────────────────

            let activateTimer = null;
            if (challenge.type === 'react_fast' && challenge.activeRow) {
                activateTimer = setTimeout(() => {
                    reply.edit({ components: [challenge.activeRow] }).catch(() => {});
                }, challenge.activateDelay);
            }

            const calendarRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(CALENDAR_BUTTON_ID)
                    .setLabel('📅 View Calendar')
                    .setStyle(ButtonStyle.Secondary)
            );

            try {
                const response = await reply.awaitMessageComponent({
                    time: challenge.timeLimit,
                    filter: i => i.user.id === interaction.user.id && i.customId !== CALENDAR_BUTTON_ID,
                });
                if (activateTimer) clearTimeout(activateTimer);

                if (response.customId === challenge.correctId) {
                    const bonusAmount = Math.round(actualAmount * 0.5);
                    const bonusUpdated = await User.findOneAndUpdate(
                        { userId: interaction.user.id, guildId: interaction.guild.id },
                        { $inc: { balance: bonusAmount } },
                        { new: true }
                    );
                    logTransaction({
                        userId: interaction.user.id,
                        guildId: interaction.guild.id,
                        type: 'daily_challenge_bonus',
                        amount: bonusAmount,
                        balance: bonusUpdated?.balance ?? updated.balance + bonusAmount,
                        note: `daily challenge bonus (${challenge.type})`,
                    });

                    if (bonusUpdated && bonusAmount > 0) {
                        const balanceAfterBonus = bonusUpdated.balance ?? 0;
                        await ensureQuests(bonusUpdated, guildSettings);
                        const bonusEarn = await onEconomyEarn(bonusUpdated, guildSettings, bonusAmount);
                        try {
                            await saveWithBalanceDelta(User, bonusUpdated, balanceAfterBonus, {
                                service: 'daily',
                                jobName: 'challengeBonusQuestReward',
                                guildId: interaction.guild.id,
                            });
                            if (bonusEarn.completed.length || bonusEarn.nearComplete.length) {
                                notifyQuestComplete(guildSettings, interaction.member, bonusEarn.completed, interaction.channel, bonusUpdated).catch(() => null);
                                notifyQuestNearComplete(guildSettings, interaction.member, bonusEarn.nearComplete, interaction.channel).catch(() => null);
                            }
                        } catch (err) {
                            console.error('[daily] challenge bonus quest save error:', err);
                        }
                    }

                    const finalBalance = bonusUpdated?.balance ?? updated.balance + bonusAmount;
                    rewardEmbed.setDescription(
                        getStreakDescription(streakCurrent, isMilestone) + '\n\n' +
                        buildRewardBlock(actualAmount, streakCurrent, streakMult, coinMult, serverMult, combined, finalBalance, capActive, droppedItem, isMilestone, streakCurrent, currency)
                    );
                    const winChallengeEmbed = new EmbedBuilder()
                        .setColor(COLORS.PRIZE)
                        .setTitle('⚡ Quick Challenge — Earned!')
                        .setDescription(`✅ Correct! You earned an extra **+${bonusAmount.toLocaleString()} coins**!`);
                    await response.update({ embeds: [rewardEmbed, winChallengeEmbed], components: [calendarRow] });
                } else {
                    const loseChallengeEmbed = new EmbedBuilder()
                        .setColor(COLORS.INFO)
                        .setTitle('⚡ Quick Challenge')
                        .setDescription('❌ Wrong answer! No bonus this time — your daily reward is still yours.');
                    await response.update({ embeds: [rewardEmbed, loseChallengeEmbed], components: [calendarRow] });
                }
            } catch (err) {
                if (activateTimer) clearTimeout(activateTimer);
                if (err.name === 'InteractionCollectorError') {
                    const timeoutChallengeEmbed = new EmbedBuilder()
                        .setColor(COLORS.INFO)
                        .setTitle('⚡ Quick Challenge')
                        .setDescription("⏱️ Time's up! No bonus this time — your daily reward is still yours.");
                    await reply.edit({ embeds: [rewardEmbed, timeoutChallengeEmbed], components: [calendarRow] }).catch(() => {});
                } else {
                    console.error('Daily challenge error:', err);
                    await reply.edit({ components: [] }).catch(() => {});
                }
            }

            // Calendar button handler (60s window after challenge resolves)
            try {
                const calendarResponse = await reply.awaitMessageComponent({
                    time: 60_000,
                    filter: i => i.user.id === interaction.user.id && i.customId === CALENDAR_BUTTON_ID,
                });
                const dailyAmountForCalendar = guildSettings?.economy?.dailyAmount ?? 100;
                const calendarEmbed = buildCalendarEmbed(updated, dailyAmountForCalendar, streakCurrent);
                await calendarResponse.reply({ embeds: [calendarEmbed], flags: MessageFlags.Ephemeral });
                await reply.edit({ components: [] }).catch(() => {});
            } catch {
                // Timeout — just remove the calendar button
                await reply.edit({ components: [] }).catch(() => {});
            }
        } catch (error) {
            console.error('Daily error:', error);
            const errMsg = { content: 'Failed to claim daily reward.', flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(errMsg).catch(() => {});
            } else {
                await interaction.reply(errMsg);
            }
        }
    }
};
