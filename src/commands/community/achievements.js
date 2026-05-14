'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { ACHIEVEMENTS, CATEGORY_LABELS, CATEGORY_EMOJIS } = require('../../data/achievements');

const CATEGORY_ORDER = ['economy', 'leveling', 'hunt', 'fishing', 'community', 'moderation', 'custom'];

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
        ),

    async execute(interaction) {
        try {
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

            if (!guildSettings?.achievements?.enabled) {
                return interaction.reply({ content: 'Achievements are not enabled on this server.', ephemeral: true });
            }

            const sub = interaction.options.getSubcommand();

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

                const allDefs = [...ACHIEVEMENTS, ...customAchievements].filter(d => !disabled.has(d.id));
                const visibleDefs = allDefs.filter(d => !d.secret || earnedMap.has(d.id));

                // Group by category
                const byCategory = {};
                for (const def of allDefs) {
                    const cat = def.category || 'custom';
                    if (!byCategory[cat]) byCategory[cat] = [];
                    byCategory[cat].push(def);
                }

                const earned  = allDefs.filter(d => earnedMap.has(d.id));
                const unclaimed = earned.filter(d => {
                    const entry = earnedMap.get(d.id);
                    return entry && !entry.claimed && (d.xpReward || d.coinReward);
                });

                const embed = new EmbedBuilder()
                    .setColor(0xF1C40F)
                    .setTitle(`🏅 ${target.username}'s Achievements`)
                    .setDescription(
                        `**${earned.length}/${visibleDefs.length}** achievements earned` +
                        (unclaimed.length ? `\n> ⚠️ ${unclaimed.length} unclaimed reward(s) — use \`/achievements claim\`` : '')
                    )
                    .setThumbnail(target.displayAvatarURL());

                const FIELD_MAX = 1024;
                for (const cat of CATEGORY_ORDER) {
                    const defs = byCategory[cat];
                    if (!defs?.length) continue;

                    const lines = defs.map(def => {
                        const entry = earnedMap.get(def.id);
                        if (entry) {
                            const claimFlag = (!entry.claimed && (def.xpReward || def.coinReward)) ? ' ⚠️' : '';
                            return `${def.emoji} ~~**${def.name}**~~${claimFlag} ✅`;
                        }

                        // Secret achievements: hide everything until earned
                        if (def.secret) {
                            return `🔒 **???** — *Secret Achievement*`;
                        }

                        let progressStr = '';
                        try {
                            const [cur, max] = def.progress(user, guildSettings);
                            if (max > 1) {
                                const pct = Math.min(Math.floor((cur / max) * 10), 10);
                                const bar = '█'.repeat(pct) + '░'.repeat(10 - pct);
                                progressStr = ` \`${bar}\` ${cur.toLocaleString()}/${max.toLocaleString()}`;
                            }
                        } catch { /* skip */ }

                        return `${def.emoji} **${def.name}** — ${def.description}${progressStr}`;
                    });

                    const catLabel = `${CATEGORY_EMOJIS[cat] || '🔹'} ${CATEGORY_LABELS[cat] || cat}`;
                    // Split into ≤1024-char chunks to respect Discord field limits
                    const chunks = [];
                    let current = '';
                    for (const line of lines) {
                        const addition = current ? '\n' + line : line;
                        if (current.length + addition.length > FIELD_MAX) {
                            chunks.push(current);
                            current = line;
                        } else {
                            current += addition;
                        }
                    }
                    if (current) chunks.push(current);

                    for (let i = 0; i < chunks.length; i++) {
                        const name = i === 0 ? catLabel : `${catLabel} (cont.)`;
                        embed.addFields({ name, value: chunks[i] || 'None', inline: false });
                    }
                }

                return interaction.reply({ embeds: [embed], ephemeral: false });
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
                    return interaction.reply({ content: 'You have no unclaimed achievement rewards.', ephemeral: true });
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

                return interaction.reply({ embeds: [embed], ephemeral: true });
            }
        } catch (err) {
            console.error('[achievements] execute error:', err);
            const reply = { content: 'An error occurred while processing this command.', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(reply).catch(() => null);
            } else {
                await interaction.reply(reply).catch(() => null);
            }
        }
    }
};
