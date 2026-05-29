const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const DEFAULT_JOBS = require('../../data/defaultJobs');
const DEFAULT_TIERS = require('../../data/defaultTiers');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');
const { getCoinMultiplier, getSalaryMultiplier, getServerCoinMultiplier } = require('../../services/effectsService');
const { logTransaction } = require('../../utils/logTransaction');
const { MAX_COMBINED_MULTIPLIER, clampMultiplier } = require('../../config/economy');
const { generateWorkChallenge } = require('../../utils/workChallenge');
const { getTotalBonus } = require('../../services/petService');

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
    { itemId: 'lucky_charm',     emoji: '🍀',   label: 'Lucky Charm' },
    { itemId: 'streak_shield',   emoji: '🔥🛡️', label: 'Streak Shield' },
    { itemId: 'lifesaver',       emoji: '🛟',   label: 'Lifesaver' },
    { itemId: 'coin_booster_2x', emoji: '💰🚀', label: '2x Coin Booster' },
    { itemId: 'xp_booster_2x',  emoji: '⭐🚀', label: '2x XP Booster' },
];

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
            if (user.lastWork && now - user.lastWork.getTime() < 3600000) {
                const minutes = Math.floor((3600000 - (now - user.lastWork.getTime())) / 60000);
                const cooldownEmbed = new EmbedBuilder()
                    .setColor('#95a5a6')
                    .setTitle('😴 Still Clocked Out')
                    .setDescription(`You're recharging from your last shift.\nBack at it in **${minutes} minute${minutes !== 1 ? 's' : ''}**.\n\n> Your next shift could be Exceptional 🔥`);
                return interaction.reply({ embeds: [cooldownEmbed], ephemeral: true });
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
            const rawCombined = streakMult * salaryMult * coinMult * serverMult * petWorkBonus;
            const combined    = clampMultiplier(rawCombined);
            const capActive   = rawCombined > MAX_COMBINED_MULTIPLIER;
            const earned      = Math.round(basedEarned * combined);

            const jobLabel = job.emoji ? `${job.emoji} ${job.name}` : job.name;
            const scenario = WORK_SCENARIOS[Math.floor(Math.random() * WORK_SCENARIOS.length)]
                .replace('{job}', `**${jobLabel}**`);

            const specialEvent = rollSpecialEvent(earned, basePay);
            let finalEarned = earned;
            if (specialEvent) {
                finalEarned = Math.max(0, earned + specialEvent.coinDelta);
            }

            // Challenge fires only when no special event is active (avoids embed conflicts)
            const challengeFires = !specialEvent && Math.random() < 0.15;

            // Atomic update — cooldown condition in query prevents double-credit on concurrent requests
            const updated = await User.findOneAndUpdate(
                {
                    userId: interaction.user.id,
                    guildId: interaction.guild.id,
                    $or: [
                        { lastWork: null },
                        { lastWork: { $lt: new Date(now - 3600000) } }
                    ]
                },
                {
                    $inc: { balance: finalEarned, shiftsWorked: 1 },
                    $set: { lastWork: new Date(now) }
                },
                { new: true }
            );

            if (!updated) {
                return interaction.reply({ content: "You're already working a shift right now!", ephemeral: true });
            }

            // Inventory update for lucky find (separate, non-financial — no race risk)
            if (specialEvent?.item) {
                const itemId = specialEvent.item.itemId;
                const hasItem = user.inventory?.some(i => i.itemId === itemId);
                if (hasItem) {
                    await User.findOneAndUpdate(
                        { userId: interaction.user.id, guildId: interaction.guild.id, 'inventory.itemId': itemId },
                        { $inc: { 'inventory.$.quantity': 1 } }
                    );
                } else {
                    await User.findOneAndUpdate(
                        { userId: interaction.user.id, guildId: interaction.guild.id },
                        { $push: { inventory: { itemId, quantity: 1 } } }
                    );
                }
            }

            logTransaction({
                userId: interaction.user.id,
                guildId: interaction.guild.id,
                type: 'work',
                amount: finalEarned,
                balance: updated.balance,
                note: `${job.name} (${performance.label})${capActive ? ', mult capped' : ''}${challengeFires ? ', challenge' : ''}`
            });

            const nextTier = tierInfo.find(t => t.minShifts > updated.shiftsWorked);
            const promotedTo = tierInfo.find(t => t.minShifts === updated.shiftsWorked);
            const currency = guildSettings?.economy?.currency || '💰';

            const bonusLabels = [];
            if (streakMult > 1.0)   bonusLabels.push(`🔥 ${streakMult}x streak`);
            if (salaryMult > 1.0)   bonusLabels.push(`📈 ${salaryMult}x salary raise`);
            if (coinMult > 1.0)     bonusLabels.push(`💰🚀 ${coinMult}x coin booster`);
            if (serverMult > 1.0)   bonusLabels.push(`🌐 ${serverMult}x server boost`);
            if (petWorkBonus > 1.0) bonusLabels.push(`🐶 ${petWorkBonus.toFixed(2)}x pet bonus`);
            if (capActive)          bonusLabels.push(`⚠️ capped at ${MAX_COMBINED_MULTIPLIER}x`);
            const bonusStr = bonusLabels.length ? ` *(${bonusLabels.join(', ')})*` : '';

            if (challengeFires) {
                const challenge = generateWorkChallenge(job.name);
                const challengeEmbed = new EmbedBuilder()
                    .setColor(performance.color)
                    .setTitle(challenge.title)
                    .setDescription(`*${scenario}*\n\n${challenge.description}`)
                    .addFields({ name: '💡 Bonus', value: 'Answer correctly for a **+40% bonus** on this shift!' })
                    .setFooter({ text: 'You have 20 seconds to answer' })
                    .setTimestamp();

                const reply = await interaction.reply({ embeds: [challengeEmbed], components: [challenge.row], fetchReply: true });

                let bonusEarned = 0;
                let responseRef = null;

                try {
                    const response = await reply.awaitMessageComponent({
                        time: challenge.timeLimit,
                        filter: i => i.user.id === interaction.user.id,
                    });
                    responseRef = response;
                    await responseRef.deferUpdate();

                    if (response.customId === challenge.correctId) {
                        bonusEarned = Math.round(earned * 0.4);
                        await User.findOneAndUpdate(
                            { userId: interaction.user.id, guildId: interaction.guild.id },
                            { $inc: { balance: bonusEarned } }
                        );
                        logTransaction({
                            userId: interaction.user.id,
                            guildId: interaction.guild.id,
                            type: 'work_challenge_bonus',
                            amount: bonusEarned,
                            balance: updated.balance + bonusEarned,
                            note: `work challenge bonus (${challenge.type}) for ${job.name}`,
                        });
                    }
                } catch {
                    // timed out — base payout already secured
                }

                const displayEarned  = finalEarned + bonusEarned;
                const displayBalance = updated.balance + bonusEarned;

                const challengeCareerValue = nextTier
                    ? `${userTier.name} · ${updated.shiftsWorked.toLocaleString()} shifts\nNext up: ${nextTier.name} in **${(nextTier.minShifts - updated.shiftsWorked).toLocaleString()}** more shifts`
                    : `${userTier.name} · ${updated.shiftsWorked.toLocaleString()} shifts\n✅ Max tier reached!`;

                const challengeDescription = performance.exceptional
                    ? `${scenario}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${currency} **${displayEarned.toLocaleString()} coins**  ·  🔥 ${performance.multiplier}x performance\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${challengeCareerValue}\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  Balance: ${currency} ${displayBalance.toLocaleString()} coins`
                    : `${scenario}\n\n${currency} ${displayBalance.toLocaleString()} coins`;

                const workEmbed = new EmbedBuilder()
                    .setColor(performance.color)
                    .setTitle(performance.title)
                    .setDescription(challengeDescription)
                    .setFooter({ text: 'Cooldown: 1h' })
                    .setTimestamp();

                if (!performance.exceptional) {
                    workEmbed.addFields(
                        { name: '💰 Earned',      value: `**${displayEarned.toLocaleString()}** coins${bonusStr}`, inline: true },
                        { name: '📊 Performance', value: performance.label, inline: true },
                        { name: '📈 Career',      value: challengeCareerValue, inline: false }
                    );
                }

                if (bonusEarned > 0) {
                    workEmbed.addFields({ name: '🎯 Challenge Bonus!', value: `✅ Correct! You earned an extra **+${bonusEarned.toLocaleString()}** coins!` });
                } else {
                    workEmbed.addFields({ name: '🎯 Challenge Result', value: responseRef ? '❌ Wrong answer — no bonus this time.' : '⏱️ Time\'s up — no bonus this time.' });
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

            // Normal (no challenge) path
            const careerValue = nextTier
                ? `${userTier.name} · ${updated.shiftsWorked.toLocaleString()} shifts\nNext up: ${nextTier.name} in **${(nextTier.minShifts - updated.shiftsWorked).toLocaleString()}** more shifts`
                : `${userTier.name} · ${updated.shiftsWorked.toLocaleString()} shifts\n✅ Max tier reached!`;

            const normalDescription = performance.exceptional
                ? `${scenario}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${currency} **${finalEarned.toLocaleString()} coins**  ·  🔥 ${performance.multiplier}x performance\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${careerValue}\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  Balance: ${currency} ${updated.balance.toLocaleString()} coins`
                : `${scenario}\n\n${currency} ${updated.balance.toLocaleString()} coins`;

            const embed = new EmbedBuilder()
                .setColor(performance.color)
                .setTitle(performance.title)
                .setDescription(normalDescription)
                .setFooter({ text: 'Cooldown: 1h' })
                .setTimestamp();

            if (!performance.exceptional) {
                embed.addFields(
                    { name: '💰 Earned',      value: `**${finalEarned.toLocaleString()}** coins${bonusStr}`, inline: true },
                    { name: '📊 Performance', value: performance.label, inline: true },
                    { name: '📈 Career',      value: careerValue, inline: false }
                );
            }

            if (specialEvent) {
                embed.addFields(specialEvent.embedField);
            }

            if (promotedTo && promotedTo.minShifts > 0) {
                embed.addFields({
                    name: '🎉 Promotion!',
                    value: `You've been promoted to **${promotedTo.name}** — new jobs and higher pay are now available!`
                });
            }

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Work error:', error);
            await interaction.reply({ content: 'Failed to work.', ephemeral: true });
        }
    }
};
