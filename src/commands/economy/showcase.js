const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { MATERIAL_RARITY, TIER_LABELS, TIER_STARS } = require('../../data/materialRarity');

const PRESTIGE_LABELS = { 0: null, 1: '🥉 Bronze', 2: '🥈 Silver', 3: '🥇 Gold', 4: '💎 Platinum', 5: '👑 Diamond' };

// Collect all materials from all three tracks into a flat list with amounts
function collectMaterials(user) {
    const results = [];
    const tracks = ['hunt', 'fishing', 'mining'];

    for (const track of tracks) {
        const mats = user[track]?.materials ?? {};
        for (const [key, qty] of Object.entries(mats)) {
            if (qty > 0 && MATERIAL_RARITY[key]) {
                results.push({ key, qty, ...MATERIAL_RARITY[key] });
            }
        }
    }

    // Sort by tier desc, then qty desc
    results.sort((a, b) => b.tier - a.tier || b.qty - a.qty);
    return results;
}

function collectTrophies(user) {
    const all = [
        ...(user.hunt?.trophies ?? []).map(t => ({ name: t, source: 'hunt' })),
        ...(user.fishing?.trophies ?? []).map(t => ({ name: t, source: 'fish' })),
        ...(user.mining?.trophies ?? []).map(t => ({ name: t, source: 'mine' }))
    ];
    return all;
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('showcase')
        .setDescription("Display a player's trophy case, rare materials, and achievements.")
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('The player to view (defaults to yourself)')
                .setRequired(false)
        ),

    async execute(interaction) {
        try {
            const target = interaction.options.getUser('user') ?? interaction.user;
            const isSelf = target.id === interaction.user.id;

            const [profileUser, guildSettings] = await Promise.all([
                User.findOne({ userId: target.id, guildId: interaction.guild.id }),
                Guild.findOne({ guildId: interaction.guild.id })
            ]);

            if (!profileUser) {
                return interaction.reply({
                    content: isSelf
                        ? "You don't have a profile yet. Use some economy commands to get started!"
                        : `${target.username} doesn't have a profile in this server.`,
                    ephemeral: true
                });
            }

            const currency = guildSettings?.economy?.currency ?? '💰';
            const allMaterials = collectMaterials(profileUser);
            const top5Mats = allMaterials.slice(0, 5);
            const trophies = collectTrophies(profileUser);

            // ── Trophy Case ──────────────────────────────────────────────────────
            let trophyText;
            if (trophies.length === 0) {
                trophyText = '*No trophies yet — go hunt some legendaries!*';
            } else {
                const shown = trophies.slice(0, 6);
                trophyText = shown.map(t => `🏆 ${t.name}`).join('  ') +
                    (trophies.length > 6 ? `\n*...and ${trophies.length - 6} more*` : '');
            }

            // ── Rarest Materials ─────────────────────────────────────────────────
            let matsText;
            if (top5Mats.length === 0) {
                matsText = '*No materials collected yet*';
            } else {
                matsText = top5Mats.map(m =>
                    `${m.emoji} **${m.label}** ×${m.qty} ${TIER_STARS[m.tier]}`
                ).join('\n');
            }

            // ── Prestige Badges ──────────────────────────────────────────────────
            const huntPrestige  = profileUser.hunt?.prestige ?? 0;
            const fishPrestige  = profileUser.fishing?.prestige ?? 0;
            const minePrestige  = profileUser.mining?.prestige ?? 0;
            const prestigeLines = [];
            if (PRESTIGE_LABELS[huntPrestige])  prestigeLines.push(`Hunt: ${PRESTIGE_LABELS[huntPrestige]}`);
            if (PRESTIGE_LABELS[fishPrestige])  prestigeLines.push(`Fish: ${PRESTIGE_LABELS[fishPrestige]}`);
            if (PRESTIGE_LABELS[minePrestige])  prestigeLines.push(`Mine: ${PRESTIGE_LABELS[minePrestige]}`);
            const prestigeText = prestigeLines.length > 0 ? prestigeLines.join('\n') : '*No prestige yet*';

            // ── Recent Achievements ──────────────────────────────────────────────
            const recentAchs = (profileUser.achievements ?? [])
                .slice()
                .sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt))
                .slice(0, 3);
            const achText = recentAchs.length > 0
                ? recentAchs.map(a => `🏅 \`${a.id}\``).join('  ')
                : '*No achievements yet*';

            // ── Lifetime Stats ───────────────────────────────────────────────────
            const totalHunts = profileUser.hunt?.totalHunts ?? 0;
            const legendaryKills = profileUser.hunt?.legendaryKills ?? 0;
            const questsDone = profileUser.questsCompleted ?? 0;
            const duelWins = profileUser.duelWins ?? 0;
            const statsText = [
                `Total Hunts: **${totalHunts.toLocaleString()}**`,
                `Legendary Kills: **${legendaryKills.toLocaleString()}**`,
                `Quests Completed: **${questsDone.toLocaleString()}**`,
                `Duel Wins: **${duelWins.toLocaleString()}**`
            ].join('   ');

            // ── Build Embed ──────────────────────────────────────────────────────
            // Pick embed color by highest rarity material tier
            const topTier = top5Mats[0]?.tier ?? 1;
            const colors = { 1: '#9e9e9e', 2: '#4caf50', 3: '#2196f3', 4: '#9c27b0', 5: '#ff9800' };
            const color = colors[topTier] ?? '#5865f2';

            const embed = new EmbedBuilder()
                .setColor(color)
                .setTitle(`${target.username}'s Showcase`)
                .setThumbnail(target.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: '🏆 Trophy Case', value: trophyText },
                    { name: '⛏️ Rarest Materials', value: matsText },
                    { name: '🎖️ Prestige Badges', value: prestigeText, inline: true },
                    { name: '🏅 Recent Achievements', value: achText, inline: true },
                    { name: '📊 Lifetime Stats', value: statsText }
                )
                .setFooter({ text: `Achievements: ${profileUser.achievementsCount ?? 0} earned` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        } catch (err) {
            console.error('[showcase] error:', err);
            const msg = { content: 'Something went wrong displaying the showcase.', ephemeral: true };
            if (interaction.replied || interaction.deferred) return interaction.followUp(msg);
            return interaction.reply(msg);
        }
    }
};
