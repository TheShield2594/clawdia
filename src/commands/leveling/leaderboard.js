const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { netWorthOf, topByNetWorth, netWorthRank } = require('../../utils/netWorth');
const COLORS = require('../../utils/embedColors');
const { GRIND_TRACKS, buildGrindBoard, buildChampionsHall } = require('../../utils/grindLeaderboard');
const { sendBoard, replyBoard, avatarUrlOf, displayNameOf } = require('../../utils/leaderboardCard');
const { sendEphemeralResponse } = require('../../utils/interactionAck');

// A leaderboard page prints ten names and one number each. Hydrating whole user
// documents to do it dragged the pet, inventory, achievement and quest arrays
// along for the ride — hundreds of subdocuments per row, discarded unread. Each
// board therefore names the fields its own rows actually render, and reads them
// as plain objects.
const ROW_FIELDS = {
    levels:       'userId level xp',
    streaks:      'userId streak.current streak.longest streak.freezes streak.revivalToken',
    duels:        'userId duelWins duelLosses',
    achievements: 'userId achievementsCount',
};

// The "You are here" line is computed for whichever board is showing, so the
// caller's row is read once with the union of what those branches read. `_id`
// comes back regardless and is what netWorthRank ties-breaks on.
const CALLER_FIELDS = 'userId level xp balance bank duelWins duelLosses achievementsCount';

