'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const { attachGrind } = require('../../utils/grindProfile');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { pruneEffects, EFFECT_CONFIGS, timeRemaining } = require('../../services/effectsService');
const { getStreakMultiplier, MILESTONES } = require('../../utils/streakMultiplier');
const { badgeFor, titleForExactRank } = require('../../utils/prestige');
const { getActiveSynergies } = require('../../services/synergyService');
const { isPetActive } = require('../../services/petService');
const COLORS = require('../../utils/embedColors');

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
        // `view` and `public` are subcommands rather than options because they do
        // opposite things: one reads a card, the other flips a stored flag. The
        // public opt-in (#1018) is what the dashboard's public page at
        // /s/:guildId/u/:userId gates on — a member is served there only after
        // running `/profile public on`, and is a 404 until then.
        .addSubcommand(sub => sub
            .setName('view')
            .setDescription('View a unified profile card showing all your key stats.')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('User whose profile to display (defaults to yourself).')
                    .setRequired(false))
            .addBooleanOption(option =>
                option.setName('private')
                    .setDescription('Show profile only to you. Default: false (public).')
                    .setRequired(false)))
        .addSubcommand(sub => sub
            .setName('public')
            .setDescription('Choose whether your profile is shown on the server\'s public web page.')
            .addStringOption(option =>
                option.setName('setting')
                    .setDescription('Turn your public profile page on or off.')
                    .setRequired(true)
                    .addChoices(
                        { name: 'On — anyone with the link can see your card', value: 'on' },
                        { name: 'Off — your card is private again (the default)', value: 'off' },
                    ))),

    async execute(interaction) {
        if (interaction.options.getSubcommand() === 'public') {
            return setPublicProfile(interaction);
        }

        const targetUser = interaction.options.getUser('user') ?? interaction.user;
        const isPrivate  = interaction.options.getBoolean('private') ?? false;
        const isSelf     = targetUser.id === interaction.user.id;

        const cacheKey = `${targetUser.id}:${interaction.guild.id}`;
        const cached   = profileCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return interaction.reply({ embeds: [cached.embedData], flags: isPrivate ? MessageFlags.Ephemeral : undefined });
        }

        try {
            const [userData, guildSettings] = await Promise.all([
                User.findOne({ userId: targetUser.id, guildId: interaction.guild.id }),
                getGuildSettings(interaction.guild.id),
            ]);
            await attachGrind(userData);

            if (!userData) {
                return interaction.reply({
                    content: isSelf
                        ? "You don't have a profile yet. Start chatting to build one!"
                        : `${targetUser.username} doesn't have a profile yet.`,
                    flags: MessageFlags.Ephemeral,
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
            const serverRank = await User.countDocuments({
                guildId: interaction.guild.id,
                $or: [
                    { level: { $gt: userData.level } },
                    { level: userData.level, xp: { $gt: userData.xp } },
                ],
            }) + 1;

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
            const mineLevel  = userData.mining?.level ?? 1;
            const totalHunts = userData.hunt?.totalHunts ?? 0;
            const totalCasts = userData.fishing?.totalCasts ?? 0;
            const totalMines = userData.mining?.totalMines ?? 0;
            const exploreLevel = userData.exploration?.level ?? 1;
            const totalTrips   = userData.exploration?.totalExpeditions ?? 0;
            const msgCount   = userData.messages ?? 0;

            const prestigeRank   = userData.accountPrestige?.rank ?? 0;
            const prestigeTitle  = titleForExactRank(prestigeRank);
            const prestigeBadge  = badgeFor(prestigeRank);
            const prestigeLine   = prestigeRank > 0
                ? `**Prestige:** ${prestigeBadge} ${prestigeTitle}`
                : null;

            const activeSynergies = getActiveSynergies(userData);
            const synergyLine = activeSynergies.length
                ? `**Synergies:** ${activeSynergies.map(s => `${s.emoji} ${s.name}`).join('  ·  ')}`
                : null;

            const activePet = (userData.pets ?? []).find(p => isPetActive(p));
            const petLine   = activePet
                ? `**Active Pet:** 🐾 ${activePet.name ?? activePet.petId} (Lv${activePet.level})`
                : null;

            const activities = [
                { name: 'Hunting',   count: totalHunts },
                { name: 'Fishing',   count: totalCasts },
                { name: 'Mining',    count: totalMines },
                { name: 'Exploring', count: totalTrips },
                { name: 'Messaging', count: msgCount },
            ];
            const favorite = activities.reduce((a, b) => b.count > a.count ? b : a);

            const statsLines = [
                prestigeLine,
                `**Hunt Lv:** ${huntLevel}  ·  **Fish Lv:** ${fishLevel}  ·  **Mine Lv:** ${mineLevel}  ·  **Explorer Lv:** ${exploreLevel}`,
                `**Hunts:** ${totalHunts.toLocaleString()}  ·  **Catches:** ${totalCasts.toLocaleString()}  ·  **Mines:** ${totalMines.toLocaleString()}  ·  **Expeditions:** ${totalTrips.toLocaleString()}`,
                synergyLine,
                petLine,
                `**Favorite Activity:** ${favorite.name} (${favorite.count.toLocaleString()})`,
            ].filter(Boolean).join('\n');

            // ── Build embed ───────────────────────────────────────────────────
            const embed = new EmbedBuilder()
                .setColor(COLORS.INFO)
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

            return interaction.reply({ embeds: [embedData], flags: isPrivate ? MessageFlags.Ephemeral : undefined });
        } catch (error) {
            console.error('Profile error:', error);
            return interaction.reply({ content: 'Failed to fetch profile.', flags: MessageFlags.Ephemeral });
        }
    },
};

function buildProgressBar(current, total, length = 20) {
    const filled = Math.min(length, Math.max(0, Math.round((current / total) * length)));
    const pct    = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
    return `${'█'.repeat(filled)}${'░'.repeat(length - filled)} ${pct}%`;
}

// The public-profile opt-in behind /s/:guildId/u/:userId (#1018). Off by default,
// so a card is never on the open web unless its owner put it there; turning it off
// makes the URL a 404 again. Upserted so a member who has never run another economy
// command can still opt in — the row is created just to hold the flag.
async function setPublicProfile(interaction) {
    const on = interaction.options.getString('setting') === 'on';
    try {
        await User.updateOne(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $set: { 'publicProfile.enabled': on } },
            { upsert: true },
        );
    } catch (error) {
        console.error('Profile public toggle error:', error);
        return interaction.reply({ content: 'Failed to update your public profile setting.', flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
        .setColor(on ? COLORS.SUCCESS : COLORS.NEUTRAL)
        .setTitle(on ? '🌐 Public profile enabled' : '🔒 Public profile disabled')
        .setDescription(on
            ? 'Your profile card can now be viewed on this server\'s public web page (if the server has one turned on). Run `/profile public off` to make it private again.'
            : 'Your profile card is private again and will 404 on the public web page.')
        .setFooter({ text: 'Only members who opt in are ever shown publicly.' });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
