const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const DEFAULT_JOBS = require('../../data/defaultJobs');
const DEFAULT_TIERS = require('../../data/defaultTiers');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');
const { getCoinMultiplier, getSalaryMultiplier, getServerCoinMultiplier } = require('../../services/effectsService');
const { getMerchantCoinBonus } = require('../../services/synergyService');
const { attachGrind } = require('../../utils/grindProfile');
const { logTransaction } = require('../../utils/logTransaction');
const { grantInventoryItem } = require('../../utils/inventoryGrant');
const { MAX_COMBINED_MULTIPLIER, clampMultiplier } = require('../../config/economy');
const { generateWorkChallenge } = require('../../utils/workChallenge');
const { getTotalBonus } = require('../../services/petService');
const { randomFrom, WORK_ROUGH_LINES, WORK_EXCEPTIONAL_LINES } = require('../../utils/copyLines');
const { stackBar } = require('../../utils/rewardReveal');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');
const { ensureQuests, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../services/questService');
const { saveWithBalanceDelta } = require('../../utils/balanceDelta');
const { recordMissionProgress } = require('../../services/seasonMissionService');

function resolveTiers(guildSettings) {
    const saved = guildSettings?.jobTiers;
    if (saved?.length === 4) return [...saved].sort((a, b) => a.tier - b.tier);
    return DEFAULT_TIERS;
}

// Random scenario lines — {job} is replaced with the formatted job name
const WORK_SCENARIOS = [
    'You showed up early and crushed it as a {job}.',
    'A tough shift as a {job}, but you pulled through.',
    'You went above and beyond as a {job} and the boss noticed.',
    'You kept things running smoothly as a {job}.',
    'You clocked in, did the work, and clocked out as a {job}. Solid.',
    'You impressed a client while working as a {job}.',
    'Chaos reigned at work today, but you held it together as a {job}.',
    'You trained a new hire while working as a {job}. Multi-tasker.',
    'You caught an expensive mistake before it happened as a {job}.',
    'The grind never stops — another shift done as a {job}.',
];

// Items that can be found during a work shift (snake_case itemIds match effectsService canonical IDs)
const LUCKY_FIND_ITEMS = [
    { itemId: 'lucky_charm',      emoji: '🍀',   label: 'Lucky Charm' },
    { itemId: 'streak_shield',    emoji: '🔥🛡️', label: 'Streak Shield' },
    { itemId: 'lifesaver',        emoji: '🛟',   label: 'Lifesaver' },
    { itemId: 'coin_booster_2x',  emoji: '💰🚀', label: '2x Coin Booster' },
    { itemId: 'xp_booster_2x',   emoji: '⭐🚀', label: '2x XP Booster' },
    // Work-exclusive drops — only obtainable from shifts
    { itemId: 'shift_booster',    emoji: '📋',   label: 'Shift Booster',      workExclusive: true },
    { itemId: 'master_key',       emoji: '🔑',   label: 'Master Key',          workExclusive: true },
    { itemId: 'career_badge',     emoji: '📛',   label: 'Career Badge',         workExclusive: true },
];

// Career track mapping: which track each job family belongs to
const CAREER_TRACKS = {
    '🔒 Security':  { jobs: ['guard', 'bouncer', 'officer', 'security'], emoji: '🔒', bonus: '-15% rob success against you (at max level)' },
    '🏦 Finance':   { jobs: ['banker', 'accountant', 'broker', 'trader', 'analyst'], emoji: '🏦', bonus: '+0.05% bank interest/hr (at max level)' },
    '🌿 Wilderness':{ jobs: ['ranger', 'forester', 'scout', 'hunter', 'fisher'], emoji: '🌿', bonus: '+10% hunt/fish/mine stamina regen (at max level)' },
    '🎨 Creative':  { jobs: ['artist', 'designer', 'musician', 'writer', 'streamer'], emoji: '🎨', bonus: 'Unique profile cosmetics (at max level)' },
    '💻 Tech':      { jobs: ['developer', 'engineer', 'programmer', 'data scientist'], emoji: '💻', bonus: '-20% casino house edge (at max level)' },
};

function getCareerTrack(jobName) {
    const lower = jobName.toLowerCase();
    for (const [trackName, track] of Object.entries(CAREER_TRACKS)) {
        if (track.jobs.some(j => lower.includes(j))) return { trackName, ...track };
    }
    return null;
}

// Mutually exclusive special events, checked in priority order (rarest first)
// Returns null or { type, embedField: { name, value } } plus optional coinDelta / item
function rollSpecialEvent(earned, basePay, randomFn = Math.random) {
    const roll = randomFn();
    if (roll < 0.01) {
        return {
            type: 'promotion',
            coinDelta: earned, // doubles total payout
            embedField: { name: '🎊 Double Payout!', value: 'Your boss was so impressed they doubled your pay for this shift!' },
        };
    }
    if (roll < 0.04) {
        const item = LUCKY_FIND_ITEMS[Math.floor(randomFn() * LUCKY_FIND_ITEMS.length)];
        return {
            type: 'lucky_find',
            coinDelta: 0,
            item,
            embedField: { name: '🎁 Lucky Find!', value: `You found a **${item.emoji} ${item.label}** on the job!` },
        };
    }
    if (roll < 0.14) {
        const bonus = Math.round(basePay * (0.25 + randomFn() * 0.25));
        return {
            type: 'bonus',
            coinDelta: bonus,
            embedField: { name: '💸 Bonus Tip!', value: `Your client was thrilled and tipped you an extra **${bonus.toLocaleString()}** coins!` },
        };
    }
    if (roll < 0.19) {
        const penalty = Math.round(basePay * (0.10 + randomFn() * 0.10));
        return {
            type: 'bad_day',
            coinDelta: -penalty,
            embedField: { name: '😬 Rough Day', value: `Something went wrong on the job. You were docked **${penalty.toLocaleString()}** coins.` },
        };
    }
    return null;
}

const PERFORMANCE_TIERS = [
    { label: '💀 Rough Shift',        title: '💀 Rough Shift',        color: '#e74c3c', multiplier: 0.75, chance: 0.10 },
    { label: '😐 Average Shift',      title: '😐 Another Shift Done', color: '#95a5a6', multiplier: 1.00, chance: 0.45 },
    { label: '😊 Good Shift',         title: '😊 Good Work Today',    color: '#2ecc71', multiplier: 1.25, chance: 0.35 },
    { label: '🔥 Exceptional!',       title: '⚡ EXCEPTIONAL SHIFT ⚡', color: '#f39c12', multiplier: 1.60, chance: 0.10, exceptional: true },
];

function rollPerformance() {
    const roll = Math.random();
    let cumulative = 0;
    for (const p of PERFORMANCE_TIERS) {
        cumulative += p.chance;
        if (roll < cumulative) return p;
    }
    return PERFORMANCE_TIERS[1];
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('work')
        .setDescription('Earn coins by working a shift (25–400/tier). Cooldown: 1h. More shifts unlock better jobs.'),
    cooldown: 3600,
    async execute(interaction) {
        const MIN_ACCOUNT_AGE_MS = 7 * 24 * 3_600_000;
        if (Date.now() - interaction.user.createdTimestamp < MIN_ACCOUNT_AGE_MS) {
            return interaction.reply({
                content: '❌ Your Discord account must be at least 7 days old to work shifts.',
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

            // Synergy requirements read hunt/fishing/mining levels, and those
            // live in GrindProfile — they are simply absent from a bare User
            // document, so the Merchant bonus below would silently never fire.
            await attachGrind(user, ['hunt', 'fishing', 'mining']);

            const now = Date.now();
            // Streak-based cooldown reduction: 7–29 day streak → 50min, 30+ → 45min
            const streakDays = user.streak?.current ?? 0;
            const cooldownMs = streakDays >= 30 ? 45 * 60_000 : streakDays >= 7 ? 50 * 60_000 : 3600_000;
            if (user.lastWork && now - user.lastWork.getTime() < cooldownMs) {
                const nextAt = new Date(user.lastWork.getTime() + cooldownMs);
                const cooldownNote = streakDays >= 30 ? ' · 🔥 45min cooldown (30+ day streak)' : streakDays >= 7 ? ' · 🔥 50min cooldown (7+ day streak)' : '';
                return interaction.reply({
                    embeds: [buildCooldownEmbed({
                        title: '💼 Still Clocked Out',
                        description: "You're recharging from your last shift.\nRest up — the grind will be there.",
                        color: '#e67e22',
                        nextAt,
                        nextRewardPreview: `Next shift: chance at 🔥 Exceptional performance · 💸 Bonus Tip · 🎁 Lucky Find${cooldownNote}`,
                    })],
                    flags: MessageFlags.Ephemeral,
                });
            }

            const tierInfo = resolveTiers(guildSettings);
            const currentShifts = user.shiftsWorked || 0;
            const userTier = [...tierInfo].reverse().find(t => currentShifts >= t.minShifts) || tierInfo[0];

            // Dashboard jobs are the source of truth; fall back to defaults if none configured
            const allJobs = guildSettings?.jobs?.length > 0 ? guildSettings.jobs : DEFAULT_JOBS;
            const availableJobs = allJobs.filter(j => (j.tier || 1) <= userTier.tier);
            const jobPool = availableJobs.length > 0 ? availableJobs : allJobs;
            const job = jobPool[Math.floor(Math.random() * jobPool.length)];

            const minPay = job.minPay ?? guildSettings?.economy?.workMin ?? 50;
            const maxPay = job.maxPay ?? guildSettings?.economy?.workMax ?? 150;
            const basePay = Math.floor(Math.random() * (maxPay - minPay + 1)) + minPay;

            const performance = rollPerformance();
            const basedEarned = Math.max(1, Math.floor(basePay * performance.multiplier));
            const streakMult  = getStreakMultiplier(user.streak?.current ?? 0);
            const salaryMult  = getSalaryMultiplier(user);
            const coinMult    = getCoinMultiplier(user);
            const serverMult  = getServerCoinMultiplier(guildSettings);
            const petWorkBonus = 1 + getTotalBonus(user.pets || [], 'work_earnings') / 100;
            // Merchant synergy: +5% while carrying anything at all. Defined and
            // exported since the synergies shipped, and never once read.
            const merchantMult = 1 + getMerchantCoinBonus(user);
            const rawCombined = streakMult * salaryMult * coinMult * serverMult * petWorkBonus * merchantMult;
            const combined    = clampMultiplier(rawCombined);
            const capActive   = rawCombined > MAX_COMBINED_MULTIPLIER;
            const earned      = Math.round(basedEarned * combined);

            const jobLabel = job.emoji ? `${job.emoji} ${job.name}` : job.name;
            let scenario;
            if (performance.exceptional) {
                scenario = randomFrom(WORK_EXCEPTIONAL_LINES) + ` Working as **${jobLabel}**.`;
            } else if (performance.multiplier < 1) {
                scenario = randomFrom(WORK_ROUGH_LINES) + ` Another shift as **${jobLabel}**.`;
            } else {
                scenario = WORK_SCENARIOS[Math.floor(Math.random() * WORK_SCENARIOS.length)]
                    .replace('{job}', `**${jobLabel}**`);
            }

            const specialEvent = rollSpecialEvent(earned, basePay);
            let finalEarned = earned;
            if (specialEvent) {
                finalEarned = Math.max(0, earned + specialEvent.coinDelta);
            }

            // Challenge fires on every run
            const challengeFires = true;

            // Atomic update — cooldown condition in query prevents double-credit on concurrent requests
            const updated = await User.findOneAndUpdate(
                {
                    userId: interaction.user.id,
                    guildId: interaction.guild.id,
                    $or: [
                        { lastWork: null },
                        { lastWork: { $lt: new Date(now - cooldownMs) } }
                    ]
                },
                {
                    $inc: { balance: finalEarned, shiftsWorked: 1 },
                    $set: { lastWork: new Date(now) }
                },
                { new: true }
            );

            if (!updated) {
                return interaction.reply({ content: "You're already working a shift right now!", flags: MessageFlags.Ephemeral });
            }

            // Inventory update for lucky find. The slot test and the write happen
            // inside one atomic update — the read-then-push it replaced let two
            // concurrent finds both push and strand a quantity in the second slot.
            if (specialEvent?.item) {
                await grantInventoryItem(interaction.user.id, interaction.guild.id, specialEvent.item.itemId, 1);
            }

            logTransaction({
                userId: interaction.user.id,
                guildId: interaction.guild.id,
                type: 'work',
                amount: finalEarned,
                balance: updated.balance,
                note: `${job.name} (${performance.label})${capActive ? ', mult capped' : ''}${challengeFires ? ', challenge' : ''}`
            });

            // Quest progress for coins earned this shift. A quest completing here
            // pays coins, and `save()` writes `balance` as an absolute `$set` — so
            // the reward is folded out of the save and applied as its own `$inc`,
            // leaving anything else the player spent meanwhile intact.
            let questsDone = [], questsNear = [];
            const balanceAfterShift = updated.balance ?? 0;
            try {
                // Inside the guard, not above it: the shift is already paid and
                // the cooldown already set, so a quest lookup that throws must
                // not cost the player the result embed for a shift they worked.
                await ensureQuests(updated, guildSettings);
                if (finalEarned > 0) {
                    const earn = await onEconomyEarn(updated, guildSettings, finalEarned);
                    questsDone = earn.completed;
                    questsNear = earn.nearComplete;
                }
                // Season pass daily missions advance on the same shift. Recorded
                // in memory; the save below carries it.
                recordMissionProgress(updated, 'work', 1, guildSettings);
                await saveWithBalanceDelta(User, updated, balanceAfterShift, {
                    service: 'work',
                    jobName: 'shiftQuestReward',
                    guildId: interaction.guild.id,
                });
                if (questsDone.length || questsNear.length) {
                    notifyQuestComplete(guildSettings, interaction.member, questsDone, interaction.channel, updated).catch(() => null);
                    notifyQuestNearComplete(guildSettings, interaction.member, questsNear, interaction.channel).catch(() => null);
                }
            } catch (err) {
                console.error('[work] quest save error:', err);
            }

            const nextTier = tierInfo.find(t => t.minShifts > updated.shiftsWorked);
            const promotedTo = tierInfo.find(t => t.minShifts === updated.shiftsWorked);
            const currency = guildSettings?.economy?.currency || '💰';

            // Canonical stack-bar for multiplier display
            const multEntries = [];
            if (streakMult > 1.0)   multEntries.push({ emoji: '🔥', label: `${streakMult}x` });
            if (salaryMult > 1.0)   multEntries.push({ emoji: '📈', label: `${salaryMult}x` });
            if (coinMult > 1.0)     multEntries.push({ emoji: '💰🚀', label: `${coinMult}x` });
            if (serverMult > 1.0)   multEntries.push({ emoji: '🌐', label: `${serverMult}x` });
            if (petWorkBonus > 1.0) multEntries.push({ emoji: '🐶', label: `${petWorkBonus.toFixed(2)}x` });
            const bar = stackBar(multEntries, combined, finalEarned, currency);
            const capNote = capActive ? `\n  ⚠️ capped at ${MAX_COMBINED_MULTIPLIER}x` : '';
            const bonusStr = bar ? `\n  ${bar}${capNote}` : '';

            const careerValue = nextTier
                ? `${userTier.name} · ${updated.shiftsWorked.toLocaleString()} shifts\nNext up: ${nextTier.name} in **${(nextTier.minShifts - updated.shiftsWorked).toLocaleString()}** more shifts`
                : `${userTier.name} · ${updated.shiftsWorked.toLocaleString()} shifts\n✅ Max tier reached!`;
            const careerValueIndented = careerValue.split('\n').map(line => '  ' + line).join('\n');

            if (challengeFires) {
                const challenge = generateWorkChallenge(job.name);
                const isFirstWork = !updated.onboarding?.firstWorkDone;
                const footerText = isFirstWork
                    ? 'Tip: Higher job tiers unlock as you work more shifts. Keep grinding!'
                    : 'Answer correctly for a bonus · Cooldown: 1h';

                const challengeEmbed = new EmbedBuilder()
                    .setColor(performance.color)
                    .setTitle(challenge.title)
                    .setDescription(`*${scenario}*\n\n${challenge.description}`)
                    .addFields({ name: '💡 Bonus', value: 'Fast correct answer: **+55%** · Correct answer: **+40%**' })
                    .setFooter({ text: footerText })
                    .setTimestamp();

                const reply = await interaction.reply({ embeds: [challengeEmbed], components: [challenge.row], fetchReply: true });

                // Mark first work done (non-blocking)
                if (isFirstWork) {
                    User.findOneAndUpdate(
                        { userId: interaction.user.id, guildId: interaction.guild.id },
                        { $set: { 'onboarding.firstWorkDone': true } }
                    ).catch(() => {});
                }

                let bonusEarned = 0;
                let responseRef = null;
                let exceptionalChallenge = false;

                try {
                    const response = await reply.awaitMessageComponent({
                        time: challenge.timeLimit,
                        filter: i => i.user.id === interaction.user.id,
                    });
                    responseRef = response;
                    await responseRef.deferUpdate();

                    if (response.customId === challenge.correctId) {
                        const elapsed = Date.now() - challenge.startedAt;
                        exceptionalChallenge = elapsed <= 5000;
                        const bonusRate = exceptionalChallenge ? 0.55 : 0.40;
                        bonusEarned = Math.round(earned * bonusRate);
                        const bonusUpdated = await User.findOneAndUpdate(
                            { userId: interaction.user.id, guildId: interaction.guild.id },
                            { $inc: { balance: bonusEarned } },
                            { new: true }
                        );
                        logTransaction({
                            userId: interaction.user.id,
                            guildId: interaction.guild.id,
                            type: 'work_challenge_bonus',
                            amount: bonusEarned,
                            balance: updated.balance + bonusEarned,
                            note: `work challenge bonus (${challenge.type}${exceptionalChallenge ? ', fast' : ''}) for ${job.name}`,
                        });

                        if (bonusUpdated && bonusEarned > 0) {
                            try {
                                const balanceAfterBonus = bonusUpdated.balance ?? 0;
                                await ensureQuests(bonusUpdated, guildSettings);
                                const earn = await onEconomyEarn(bonusUpdated, guildSettings, bonusEarned);
                                await saveWithBalanceDelta(User, bonusUpdated, balanceAfterBonus, {
                                    service: 'work',
                                    jobName: 'challengeBonusQuestReward',
                                    guildId: interaction.guild.id,
                                });
                                if (earn.completed.length || earn.nearComplete.length) {
                                    notifyQuestComplete(guildSettings, interaction.member, earn.completed, interaction.channel, bonusUpdated).catch(() => null);
                                    notifyQuestNearComplete(guildSettings, interaction.member, earn.nearComplete, interaction.channel).catch(() => null);
                                }
                            } catch (err) {
                                console.error('[work] challenge bonus quest save error:', err);
                            }
                        }
                    }
                } catch {
                    // timed out — base payout already secured
                }

                const displayEarned  = finalEarned + bonusEarned;
                const displayBalance = updated.balance + bonusEarned;

                const challengeDescription = performance.exceptional
                    ? `${scenario}\n\n────────────────────\n  ${currency} **${displayEarned.toLocaleString()} coins**  ·  🔥 ${performance.multiplier}x performance\n────────────────────\n${careerValueIndented}\n────────────────────\n  Balance: ${currency} ${displayBalance.toLocaleString()} coins`
                    : `${scenario}\n\n────────────────────\n  💰 **${displayEarned.toLocaleString()} coins**${bonusStr}\n  Balance: ${currency} ${displayBalance.toLocaleString()} coins\n────────────────────`;

                const workEmbed = new EmbedBuilder()
                    .setColor(performance.color)
                    .setTitle(performance.title)
                    .setDescription(challengeDescription)
                    .setFooter({ text: 'Cooldown: 1h' })
                    .setTimestamp();

                if (!performance.exceptional) {
                    workEmbed.addFields(
                        { name: '📊 Performance', value: performance.label, inline: false },
                        { name: '📈 Career',      value: careerValue,       inline: false }
                    );
                }

                if (bonusEarned > 0) {
                    const bonusLabel = exceptionalChallenge
                        ? `⚡ Lightning fast! You earned an extra **+${bonusEarned.toLocaleString()}** coins! (+55%)`
                        : `✅ Correct! You earned an extra **+${bonusEarned.toLocaleString()}** coins! (+40%)`;
                    workEmbed.addFields({ name: exceptionalChallenge ? '🎯 Exceptional Challenge!' : '🎯 Challenge Bonus!', value: bonusLabel });
                } else {
                    workEmbed.addFields({ name: '🎯 Challenge Result', value: responseRef ? '❌ Wrong answer — no bonus this time.' : '⏱️ Time\'s up — no bonus this time.' });
                }

                if (specialEvent) {
                    workEmbed.addFields(specialEvent.embedField);
                }

                const careerTrack = getCareerTrack(job.name);
                if (careerTrack) {
                    workEmbed.addFields({ name: `${careerTrack.emoji} Career Track: ${careerTrack.trackName}`, value: careerTrack.bonus, inline: false });
                }

                if (promotedTo && promotedTo.minShifts > 0) {
                    workEmbed.addFields({ name: '🎉 Promotion!', value: `You've been promoted to **${promotedTo.name}** — new jobs and higher pay are now available!` });
                }

                if (responseRef) {
                    await responseRef.message.edit({ embeds: [workEmbed], components: [] }).catch(() => {});
                } else {
                    await interaction.editReply({ embeds: [workEmbed], components: [] }).catch(() => {});
                }
                return;
            }
        } catch (error) {
            console.error('Work error:', error);
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({ content: 'Failed to work.', embeds: [], components: [] }).catch(() => {});
            } else {
                await interaction.reply({ content: 'Failed to work.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        }
    }
};
