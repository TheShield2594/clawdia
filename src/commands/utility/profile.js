'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { pruneEffects, EFFECT_CONFIGS, timeRemaining } = require('../../services/effectsService');
const { getStreakMultiplier, MILESTONES } = require('../../utils/streakMultiplier');

const PRESTIGE_BADGES = ['', '🥉', '🥈', '🥇', '🏆', '💎'];

const TRACK_INFO = {
    none:    { label: 'None',    emoji: '⚪' },
    creator: { label: 'Creator', emoji: '🎨' },
    helper:  { label: 'Helper',  emoji: '🤝' },
    raider:  { label: 'Raider',  emoji: '⚔️' },
};

// 60-second in-memory cache: key -> { embedData, timestamp }
const profileCache = new Map();
const CACHE_TTL = 60_000;

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('profile')
        .setDescription('View a unified profile card showing all your key stats.')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User whose profile to display (defaults to yourself).')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('private')
                .setDescription('Show profile only to you. Default: false (public).')
                .setRequired(false)),

    async execute(interaction) {
        const targetUser = interaction.options.getUser('user') ?? interaction.user;
        const isPrivate  = interaction.options.getBoolean('private') ?? false;
        const isSelf     = targetUser.id === interaction.user.id;

        const cacheKey = `${targetUser.id}:${interaction.guild.id}`;
        const cached   = profileCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return interaction.reply({ embeds: [cached.embedData], ephemeral: isPrivate });
        }

        try {
            const [userData, guildSettings] = await Promise.all([
                User.findOne({ userId: targetUser.id, guildId: interaction.guild.id }),
                Guild.findOne({ guildId: interaction.guild.id }),
            ]);

            if (!userData) {
                return interaction.reply({
                    content: isSelf
                        ? "You don't have a profile yet. Start chatting to build one!"
                        : `${targetUser.username} doesn't have a profile yet.`,
                    ephemeral: true,
                });
            }

            pruneEffects(userData);

            const currency = guildSettings?.economy?.currency ?? '💰';

            // ── Section 1: Identity ───────────────────────────────────────────
            const member   = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
            const joinedAt = member?.joinedAt
                ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:D>`
                : 'Unknown';
            const nickname = member?.nickname ?? null;
            const track    = TRACK_INFO[userData.track ?? 'none'];

            const identityLines = [
                nickname ? `**Nickname:** ${nickname}` : null,
                `**Joined:** ${joinedAt}`,
                `**Track:** ${track.emoji} ${track.label}`,
            ].filter(Boolean).join('\n');

            // ── Section 2: Leveling ───────────────────────────────────────────
            const requiredXp = userData.level * 100 + 100;
            const allUsers   = await User.find({ guildId: interaction.guild.id })
                .sort({ level: -1, xp: -1 })
                .select('userId');
            const serverRank = allUsers.findIndex(u => u.userId === targetUser.id) + 1;

            const levelingLines = [
                `**Level:** ${userData.level}  ·  **Rank:** #${serverRank}`,
                `**XP:** ${userData.xp.toLocaleString()} / ${requiredXp.toLocaleString()}`,
                buildProgressBar(userData.xp, requiredXp),
                `**Messages:** ${(userData.messages ?? 0).toLocaleString()}`,
            ].join('\n');

            // ── Section 3: Economy ────────────────────────────────────────────
            const streakMult = getStreakMultiplier(userData.streak?.current ?? 0);
            const total      = userData.balance + userData.bank;

            const effectLines = (userData.activeEffects ?? []).map(e => {
                const cfg = EFFECT_CONFIGS[e.type];
                if (!cfg) return null;
                const dur = e.expiresAt ? timeRemaining(e.expiresAt) : e.charges === 1 ? '1 use' : 'permanent';
                return `${cfg.emoji} ${cfg.label} (${dur})`;
            }).filter(Boolean);

            const economyLines = [
                `**Wallet:** ${currency}${userData.balance.toLocaleString()}  ·  **Bank:** ${currency}${userData.bank.toLocaleString()}`,
                `**Total:** ${currency}${total.toLocaleString()}`,
                streakMult > 1.0 ? `**Streak Bonus:** ${streakMult}x coins & XP 🔥` : null,
                effectLines.length ? `**Active Effects:** ${effectLines.join(', ')}` : null,
            ].filter(Boolean).join('\n');

            // ── Section 4: Activity ───────────────────────────────────────────
            const current  = userData.streak?.current ?? 0;
            const longest  = userData.streak?.longest ?? 0;
            const questsDone = (userData.quests ?? []).filter(q => q.completedAt).length;
            const seasonTier = userData.season?.tier ?? 0;

            const activityLines = [
                `**Streak:** ${current >= 7 ? '🔥' : '❄️'} ${current} day${current !== 1 ? 's' : ''} (longest: ${longest})`,
                `**Quests Completed:** ${questsDone}`,
                `**Season Tier:** ${seasonTier > 0 ? `Tier ${seasonTier}` : 'None yet'}`,
            ].join('\n');

            // ── Section 5: Achievements & Badges ─────────────────────────────
            const claimedMilestones = new Set(userData.streak?.claimedMilestones ?? []);
            const badges = [];

            const huntPrestige = userData.hunt?.prestige ?? 0;
            if (huntPrestige > 0) {
                badges.push(`${PRESTIGE_BADGES[Math.min(huntPrestige, 5)]} Hunter Prestige ${huntPrestige}`);
            }

            const fishPrestige = userData.fishing?.prestige ?? 0;
            if (fishPrestige > 0) {
                badges.push(`${PRESTIGE_BADGES[Math.min(fishPrestige, 5)]} Fisher Prestige ${fishPrestige}`);
            }

            for (const m of MILESTONES) {
                if (claimedMilestones.has(m.days)) {
                    badges.push(`🎖️ ${m.badge}`);
                }
            }

            const badgesText = badges.slice(0, 6).join('  ·  ') || 'No badges earned yet.';

            // ── Section 6: Stats Snapshot ─────────────────────────────────────
            const huntLevel  = userData.hunt?.level ?? 1;
            const fishLevel  = userData.fishing?.level ?? 1;
            const totalHunts = userData.hunt?.totalHunts ?? 0;
            const totalCasts = userData.fishing?.totalCasts ?? 0;
            const msgCount   = userData.messages ?? 0;

            const activities = [
                { name: 'Hunting',   count: totalHunts },
                { name: 'Fishing',   count: totalCasts },
                { name: 'Messaging', count: msgCount },
            ];
            const favorite = activities.reduce((a, b) => b.count > a.count ? b : a);

            const statsLines = [
                `**Hunt Level:** ${huntLevel}  ·  **Fish Level:** ${fishLevel}`,
                `**Total Hunts:** ${totalHunts.toLocaleString()}  ·  **Fish Caught:** ${totalCasts.toLocaleString()}`,
                `**Favorite Activity:** ${favorite.name} (${favorite.count.toLocaleString()})`,
            ].join('\n');

            // ── Build embed ───────────────────────────────────────────────────
            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(`${targetUser.username}'s Profile`)
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: '👤 Identity',                 value: identityLines,  inline: false },
                    { name: '📈 Leveling',                 value: levelingLines,  inline: false },
                    { name: '💰 Economy',                  value: economyLines,   inline: false },
                    { name: '⚡ Activity',                  value: activityLines,  inline: false },
                    { name: '🏅 Achievements & Badges',    value: badgesText,     inline: false },
                    { name: '🎯 Stats Snapshot',           value: statsLines,     inline: false },
                )
                .setFooter({ text: 'Refreshes every 60 s · /rank /balance /streak for detailed views' })
                .setTimestamp();

            const embedData = embed.toJSON();
            profileCache.set(cacheKey, { embedData, timestamp: Date.now() });

            return interaction.reply({ embeds: [embedData], ephemeral: isPrivate });
        } catch (error) {
            console.error('Profile error:', error);
            return interaction.reply({ content: 'Failed to fetch profile.', ephemeral: true });
        }
    },
};

function buildProgressBar(current, total, length = 20) {
    const filled = Math.min(length, Math.max(0, Math.round((current / total) * length)));
    const pct    = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
    return `${'█'.repeat(filled)}${'░'.repeat(length - filled)} ${pct}%`;
}
