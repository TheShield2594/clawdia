const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const { attachGrind } = require('../../utils/grindProfile');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { createRankCard } = require('../../utils/cardGenerator');
const { pruneEffects, EFFECT_CONFIGS, timeRemaining, getServerCoinMultiplier, getServerXpMultiplier } = require('../../services/effectsService');
const { badgeFor, titleForExactRank: prestigeTitle } = require('../../utils/prestige');
const { tierFor: eloTierFor, START_ELO } = require('../../utils/duelElo');
const COLORS = require('../../utils/embedColors');

const BOOSTER_TYPES  = new Set(['coin_booster_2x', 'xp_booster_2x', 'lucky_streak', 'salary_raise']);
const BOOST_TYPES    = new Set(['coin_booster_2x', 'xp_booster_2x']);

// Best rarity rank for Epic+ materials pulled from hunt/fish/mine (simplified)
const MATERIAL_RARITY_RANK = { epic: 3, legendary: 4, mythic: 5 };
function getRarestCatch(userData) {
    const candidates = [];
    const checkMaterials = mats => {
        if (!Array.isArray(mats)) return;
        for (const m of mats) {
            if (!m.itemId && !m.id) continue;
            const rank = MATERIAL_RARITY_RANK[m.rarity?.toLowerCase()];
            if (rank) candidates.push({ rank, name: m.name || m.itemId || m.id });
        }
    };
    checkMaterials(userData.hunt?.materials);
    checkMaterials(userData.fishing?.materials);
    checkMaterials(userData.mining?.materials);
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.rank - a.rank);
    return candidates[0].name;
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('rank')
        .setDescription('View a rank card, or the server’s XP settings.')
        // `/xpinfo` folded in here as `/rank info` (#1022): where XP is earned
        // belongs next to the card that shows the XP, not beside it as its own
        // top-level command.
        .addSubcommand(sub => sub
            .setName('card')
            .setDescription('View your rank card showing level, XP, and server position.')
            .addUserOption(option => option
                .setName('user')
                .setDescription('User whose rank to display (defaults to yourself).')
                .setRequired(false)))
        .addSubcommand(sub => sub
            .setName('info')
            .setDescription('See which channels and roles are excluded from XP gain in this server.')),
    async execute(interaction) {
        if (interaction.options.getSubcommand() === 'info') {
            return showXpInfo(interaction);
        }

        const targetUser = interaction.options.getUser('user') || interaction.user;

        try {
            const [user, guildSettings] = await Promise.all([
                User.findOne({ userId: targetUser.id, guildId: interaction.guild.id }),
                getGuildSettings(interaction.guild.id),
            ]);
            await attachGrind(user);

            if (!user) {
                return interaction.reply({ content: `${targetUser.username} hasn't earned any XP yet!`, flags: MessageFlags.Ephemeral });
            }

            pruneEffects(user);

            // Count users ranked above this user instead of fetching the full collection
            const rank = await User.countDocuments({
                guildId: interaction.guild.id,
                $or: [
                    { level: { $gt: user.level } },
                    { level: user.level, xp: { $gt: user.xp } },
                ],
            }) + 1;
            const requiredXp = user.level * 100 + 100;

            const activeBoosters  = (user.activeEffects || []).filter(e => BOOSTER_TYPES.has(e.type));
            const hasActiveBoost  = activeBoosters.some(e => BOOST_TYPES.has(e.type));
            const streakCurrent   = user.streak?.current ?? 0;
            const rarestCatch     = getRarestCatch(user);

            const card       = await createRankCard(targetUser, user, rank, requiredXp, { streakCurrent, hasActiveBoost, rarestCatch });
            const attachment = new AttachmentBuilder(card, {
                name: 'rank.png',
                description:
                    `Rank card for ${targetUser.username}: level ${user.level}, ` +
                    `${user.xp.toLocaleString()} of ${requiredXp.toLocaleString()} XP ` +
                    `towards level ${user.level + 1}, ranked #${rank} in the server.`,
            });

            const serverCoinMult = getServerCoinMultiplier(guildSettings);
            const serverXpMult   = getServerXpMultiplier(guildSettings);
            const sb = guildSettings?.serverBoost;
            const hasServerBoost = (serverCoinMult > 1.0 || serverXpMult > 1.0) && sb?.expiresAt;

            const hasExclusions = (guildSettings?.leveling?.noXpChannelIds?.length > 0) ||
                                  (guildSettings?.leveling?.noXpRoleIds?.length > 0);
            const xpHint = hasExclusions
                ? '💡 Some channels or roles may not earn XP. Use /rank info to see details.'
                : null;

            // Prestige + ranked summary lines (appended to whichever embed we send)
            const prestigeRank = user.accountPrestige?.rank ?? 0;
            const eloVal       = user.ranked?.elo ?? START_ELO;
            const eloTier      = eloTierFor(eloVal);
            const showRanked   = (user.ranked?.rankedWins ?? 0) + (user.ranked?.rankedLosses ?? 0) > 0;
            const identityField = (() => {
                const parts = [];
                if (prestigeRank > 0) {
                    parts.push(`${badgeFor(prestigeRank)} **${prestigeTitle(prestigeRank)}**`);
                }
                if (showRanked) {
                    parts.push(`${eloTier.icon} **${eloTier.label}** (${eloVal} ELO)`);
                }
                if (!parts.length) return null;
                return { name: '🪪 Identity', value: parts.join('\n'), inline: false };
            })();

            const boosterLines = [];
            if (hasServerBoost) {
                const boostType = sb.type === 'coin' ? `💰 ${serverCoinMult}x Coins` : `⭐ ${serverXpMult}x XP`;
                boosterLines.push(`🌐 **Server Boost** — ${boostType} (${timeRemaining(sb.expiresAt)} remaining)`);
            }
            for (const e of activeBoosters) {
                const cfg = EFFECT_CONFIGS[e.type];
                if (!cfg) continue;
                boosterLines.push(`${cfg.emoji} **${cfg.label}** — ${timeRemaining(e.expiresAt)}`);
            }

            // #672. The three numbers this command exists to report — level, XP
            // and position — used to live only on the PNG, and in the common
            // case (no boosters, no prestige, no excluded channels) the reply
            // was the PNG and nothing else. Anyone reading the message through
            // a screen reader, or on a client that failed to load the image,
            // got a rank card with no rank on it. So the embed is unconditional
            // now and carries the numbers; the card illustrates them.
            const rankEmbed = new EmbedBuilder()
                .setColor(boosterLines.length ? COLORS.WARN : identityField ? COLORS.RARE : COLORS.NEUTRAL)
                .setAuthor({ name: `${targetUser.username} — rank #${rank}`, iconURL: targetUser.displayAvatarURL() })
                .addFields(
                    { name: '📊 Level', value: `${user.level}`, inline: true },
                    { name: '⭐ XP', value: `${user.xp.toLocaleString()} / ${requiredXp.toLocaleString()}`, inline: true },
                    { name: '🏆 Server rank', value: `#${rank}`, inline: true },
                );
            if (boosterLines.length) {
                rankEmbed.addFields({ name: '🚀 Active Boosters', value: boosterLines.join('\n'), inline: false });
            }
            if (identityField) rankEmbed.addFields(identityField);
            if (xpHint) rankEmbed.setFooter({ text: xpHint });

            await interaction.reply({ files: [attachment], embeds: [rankEmbed] });
        } catch (error) {
            console.error('Rank error:', error);
            await interaction.reply({ content: 'Failed to fetch rank.', flags: MessageFlags.Ephemeral });
        }
    }
};

