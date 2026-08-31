const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { MATERIAL_RARITY, TIER_STARS, TIER_COLORS } = require('../../data/materialRarity');
const { ACHIEVEMENTS } = require('../../data/achievements');
const COLORS = require('../../utils/embedColors');

const ACHIEVEMENT_BY_ID = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━━━━━';

// Every grind profile that keeps a material pile. `exploration` joined them
// with the fieldcraft materials from #753; leaving it out here would have made
// the "N / total materials" line unreachable by eleven, since the denominator
// counts the whole MATERIAL_RARITY catalog.
const MATERIAL_TRACKS = ['hunt', 'fishing', 'mining', 'exploration'];

function collectMaterials(user) {
    const results = [];

    for (const track of MATERIAL_TRACKS) {
        const mats = user[track]?.materials ?? {};
        for (const [key, qty] of Object.entries(mats)) {
            if (qty > 0 && MATERIAL_RARITY[key]) {
                results.push({ key, qty, ...MATERIAL_RARITY[key] });
            }
        }
    }

    results.sort((a, b) => b.tier - a.tier || b.qty - a.qty);
    return results;
}

function topAchievements(user) {
    const earned = user.achievements ?? [];
    const enriched = earned
        .map(a => ({ earned: a, def: ACHIEVEMENT_BY_ID[a.id] }))
        .filter(x => x.def);
    enriched.sort((a, b) => (b.def.xpReward ?? 0) - (a.def.xpReward ?? 0));
    return enriched.slice(0, 3);
}

function countMaterials(user) {
    let total = 0;
    for (const track of MATERIAL_TRACKS) {
        const mats = user[track]?.materials ?? {};
        for (const qty of Object.values(mats)) if (qty > 0) total++;
    }
    return total;
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('showcase')
        .setDescription("Display a player's trophy card — rarest items and top achievements.")
        .setDMPermission(false)
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
                getGuildSettings(interaction.guild.id)
            ]);

            if (!profileUser) {
                return interaction.reply({
                    content: isSelf
                        ? "You don't have a profile yet. Use some economy commands to get started!"
                        : `${target.username} doesn't have a profile in this server.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const currency = guildSettings?.economy?.currency ?? '💰';
            const allMaterials = collectMaterials(profileUser);
            const topMats = allMaterials.slice(0, 3);
            const topAchs = topAchievements(profileUser);
            const topTier = allMaterials[0]?.tier ?? 0;
            const legendaryCount = allMaterials.filter(m => m.tier === 5).length;

            // ── Empty state ──────────────────────────────────────────────────────
            const hasAnything = topAchs.length > 0 || allMaterials.length > 0;
            if (!hasAnything) {
                const emptyEmbed = new EmbedBuilder()
                    .setColor(COLORS.NEUTRAL)
                    .setTitle(`✨ Showcase — ${target.username}`)
                    .setThumbnail(target.displayAvatarURL({ dynamic: true }))
                    .setDescription(
                        'Nothing remarkable yet.\n' +
                        'Keep hunting, fishing, mining, and exploring.\n' +
                        'Your showcase fills up over time.'
                    )
                    .setTimestamp();
                return interaction.reply({ embeds: [emptyEmbed] });
            }

            // ── Top Achievements ─────────────────────────────────────────────────
            const achText = topAchs.length > 0
                ? topAchs.map(({ def }) => `${def.emoji ?? '🏅'} ${def.name}`).join('    ')
                : '*No achievements yet*';

            // ── Rarest Finds ─────────────────────────────────────────────────────
            const matsText = topMats.length > 0
                ? topMats.map(m => `${m.emoji} ${m.label} ${TIER_STARS[m.tier]}`).join('\n')
                : '*No materials collected yet*';

            // ── Stats Line ───────────────────────────────────────────────────────
            const level = profileUser.level ?? 0;
            const streak = profileUser.streak?.current ?? 0;
            const matsOwned = countMaterials(profileUser);
            const totalMatsKnown = Object.keys(MATERIAL_RARITY).length;
            const balance = (profileUser.balance ?? 0) + (profileUser.bank ?? 0);
            const achCount = profileUser.achievementsCount ?? (profileUser.achievements?.length ?? 0);

            const statsLine1 = `Level ${level}  ·  🔥 ${streak}-day streak  ·  ${matsOwned} / ${totalMatsKnown} materials`;
            const statsLine2 = `${currency} ${balance.toLocaleString()}  ·  🏅 ${achCount} achievements`;

            // ── Build description ────────────────────────────────────────────────
            const sections = [
                DIVIDER,
                '  🏆 **Top Achievements**',
                DIVIDER,
                `  ${achText}`,
                '',
                DIVIDER,
                '  💎 **Rarest Finds**',
                DIVIDER,
                `  ${matsText.split('\n').join('\n  ')}`,
                '',
                DIVIDER,
                '  📊 **Stats**',
                DIVIDER,
                `  ${statsLine1}`,
                '',
                `  ${statsLine2}`,
                DIVIDER,
            ];

            if (legendaryCount === 0) {
                sections.push('');
                sections.push('> No legendary items yet — they exist. Keep looking.');
            }

            const color = topTier > 0 ? TIER_COLORS[topTier] : '#9e9e9e';

            const embed = new EmbedBuilder()
                .setColor(color)
                .setTitle(`✨ Showcase — ${target.username}`)
                .setThumbnail(target.displayAvatarURL({ dynamic: true }))
                .setDescription(sections.join('\n'))
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        } catch (err) {
            console.error('[showcase] error:', err);
            const msg = { content: 'Something went wrong displaying the showcase.', flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) return interaction.followUp(msg);
            return interaction.reply(msg);
        }
    }
};
