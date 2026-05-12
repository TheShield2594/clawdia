const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const DEFAULT_JOBS = require('../../data/defaultJobs');
const DEFAULT_TIERS = require('../../data/defaultTiers');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');
const { getCoinMultiplier, getSalaryMultiplier, getServerCoinMultiplier } = require('../../services/effectsService');

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

// Items that can be found during a work shift (positive/neutral only)
const LUCKY_FIND_ITEMS = [
    { itemId: 'lucky charm',   emoji: '🍀', label: 'Lucky Charm' },
    { itemId: 'streak shield', emoji: '🔥🛡️', label: 'Streak Shield' },
    { itemId: 'lifesaver',     emoji: '🛟', label: 'Lifesaver' },
    { itemId: 'coin booster',  emoji: '💰🚀', label: '2x Coin Booster' },
    { itemId: 'xp booster',    emoji: '⭐🚀', label: '2x XP Booster' },
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
    { label: '💀 Rough Shift',   color: '#e74c3c', multiplier: 0.75, chance: 0.10 },
    { label: '😐 Average Shift', color: '#95a5a6', multiplier: 1.00, chance: 0.45 },
    { label: '😊 Good Shift',    color: '#2ecc71', multiplier: 1.25, chance: 0.35 },
    { label: '🔥 Exceptional!',  color: '#f39c12', multiplier: 1.60, chance: 0.10 },
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
            let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

            if (!user) {
                user = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });
            }

            const now = Date.now();
            if (user.lastWork && now - user.lastWork.getTime() < 3600000) {
                const minutes = Math.floor((3600000 - (now - user.lastWork.getTime())) / 60000);
                return interaction.reply({ content: `You're too tired to work! Rest for **${minutes}** more minutes.`, ephemeral: true });
            }

            const tierInfo = resolveTiers(guildSettings);
            const currentShifts = user.shiftsWorked || 0;
            const userTier = [...tierInfo].reverse().find(t => currentShifts >= t.minShifts) || tierInfo[0];
            const nextTier = tierInfo.find(t => t.minShifts > currentShifts);

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
            const earned = Math.round(basedEarned * streakMult * salaryMult * coinMult * serverMult);

            const jobLabel = job.emoji ? `${job.emoji} ${job.name}` : job.name;
            const scenario = WORK_SCENARIOS[Math.floor(Math.random() * WORK_SCENARIOS.length)]
                .replace('{job}', `**${jobLabel}**`);

            const specialEvent = rollSpecialEvent(earned, basePay);
            let finalEarned = earned;
            if (specialEvent) {
                finalEarned = Math.max(0, earned + specialEvent.coinDelta);
                if (specialEvent.item) {
                    if (!Array.isArray(user.inventory)) user.inventory = [];
                    const existing = user.inventory.find(i => i.itemId === specialEvent.item.itemId);
                    if (existing) existing.quantity = (Number(existing.quantity) || 0) + 1;
                    else user.inventory.push({ itemId: specialEvent.item.itemId, quantity: 1 });
                }
            }

            user.balance += finalEarned;
            user.shiftsWorked = currentShifts + 1;
            user.lastWork = new Date();
            await user.save();

            const promotedTo = tierInfo.find(t => t.minShifts === user.shiftsWorked);
            const currency = guildSettings?.economy?.currency || '💰';

            const bonusLabels = [];
            if (streakMult > 1.0)  bonusLabels.push(`🔥 ${streakMult}x streak`);
            if (salaryMult > 1.0)  bonusLabels.push(`📈 ${salaryMult}x salary raise`);
            if (coinMult > 1.0)    bonusLabels.push(`💰🚀 ${coinMult}x coin booster`);
            if (serverMult > 1.0)  bonusLabels.push(`🌐 ${serverMult}x server boost`);
            const bonusStr = bonusLabels.length ? ` *(${bonusLabels.join(', ')})*` : '';

            const embed = new EmbedBuilder()
                .setColor(performance.color)
                .setTitle(`${performance.label} — Work Complete!`)
                .setDescription(scenario)
                .addFields(
                    { name: 'Earned',       value: `${currency} **${finalEarned.toLocaleString()}** coins${bonusStr}`, inline: true },
                    { name: 'Performance',  value: performance.label, inline: true },
                    { name: 'Career Tier',  value: `${userTier.name} · ${user.shiftsWorked.toLocaleString()} shifts`, inline: false },
                    {
                        name: 'Next Promotion',
                        value: nextTier
                            ? `${nextTier.name} in **${(nextTier.minShifts - user.shiftsWorked).toLocaleString()}** shifts`
                            : '✅ Max tier reached!',
                        inline: false
                    },
                    { name: 'Balance', value: `${currency} ${user.balance.toLocaleString()}`, inline: false }
                )
                .setFooter({ text: 'Cooldown: 1h' })
                .setTimestamp();

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