// The picture card's palette and heading for each of this command's own boards.
const CARD = {
    levels:          { theme: 'board',        title: 'Level Leaderboard' },
    economy:         { theme: 'board',        title: 'Richest Members' },
    streaks:         { theme: 'streak',       title: 'Daily Streaks' },
    streaks_longest: { theme: 'streak',       title: 'All-Time Streak Records' },
    duels:           { theme: 'duel',         title: 'Duel Leaderboard' },
    achievements:    { theme: 'achievements', title: 'Achievements' },
};

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n !== 1 ? 's' : ''}`;

module.exports = {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('View the top 10 members on the server leaderboard.')
        .addStringOption(option =>
            option.setName('type')
                .setDescription('Which leaderboard to show (default: Levels).')
                .setRequired(false)
                .addChoices(
                    { name: 'Levels',          value: 'levels' },
                    { name: 'Economy',         value: 'economy' },
                    { name: 'Streaks',         value: 'streaks' },
                    { name: 'Streaks (Longest All-Time)', value: 'streaks_longest' },
                    { name: 'Duels (Most Wins)',          value: 'duels'           },
                    { name: 'Achievements',               value: 'achievements'    },
                    { name: 'Hunting',   value: 'hunting'   },
                    { name: 'Fishing',   value: 'fishing'   },
                    { name: 'Mining',    value: 'mining'    },
                    { name: 'Exploring', value: 'exploring' },
                    { name: 'Hall of Champions', value: 'champions' }
                ))
        .addStringOption(option =>
            option.setName('period')
                .setDescription('For the grind boards: this week\'s live race, or all-time (default: All-time).')
                .setRequired(false)
                .addChoices(
                    { name: 'All-time',  value: 'all-time' },
                    { name: 'This week', value: 'week'     }
                )),
    async execute(interaction) {
        const type = interaction.options.getString('type') || 'levels';

        try {
            // The grind-track boards and the Hall of Champions are self-contained
            // (their own queries, embeds and empty-state messages) and live in
            // one module so this command's own boards stay readable. They return
            // a reply payload; the single reply and the catch below are shared.
            if (GRIND_TRACKS[type]) {
                const period = interaction.options.getString('period') === 'week' ? 'week' : 'all-time';
                return replyBoard(interaction, await buildGrindBoard(interaction, type, period));
            }
            if (type === 'champions') {
                return replyBoard(interaction, await buildChampionsHall(interaction));
            }

            let users;
            let title;
            let descriptionHeader;

            if (type === 'streaks' || type === 'streaks_longest') {
                const sortField = type === 'streaks'
                    ? { 'streak.current': -1 }
                    : { 'streak.longest': -1 };
                users = await User.find({ guildId: interaction.guild.id, ...(type === 'streaks' ? { 'streak.current': { $gt: 0 } } : {}) })
                    .select(ROW_FIELDS.streaks)
                    .sort(sortField)
                    .limit(10)
                    .lean();
                title = type === 'streaks'
                    ? '🔥 Daily Streak Leaderboard'
                    : '🏆 All-Time Streak Records';
                descriptionHeader = type === 'streaks'
                    ? 'Top 10 Active Streaks'
                    : 'Top 10 by Longest Streak Ever';
            } else if (type === 'duels') {
                users = await User.find({
                    guildId: interaction.guild.id,
                    $or: [{ duelWins: { $gt: 0 } }, { duelLosses: { $gt: 0 } }],
                })
                    .select(ROW_FIELDS.duels)
                    .sort({ duelWins: -1 })
                    .limit(10)
                    .lean();
                title = '⚔️ Duel Leaderboard';
                descriptionHeader = 'Top 10 Duelists by Win Count';
            } else if (type === 'achievements') {
                const guildSettings = await getGuildSettings(interaction.guild.id);
                if (!guildSettings?.achievements?.enabled) {
                    return interaction.reply({ content: 'Achievements are not enabled on this server.', flags: MessageFlags.Ephemeral });
                }
                users = await User.find({ guildId: interaction.guild.id, achievementsCount: { $gt: 0 } })
                    .select(ROW_FIELDS.achievements)
                    .sort({ achievementsCount: -1 })
                    .limit(10)
                    .lean();
                title = '🏅 Achievement Leaderboard';
                descriptionHeader = 'Top 10 by Total Achievements Earned';
            } else if (type === 'economy') {
                // Ranked by the same balance + bank total the rows below display,
                // and by the same total the dashboard and newspaper rank on.
                users = await topByNetWorth(User, interaction.guild.id, 10);
                title = '🏆 Leaderboard';
                descriptionHeader = 'Top 10 by Net Worth';
            } else {
                users = await User.find({ guildId: interaction.guild.id })
                    .select(ROW_FIELDS.levels)
                    .sort({ level: -1, xp: -1 })
                    .limit(10)
                    .lean();
                title = '🏆 Leaderboard';
                descriptionHeader = 'Top 10 by Level';
            }

            if (users.length === 0) {
                return interaction.reply({ content: 'No users found on the leaderboard!', flags: MessageFlags.Ephemeral });
            }

            const embed = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setTitle(`${title} — ${interaction.guild.name}`)
                .setTimestamp();

            // The picture card's rows, and the caller's own row, built alongside
            // the text from the same numbers.
            const cardEntries = [];
            let callerCard = null;

            // Find caller's rank for streak leaderboards
            let callerRankLine = '';
            if (type === 'streaks' || type === 'streaks_longest') {
                const callerUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id })
                    .select(ROW_FIELDS.streaks)
                    .lean();
                if (callerUser) {
                    const callerVal = type === 'streaks'
                        ? (callerUser.streak?.current ?? 0)
                        : (callerUser.streak?.longest ?? 0);
                    const field = type === 'streaks' ? 'streak.current' : 'streak.longest';
                    const aboveCount = await User.countDocuments({
                        guildId: interaction.guild.id,
                        [field]: { $gt: callerVal }
                    });
                    const callerRank = aboveCount + 1;
                    const topEntry = users[0];
                    const topVal = type === 'streaks'
                        ? (topEntry?.streak?.current ?? 0)
                        : (topEntry?.streak?.longest ?? 0);
                    const div = '━━━━━━━━━━━━━━━━━━━━━━━━━━━';
                    if (callerRank > 10 && topVal > 0) {
                        callerRankLine = `\n${div}\n📍 You: **#${callerRank}** — 🔥 ${callerVal} day${callerVal !== 1 ? 's' : ''}`;
                    } else if (callerRank <= 10) {
                        callerRankLine = `\n${div}\n📍 You: **#${callerRank}** — 🔥 ${callerVal} day${callerVal !== 1 ? 's' : ''}`;
                    }
                    if (callerRankLine) callerCard = { rank: callerRank, value: plural(callerVal, 'day'), score: callerVal };
                }
            }

            // One round trip per row turned rendering a ten-name board into ten
            // serial Discord API calls. Nothing in the loop below depends on the
            // previous row, so the fetches are issued together and awaited once.
            // A user the API cannot resolve still yields null and is skipped, and
            // the medal still comes from the row's rank rather than its position
            // in the printed list.
            const discordUsers = await Promise.all(
                users.map(u => interaction.client.users.fetch(u.userId).catch(() => null))
            );

            let description = descriptionHeader + '\n\n';
            for (let i = 0; i < users.length; i++) {
                const user = users[i];
                const discordUser = discordUsers[i];
                if (!discordUser) continue;

                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
                const card = {
                    rank: i + 1,
                    name: displayNameOf(discordUser) ?? discordUser.tag,
                    avatarUrl: avatarUrlOf(discordUser),
                    you: discordUser.id === interaction.user.id,
                };
                cardEntries.push(card);

                if (type === 'levels') {
                    description += `${medal} ${discordUser.tag} — Level ${user.level} (${user.xp} XP)\n`;
                    Object.assign(card, { value: `Level ${user.level}`, detail: `${(user.xp ?? 0).toLocaleString('en-US')} XP`, score: user.level });
                } else if (type === 'economy') {
                    description += `${medal} ${discordUser.tag} — ${user.netWorth.toLocaleString()} coins\n`;
                    Object.assign(card, { value: `${user.netWorth.toLocaleString('en-US')} coins`, score: user.netWorth });
                } else if (type === 'streaks') {
                    const days    = user.streak?.current ?? 0;
                    const freezes = user.streak?.freezes ?? 0;
                    const milestones = [100, 30, 7];
                    const topMilestone = milestones.find(m => days >= m);
                    const badges = [
                        topMilestone === 100 ? '⭐ 100-day milestone achieved' : topMilestone === 30 ? '⭐ 30-day milestone achieved' : topMilestone === 7 ? '⭐ 7-day milestone achieved' : null,
                        freezes > 0 ? `🧊 ${freezes} freeze${freezes !== 1 ? 's' : ''} banked` : null,
                        (user.streak?.revivalToken) ? '💫 Revival Token' : null,
                    ].filter(Boolean).join('  ');
                    description += `${medal} ${discordUser.tag} — 🔥 ${days} day${days !== 1 ? 's' : ''}${badges ? `  ${badges}` : ''}\n`;
                    const cardDetail = [
                        topMilestone ? `${topMilestone}-day milestone` : null,
                        freezes > 0 ? plural(freezes, 'freeze') + ' banked' : null,
                        user.streak?.revivalToken ? 'Revival Token' : null,
                    ].filter(Boolean).join(' · ');
                    Object.assign(card, { value: plural(days, 'day'), detail: cardDetail || null, score: days });
                } else if (type === 'streaks_longest') {
                    const days = user.streak?.longest ?? 0;
                    description += `${medal} ${discordUser.tag} — 🔥 ${days} day${days !== 1 ? 's' : ''}\n`;
                    Object.assign(card, { value: plural(days, 'day'), score: days });
                } else if (type === 'achievements') {
                    const count = user.achievementsCount ?? 0;
                    description += `${medal} ${discordUser.tag} — 🏅 ${count} achievement${count !== 1 ? 's' : ''}\n`;
                    Object.assign(card, { value: plural(count, 'achievement'), score: count });
                } else {
                    const wins   = user.duelWins   ?? 0;
                    const losses = user.duelLosses ?? 0;
                    description += `${medal} ${discordUser.tag} — ⚔️ ${wins}W / ${losses}L\n`;
                    Object.assign(card, { value: `${wins}W / ${losses}L`, score: wins });
                }
            }

            // "You are here" self-rank for types that didn't already compute it above
            if (!callerRankLine && !['streaks', 'streaks_longest'].includes(type)) {
                const callerUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id })
                    .select(CALLER_FIELDS)
                    .lean();
                if (callerUser) {
                    let callerRank, callerDisplay;
                    const div = '━━━━━━━━━━━━━━━━━━━━━━━━━━━';

                    if (type === 'levels') {
                        callerRank = await User.countDocuments({
                            guildId: interaction.guild.id,
                            $or: [
                                { level: { $gt: callerUser.level } },
                                { level: callerUser.level, xp: { $gt: callerUser.xp } },
                            ],
                        }) + 1;
                        callerDisplay = `Lv${callerUser.level} (${callerUser.xp} XP)`;
                        callerCard = { value: `Level ${callerUser.level}`, detail: `${(callerUser.xp ?? 0).toLocaleString('en-US')} XP`, score: callerUser.level };
                    } else if (type === 'economy') {
                        const callerTotal = netWorthOf(callerUser);
                        callerRank = await netWorthRank(User, interaction.guild.id, callerTotal, callerUser._id);
                        callerDisplay = `${callerTotal.toLocaleString()} coins`;
                        callerCard = { value: `${callerTotal.toLocaleString('en-US')} coins`, score: callerTotal };
                    } else if (type === 'duels') {
                        const callerWins = callerUser.duelWins ?? 0;
                        callerRank = await User.countDocuments({
                            guildId: interaction.guild.id,
                            duelWins: { $gt: callerWins },
                        }) + 1;
                        callerDisplay = `${callerWins}W / ${callerUser.duelLosses ?? 0}L`;
                        callerCard = { value: callerDisplay, score: callerWins };
                    } else if (type === 'achievements') {
                        const callerAch = callerUser.achievementsCount ?? 0;
                        callerRank = await User.countDocuments({
                            guildId: interaction.guild.id,
                            achievementsCount: { $gt: callerAch },
                        }) + 1;
                        callerDisplay = `${callerAch} achievement${callerAch !== 1 ? 's' : ''}`;
                        callerCard = { value: plural(callerAch, 'achievement'), score: callerAch };
                    }

                    if (callerRank !== undefined) {
                        callerRankLine = `\n${div}\n📍 You: **#${callerRank}** — ${callerDisplay}`;
                        if (callerCard) callerCard.rank = callerRank;
                    }
                }
            }

            embed.setDescription(description + callerRankLine);

            // The card leads, the text beneath it stays the record.
            const you = callerCard && !cardEntries.some(e => e.you)
                ? {
                    ...callerCard,
                    name: interaction.member?.displayName ?? displayNameOf(interaction.user),
                    avatarUrl: avatarUrlOf(interaction.user),
                }
                : null;
            await sendBoard(interaction, embed, {
                theme: CARD[type].theme,
                kicker: interaction.guild.name,
                title: CARD[type].title,
                subtitle: descriptionHeader,
                entries: cardEntries,
                you,
            });
        } catch (error) {
            console.error('Leaderboard error:', error);
            await sendEphemeralResponse(interaction, { content: 'Failed to fetch leaderboard.' }).catch(() => {});
        }
    }
};
