const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

const TIER_INFO = [
    { tier: 1, name: 'Intern',            minShifts: 0,  emoji: '🟢' },
    { tier: 2, name: 'Skilled Worker',    minShifts: 10, emoji: '🔵' },
    { tier: 3, name: 'Senior Specialist', minShifts: 25, emoji: '🟣' },
    { tier: 4, name: 'Executive',         minShifts: 50, emoji: '🟡' },
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

module.exports = {
    data: new SlashCommandBuilder()
        .setName('jobs')
        .setDescription('Browse all available jobs, their tiers, and pay ranges'),
    async execute(interaction) {
        try {
            const [user, guildSettings] = await Promise.all([
                User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
                Guild.findOne({ guildId: interaction.guild.id }),
            ]);

            const currentShifts = user?.shiftsWorked || 0;
            const userTier = [...TIER_INFO].reverse().find(t => currentShifts >= t.minShifts) || TIER_INFO[0];
            const currency = guildSettings?.economy?.currency || '💰';

            const allJobs = guildSettings?.jobs?.length > 0 ? guildSettings.jobs : DEFAULT_JOBS;

            // Group jobs by tier
            const byTier = {};
            for (const job of allJobs) {
                const t = job.tier || 1;
                if (!byTier[t]) byTier[t] = [];
                byTier[t].push(job);
            }

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('📋 Job Listings')
                .setDescription(
                    `Your career tier: **${userTier.emoji} ${userTier.name}** · ${currentShifts} shifts worked\n` +
                    `Use **/work** every hour to earn coins!\n​`
                )
                .setTimestamp();

            for (const tierMeta of TIER_INFO) {
                const jobs = byTier[tierMeta.tier];
                if (!jobs || jobs.length === 0) continue;

                const unlocked = userTier.tier >= tierMeta.tier;
                const unlockText = unlocked ? '' : ` *(unlocks at ${tierMeta.minShifts} shifts)*`;
                const jobLines = jobs.map(j => {
                    const label = j.emoji ? `${j.emoji} ${j.name}` : j.name;
                    const pay = (j.minPay != null && j.maxPay != null)
                        ? `${currency}${j.minPay}–${j.maxPay}`
                        : '–';
                    const lock = unlocked ? '' : ' 🔒';
                    return `${label}${lock} — **${pay}**`;
                }).join('\n');

                embed.addFields({
                    name: `${tierMeta.emoji} Tier ${tierMeta.tier}: ${tierMeta.name}${unlockText}`,
                    value: jobLines || 'No jobs configured.',
                    inline: false,
                });
            }

            const nextTier = TIER_INFO.find(t => t.minShifts > currentShifts);
            if (nextTier) {
                embed.setFooter({ text: `${nextTier.minShifts - currentShifts} more shifts to unlock ${nextTier.name} jobs` });
            } else {
                embed.setFooter({ text: 'Max career tier reached — all jobs unlocked!' });
            }

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Jobs command error:', error);
            await interaction.reply({ content: 'Failed to load job listings.', ephemeral: true });
        }
    }
};