// ── /rank info (was /xpinfo) ─────────────────────────────────────────────────

const XP_COOLDOWN_SECONDS = 60;
const FIELD_LIMIT = 1024;

// A comma-joined mention list that never overruns an embed field: once adding
// the next mention would push past the 1024-char field limit, the rest are
// summarised as "… and N more" rather than truncated mid-mention.
function truncateMentionList(ids, format) {
    const items = [];
    let length = 0;
    for (let i = 0; i < ids.length; i++) {
        const mention = format(ids[i]);
        const separator = items.length > 0 ? ', ' : '';
        const added = separator.length + mention.length;
        const remaining = ids.length - i;
        const suffix = `, … and ${remaining} more`;
        if (length + added + (remaining > 1 ? suffix.length : 0) > FIELD_LIMIT) {
            items.push(`… and ${remaining} more`);
            break;
        }
        items.push(mention);
        length += added;
    }
    return items.length > 0 ? items.join(', ') : 'None';
}

async function showXpInfo(interaction) {
    if (!interaction.inGuild()) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        const guildSettings = await getGuildSettings(interaction.guild.id);
        const leveling = guildSettings?.leveling ?? {};

        const xpRate = leveling.xpRate ?? 1.0;
        const voiceEnabled = leveling.voiceXpEnabled ?? false;
        const excludedChannelIds = leveling.noXpChannelIds ?? [];
        const excludedRoleIds = leveling.noXpRoleIds ?? [];

        const channelMentions = truncateMentionList(excludedChannelIds, id => `<#${id}>`);
        const roleMentions = truncateMentionList(excludedRoleIds, id => `<@&${id}>`);

        const xpRateLabel = xpRate === 1.0 ? `${xpRate}x (default)` : `${xpRate}x`;

        const hasExclusions = excludedChannelIds.length > 0 || excludedRoleIds.length > 0;
        const statusLine = hasExclusions
            ? 'Some channels or roles may limit your XP gain — see above.'
            : 'You are currently earning XP normally.';

        const embed = new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle(`📊 XP Settings for ${interaction.guild.name}`)
            .addFields(
                { name: 'XP Rate', value: xpRateLabel, inline: true },
                { name: 'Cooldown', value: `${XP_COOLDOWN_SECONDS} seconds`, inline: true },
                { name: 'Voice XP', value: voiceEnabled ? 'Enabled' : 'Disabled', inline: true },
                { name: '🚫 XP-Excluded Channels', value: channelMentions, inline: false },
                { name: '🚫 XP-Excluded Roles', value: roleMentions, inline: false }
            )
            .setFooter({ text: statusLine });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('XP info error:', error);
        await interaction.editReply({ content: 'Failed to fetch XP settings.' });
    }
}
