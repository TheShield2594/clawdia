const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const DEFAULT_JOBS = require('../../data/defaultJobs');
const DEFAULT_TIERS = require('../../data/defaultTiers');

const TIER_EMOJIS = { 1: '🟢', 2: '🔵', 3: '🟣', 4: '🟡' };

function resolveTiers(guildSettings) {
    const saved = guildSettings?.jobTiers;
    if (saved?.length === 4) return [...saved].sort((a, b) => a.tier - b.tier);
    return DEFAULT_TIERS;
}

const EMBED_DESC_LIMIT = 4096;

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

            const tierInfo = resolveTiers(guildSettings);
            const currentShifts = user?.shiftsWorked || 0;
            const userTier = [...tierInfo].reverse().find(t => currentShifts >= t.minShifts) || tierInfo[0];
            const currency = guildSettings?.economy?.currency || '💰';

            const allJobs = guildSettings?.jobs?.length > 0 ? guildSettings.jobs : DEFAULT_JOBS;

            const byTier = {};
            for (const job of allJobs) {
                const t = job.tier || 1;
                if (!byTier[t]) byTier[t] = [];
                byTier[t].push(job);
            }

            const userTierEmoji = TIER_EMOJIS[userTier.tier] || '🟢';

            // Build the full job listing as a single description block with tier dividers
            const sections = [];
            for (const tierMeta of tierInfo) {
                const jobs = byTier[tierMeta.tier];
                if (!jobs || jobs.length === 0) continue;

                const unlocked    = userTier.tier >= tierMeta.tier;
                const unlockText  = unlocked ? '' : ` *(unlocks at ${tierMeta.minShifts} shifts)*`;
                const tierEmoji   = TIER_EMOJIS[tierMeta.tier] || '⚪';
                const tierHeader  = `**${tierEmoji} Tier ${tierMeta.tier}: ${tierMeta.name}**${unlockText}`;

                const jobLines = jobs.map(j => {
                    const label = j.emoji ? `${j.emoji} ${j.name}` : j.name;
                    const pay   = (j.minPay != null && j.maxPay != null)
                        ? `${currency}${j.minPay}–${j.maxPay}`
                        : '–';
                    const lock  = unlocked ? '' : ' 🔒';
                    return `  ${label}${lock} — **${pay}**`;
                }).join('\n');

                sections.push(`${tierHeader}\n${jobLines}`);
            }

            const nextTier = tierInfo.find(t => t.minShifts > currentShifts);
            const footerText = nextTier
                ? `${nextTier.minShifts - currentShifts} more shifts to unlock ${nextTier.name} jobs`
                : 'Max career tier reached — all jobs unlocked!';

            const header =
                `Career: **${userTierEmoji} ${userTier.name}** · ${currentShifts} shifts worked\n` +
                `Use **/work** every hour to earn coins!\n\n`;

            // Guard against Discord's 4096-char embed description limit
            const HEADER_LEN = header.length;
            const BUDGET     = EMBED_DESC_LIMIT - HEADER_LEN;
            let body         = sections.join('\n\n');
            if (body.length > BUDGET) {
                let included = 0;
                let truncated = '';
                for (const section of sections) {
                    const candidate = (truncated ? truncated + '\n\n' : '') + section;
                    if (candidate.length > BUDGET - 30) break;
                    truncated = candidate;
                    included++;
                }
                const remaining = sections.length - included;
                body = truncated + (remaining > 0 ? `\n\n*…+${remaining} more tier${remaining !== 1 ? 's' : ''} not shown*` : '');
            }

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('📋 Job Listings')
                .setDescription(header + body)
                .setFooter({ text: footerText })
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Jobs command error:', error);
            await interaction.reply({ content: 'Failed to load job listings.', ephemeral: true });
        }
    }
};
