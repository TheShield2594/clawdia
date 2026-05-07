const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

const TIER_INFO = [
    { tier: 1, name: 'Intern',           minShifts: 0  },
    { tier: 2, name: 'Skilled Worker',   minShifts: 10 },
    { tier: 3, name: 'Senior Specialist',minShifts: 25 },
    { tier: 4, name: 'Executive',        minShifts: 50 },
];

const DEFAULT_JOBS = [
    { name: 'Assistant',  emoji: '📋', tier: 1, minPay: 30,  maxPay: 60  },
    { name: 'Cashier',    emoji: '🏪', tier: 1, minPay: 35,  maxPay: 70  },
    { name: 'Dishwasher', emoji: '🍽️', tier: 1, minPay: 25,  maxPay: 55  },
    { name: 'Courier',    emoji: '📦', tier: 1, minPay: 40,  maxPay: 75  },
    { name: 'Developer',  emoji: '💻', tier: 2, minPay: 80,  maxPay: 140 },
    { name: 'Designer',   emoji: '🎨', tier: 2, minPay: 75,  maxPay: 130 },
    { name: 'Teacher',    emoji: '📚', tier: 2, minPay: 70,  maxPay: 120 },
    { name: 'Chef',       emoji: '👨‍🍳', tier: 2, minPay: 80,  maxPay: 135 },
    { name: 'Driver',     emoji: '🚗', tier: 2, minPay: 65,  maxPay: 115 },
    { name: 'Engineer',   emoji: '⚙️', tier: 3, minPay: 120, maxPay: 200 },
    { name: 'Artist',     emoji: '🖌️', tier: 3, minPay: 110, maxPay: 185 },
    { name: 'Musician',   emoji: '🎵', tier: 3, minPay: 105, maxPay: 180 },
    { name: 'Writer',     emoji: '✍️', tier: 3, minPay: 115, maxPay: 190 },
    { name: 'Analyst',    emoji: '📊', tier: 3, minPay: 125, maxPay: 205 },
    { name: 'Director',   emoji: '🎬', tier: 4, minPay: 200, maxPay: 350 },
    { name: 'Architect',  emoji: '🏛️', tier: 4, minPay: 210, maxPay: 360 },
    { name: 'Surgeon',    emoji: '🏥', tier: 4, minPay: 250, maxPay: 400 },
    { name: 'Producer',   emoji: '🎤', tier: 4, minPay: 195, maxPay: 345 },
    { name: 'Founder',    emoji: '👑', tier: 4, minPay: 220, maxPay: 380 },
];

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
        .setDescription('Work a shift to earn coins'),
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

            const currentShifts = user.shiftsWorked || 0;
            const userTier = [...TIER_INFO].reverse().find(t => currentShifts >= t.minShifts) || TIER_INFO[0];
            const nextTier = TIER_INFO.find(t => t.minShifts > currentShifts);

            // Dashboard jobs are the source of truth; fall back to defaults if none configured
            const allJobs = guildSettings?.jobs?.length > 0 ? guildSettings.jobs : DEFAULT_JOBS;
            const availableJobs = allJobs.filter(j => (j.tier || 1) <= userTier.tier);
            const jobPool = availableJobs.length > 0 ? availableJobs : allJobs;
            const job = jobPool[Math.floor(Math.random() * jobPool.length)];

            const minPay = job.minPay ?? guildSettings?.economy?.workMin ?? 50;
            const maxPay = job.maxPay ?? guildSettings?.economy?.workMax ?? 150;
            const basePay = Math.floor(Math.random() * (maxPay - minPay + 1)) + minPay;

            const performance = rollPerformance();
            const earned = Math.max(1, Math.floor(basePay * performance.multiplier));

            const jobLabel = job.emoji ? `${job.emoji} ${job.name}` : job.name;
            const scenario = WORK_SCENARIOS[Math.floor(Math.random() * WORK_SCENARIOS.length)]
                .replace('{job}', `**${jobLabel}**`);

            user.balance += earned;
            user.shiftsWorked = currentShifts + 1;
            user.lastWork = new Date();
            await user.save();

            const promotedTo = TIER_INFO.find(t => t.minShifts === user.shiftsWorked);
            const currency = guildSettings?.economy?.currency || '💰';

            const embed = new EmbedBuilder()
                .setColor(performance.color)
                .setTitle(`${performance.label} — Work Complete!`)
                .setDescription(scenario)
                .addFields(
                    { name: 'Earned',       value: `${currency} **${earned.toLocaleString()}** coins`, inline: true },
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
                .setTimestamp();

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
