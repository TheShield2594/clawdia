'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { ACHIEVEMENTS, CATEGORY_LABELS, CATEGORY_EMOJIS } = require('../../data/achievements');

const CATEGORY_ORDER = ['economy', 'leveling', 'hunt', 'fishing', 'exploration', 'community', 'moderation', 'custom'];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('achievements')
        .setDescription('View achievements and claim rewards')
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('Browse earned and available achievements')
                .addUserOption(opt =>
                    opt.setName('user')
                        .setDescription('View another member\'s achievements')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('claim')
                .setDescription('Claim rewards for earned achievements')
        )
        .addSubcommand(sub =>
            sub.setName('top')
                .setDescription('Show the rarest achievements in this server')
        )
        .addSubcommand(sub =>
            sub.setName('leaderboard')
                .setDescription('Show who has the most achievements in this server')
        )
        .addSubcommand(sub =>
            sub.setName('pin')
                .setDescription('Pin a featured achievement to display on your profile')
                .addStringOption(opt =>
                    opt.setName('achievement_id')
                        .setDescription('The ID of the achievement to pin (from /achievements view)')
                        .setRequired(true)
                )
        ),

    async execute(interaction) {
        try {
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

            if (!guildSettings?.achievements?.enabled) {
                return interaction.reply({ content: 'Achievements are not enabled on this server.', flags: MessageFlags.Ephemeral });
            }

            const sub = interaction.options.getSubcommand();

            if (sub === 'top')         return handleTop(interaction, guildSettings);
            if (sub === 'leaderboard') return handleLeaderboard(interaction, guildSettings);
            if (sub === 'pin')         return handlePin(interaction, guildSettings);

            if (sub === 'view') {
                const target = interaction.options.getUser('user') || interaction.user;
                let user = await User.findOne({ userId: target.id, guildId: interaction.guild.id });
                if (!user) {
                    user = await User.create({ userId: target.id, guildId: interaction.guild.id });
                }

                const disabled = new Set(guildSettings.achievements?.disabledAchievements || []);
                const earnedMap = new Map((user.achievements || []).map(a => [a.id, a]));

                const customAchievements = (guildSettings.achievements?.customAchievements || []).map(c => ({
                    id: c.id,
                    name: c.name,
                    description: c.description,
                    emoji: c.emoji || '🏆',
                    category: 'custom',
                    xpReward: c.xpReward || 0,
                    coinReward: c.coinReward || 0,
                    check: () => false,
                    progress: () => [0, 1]
                }));

                const allDefs     = [...ACHIEVEMENTS, ...customAchievements].filter(d => !disabled.has(d.id));
                const visibleDefs = allDefs.filter(d => !d.secret || earnedMap.has(d.id));

                const earned    = allDefs.filter(d => earnedMap.has(d.id));
                const unclaimed = earned.filter(d => {
                    const entry = earnedMap.get(d.id);
                    return entry && !entry.claimed && (d.xpReward || d.coinReward);
                });

                // Build ordered list of visible defs (respecting CATEGORY_ORDER)
                const orderedDefs = CATEGORY_ORDER.flatMap(cat =>
                    visibleDefs.filter(d => (d.category || 'custom') === cat)
                );

                const PAGE_SIZE   = 10;
                const totalPages  = Math.max(1, Math.ceil(orderedDefs.length / PAGE_SIZE));
                const headerDesc  = `**${earned.length}/${visibleDefs.length}** achievements earned` +
                    (unclaimed.length ? `\n> ⚠️ ${unclaimed.length} unclaimed reward(s) — use \`/achievements claim\`` : '');

                function buildPageEmbed(page) {
                    const slice = orderedDefs.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
                    const lines = slice.map(def => {
                        const entry = earnedMap.get(def.id);
                        if (entry) {
                            const claimFlag = (!entry.claimed && (def.xpReward || def.coinReward)) ? ' ⚠️' : '';
                            const earnDate  = entry.earnedAt ? ` *(${new Date(entry.earnedAt).toLocaleDateString()})* ` : ' ';
                            return `${def.emoji} ~~**${def.name}**~~${earnDate}${claimFlag}✅`;
                        }
                        if (def.secret) return `🔒 **???** — *Secret Achievement*`;

                        let progressStr = '';
                        try {
                            const [cur, max] = def.progress(user, guildSettings);
                            if (max > 1) {
                                const pct = Math.min(Math.floor((cur / max) * 10), 10);
                                const bar = '█'.repeat(pct) + '░'.repeat(10 - pct);
                                progressStr = `\n    \`${bar}\` ${cur.toLocaleString()}/${max.toLocaleString()}`;
                            }
                        } catch { /* skip */ }

                        const rewardStr = (def.coinReward || def.xpReward)
                            ? ` — 🎁 ${[def.coinReward ? `${def.coinReward.toLocaleString()} coins` : null, def.xpReward ? `${def.xpReward} XP` : null].filter(Boolean).join(' + ')}`
                            : '';
                        return `🔒 **${def.name}** — ${def.description}${rewardStr}${progressStr}`;
                    });

                    return new EmbedBuilder()
                        .setColor(0xF1C40F)
                        .setTitle(`🏅 ${target.username}'s Achievements`)
                        .setDescription(`${headerDesc}\n\n${lines.join('\n')}`)
                        .setThumbnail(target.displayAvatarURL())
                        .setFooter({ text: `Page ${page + 1}/${totalPages}` });
                }

                let currentPage = 0;
                const prevId = `ach_prev_${interaction.id}`;
                const nextId = `ach_next_${interaction.id}`;

                function buildPageRow(page) {
                    return new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(prevId).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                        new ButtonBuilder().setCustomId(nextId).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
                    );
                }

                await interaction.reply({
                    embeds: [buildPageEmbed(currentPage)],
                    components: totalPages > 1 ? [buildPageRow(currentPage)] : [],
                });

                if (totalPages > 1) {
                    const msg = await interaction.fetchReply();
                    const col = msg.createMessageComponentCollector({
                        filter: i => i.user.id === interaction.user.id && [prevId, nextId].includes(i.customId),
                        time: 120_000,
                    });
                    col.on('collect', async i => {
                        if (i.customId === prevId) currentPage = Math.max(0, currentPage - 1);
                        else currentPage = Math.min(totalPages - 1, currentPage + 1);
                        await i.update({ embeds: [buildPageEmbed(currentPage)], components: [buildPageRow(currentPage)] });
                    });
                    col.on('end', () => interaction.editReply({ components: [] }).catch(() => null));
                }
            }

            if (sub === 'claim') {
                let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
                if (!user) {
                    user = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });
                }

                const disabled = new Set(guildSettings.achievements?.disabledAchievements || []);
                const customAchievements = guildSettings.achievements?.customAchievements || [];

                const defMap = new Map();
                for (const d of ACHIEVEMENTS) defMap.set(d.id, d);
                for (const d of customAchievements) defMap.set(d.id, d);

                const unclaimed = (user.achievements || []).filter(a => !a.claimed);
                if (!unclaimed.length) {
                    return interaction.reply({ content: 'You have no unclaimed achievement rewards.', flags: MessageFlags.Ephemeral });
                }

                let totalXp = 0;
                let totalCoins = 0;
                const names = [];

                for (const entry of unclaimed) {
                    if (disabled.has(entry.id)) continue;
                    const def = defMap.get(entry.id);
                    if (!def) continue;
                    if (!def.xpReward && !def.coinReward) {
                        entry.claimed = true;
                        continue;
                    }
                    totalXp    += def.xpReward    || 0;
                    totalCoins += def.coinReward   || 0;
                    names.push(`${def.emoji} ${def.name}`);
                    entry.claimed = true;
                }

                user.xp      = (user.xp      || 0) + totalXp;
                user.balance = (user.balance  || 0) + totalCoins;
                user.markModified('achievements');
                await user.save();

                const lines = [];
                if (totalXp)    lines.push(`+${totalXp} XP`);
                if (totalCoins) lines.push(`+${totalCoins.toLocaleString()} coins`);

                const embed = new EmbedBuilder()
                    .setColor(0x2ECC71)
                    .setTitle('🎉 Rewards Claimed!')
                    .setDescription(names.join('\n') || 'No rewards.')
                    .addFields({ name: 'Total rewards', value: lines.join(' · ') || 'None', inline: false });

                return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }
        } catch (err) {
            console.error('[achievements] execute error:', err);
            const reply = { content: 'An error occurred while processing this command.', flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(reply).catch(() => null);
            } else {
                await interaction.reply(reply).catch(() => null);
            }
        }
    }
};

