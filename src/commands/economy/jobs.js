const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const DEFAULT_JOBS = require('../../data/defaultJobs');

const TIER_INFO = [
    { tier: 1, name: 'Intern',            minShifts: 0,  emoji: '🟢' },
    { tier: 2, name: 'Skilled Worker',    minShifts: 10, emoji: '🔵' },
    { tier: 3, name: 'Senior Specialist', minShifts: 25, emoji: '🟣' },
    { tier: 4, name: 'Executive',         minShifts: 50, emoji: '🟡' },
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