async function handleTop(interaction, guildSettings) {
    const disabled = new Set(guildSettings.achievements?.disabledAchievements || []);
    const allDefs  = ACHIEVEMENTS.filter(d => !disabled.has(d.id) && !d.secret);

    // Count holders for each achievement in this guild
    const holderCounts = await Promise.all(
        allDefs.map(async def => {
            const count = await User.countDocuments({ guildId: interaction.guild.id, 'achievements.id': def.id });
            return { def, count };
        })
    );

    const sorted = holderCounts
        .filter(({ count }) => count > 0)
        .sort((a, b) => a.count - b.count)
        .slice(0, 10);

    if (!sorted.length) {
        return interaction.reply({ content: 'No achievements have been earned yet in this server.', flags: MessageFlags.Ephemeral });
    }

    const lines = sorted.map(({ def, count }) => {
        return `${def.emoji} **${def.name}** — **${count}** holder${count !== 1 ? 's' : ''}`;
    });

    const embed = new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🏆 Rarest Achievements in This Server')
        .setDescription('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' + lines.join('\n'))
        .setFooter({ text: 'Sorted by fewest holders' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function handleLeaderboard(interaction, guildSettings) {
    const topUsers = await User.find(
        { guildId: interaction.guild.id, achievementsCount: { $gt: 0 } },
        'userId achievementsCount'
    ).sort({ achievementsCount: -1 }).limit(10).lean();

    if (!topUsers.length) {
        return interaction.reply({ content: 'No achievements have been earned yet in this server.', flags: MessageFlags.Ephemeral });
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines  = topUsers.map((u, i) => {
        const medal = medals[i] ?? `**${i + 1}.**`;
        return `${medal} <@${u.userId}> — **${u.achievementsCount}** achievements`;
    });

    const embed = new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🏅 Achievement Leaderboard')
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Most achievements earned in this server' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function handlePin(interaction, guildSettings) {
    const achievementId = interaction.options.getString('achievement_id');
    const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });

    if (!user) {
        return interaction.reply({ content: 'You have no achievements yet.', flags: MessageFlags.Ephemeral });
    }

    const earned = (user.achievements || []).find(a => a.id === achievementId);
    if (!earned) {
        return interaction.reply({ content: `You haven't earned achievement \`${achievementId}\` yet.`, flags: MessageFlags.Ephemeral });
    }

    const disabled = new Set(guildSettings.achievements?.disabledAchievements || []);
    if (disabled.has(achievementId)) {
        return interaction.reply({ content: 'That achievement is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const def = ACHIEVEMENTS.find(d => d.id === achievementId);
    if (!def) {
        return interaction.reply({ content: `Achievement \`${achievementId}\` not found.`, flags: MessageFlags.Ephemeral });
    }

    await User.updateOne(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $set: { pinnedAchievement: achievementId } }
    );

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle('📌 Featured Achievement Set!')
            .setDescription(`${def.emoji} **${def.name}** — ${def.description}\n\nThis achievement will now be displayed prominently on your profile.`)
        ],
        flags: MessageFlags.Ephemeral,
    });
}
