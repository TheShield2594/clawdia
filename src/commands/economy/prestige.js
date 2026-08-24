const {
    SlashCommandBuilder, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType,
    MessageFlags,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const COLORS = require('../../utils/embedColors');
const {
    PRESTIGE_TIERS, UNLOCK_LABELS, tierFor, titleForExactRank, nextTierAfter, badgeFor,
} = require('../../utils/prestige');

const CONFIRM_TIMEOUT_MS = 30_000;

async function postAnnouncement(client, guildId, channelId, payload) {
    if (!channelId) return;
    try {
        const g = await client.guilds.fetch(guildId).catch(() => null);
        if (!g) return;
        const ch = await g.channels.fetch(channelId).catch(() => null);
        if (!ch?.isTextBased?.()) return;
        await ch.send(payload).catch(() => {});
    } catch (err) {
        console.error(`[prestige] announce failed:`, err.message);
    }
}

function bonusSummary(bonuses) {
    const parts = [];
    if (bonuses.yieldPct)        parts.push(`+${Math.round(bonuses.yieldPct * 100)}% all yields`);
    if (bonuses.xpPct)           parts.push(`+${Math.round(bonuses.xpPct * 100)}% XP gain`);
    if (bonuses.staminaRegenPct) parts.push(`+${Math.round(bonuses.staminaRegenPct * 100)}% stamina regen`);
    if (bonuses.crimeSuccessPct) parts.push(`+${Math.round(bonuses.crimeSuccessPct * 100)}% crime success`);
    return parts.length ? parts.join(' · ') : '—';
}

function describeTier(tier) {
    const title  = tier.title || `Rank ${tier.rank}`;
    const bonus  = bonusSummary(tier.bonuses || {});
    const unlock = (tier.unlocks?.length)
        ? tier.unlocks.map(u => UNLOCK_LABELS[u] || u).join('\n  • ')
        : 'None';
    return `**P${tier.rank} — ${title}**\n  • Bonuses: ${bonus}\n  • Unlocks:\n  • ${unlock}`;
}

async function handleStatus(interaction) {
    const target = interaction.options.getUser('user') || interaction.user;
    const userDoc = await User.findOne(
        { userId: target.id, guildId: interaction.guild.id },
        'level xp accountPrestige'
    ).lean();

    const rank = userDoc?.accountPrestige?.rank ?? 0;
    const tier = tierFor(rank);
    const next = nextTierAfter(rank);
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id }, 'accountPrestige').lean();
    const minLevel = guildSettings?.accountPrestige?.minLevelToPrestige ?? 50;

    const unlocks = tier.unlocks?.length
        ? tier.unlocks.map(u => `• ${UNLOCK_LABELS[u] || u}`).join('\n')
        : '_None yet — reach Prestige I to unlock the Black Market._';

    const exactTitle = titleForExactRank(rank);
    const embed = new EmbedBuilder()
        .setColor(rank >= 5 ? '#f1c40f' : '#9b59b6')
        .setTitle(`${badgeFor(rank) || '⟦P0⟧'} ${target.username} — ${exactTitle || 'No prestige yet'}`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .setDescription(
            `Current level: **${userDoc?.level ?? 0}** · Prestige rank: **${rank}**\n` +
            (rank > 0 ? `Active bonuses: ${bonusSummary(tier.bonuses || {})}` : '_No bonuses active yet._')
        )
        .addFields(
            { name: 'Unlocks', value: unlocks, inline: false },
            { name: `Next rank (P${next.rank} — ${next.title})`,
              value: `Bonuses: ${bonusSummary(next.bonuses || {})}\nRequires: level **${minLevel}** (resets to 0 on prestige)`,
              inline: false },
        )
        .setFooter({ text: 'Use /prestige up when ready to ascend. Use /prestige info to see all tiers.' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function handleInfo(interaction) {
    const lines = PRESTIGE_TIERS.filter(t => t.rank > 0).map(describeTier).join('\n\n');
    const embed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle('✨ Prestige Tiers')
        .setDescription(lines)
        .setFooter({ text: 'Each prestige resets your level to 0 but grants permanent bonuses and exclusive content.' })
        .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleUp(interaction) {
    const guildId = interaction.guild.id;
    const guildSettings = await Guild.findOne({ guildId }, 'accountPrestige economy').lean();

    if (guildSettings?.accountPrestige?.enabled === false) {
        return interaction.reply({ content: 'Account prestige is disabled on this server.', flags: MessageFlags.Ephemeral });
    }
    const minLevel = guildSettings?.accountPrestige?.minLevelToPrestige ?? 50;

    const userDoc = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId },
        { $setOnInsert: { userId: interaction.user.id, guildId } },
        { upsert: true, new: true }
    );

    if ((userDoc.level ?? 0) < minLevel) {
        return interaction.reply({
            content: `You need to reach **level ${minLevel}** before you can prestige. (You're level ${userDoc.level ?? 0}.)`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const oldRank  = userDoc.accountPrestige?.rank ?? 0;
    const newRank  = oldRank + 1;
    const newTier  = nextTierAfter(oldRank);
    const newUnlocks = newTier.unlocks ?? [];

    // Confirmation prompt — prestige is irreversible.
    const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle('✨ Confirm Prestige')
        .setDescription(
            `You're about to **prestige to ${newTier.title || `Rank ${newRank}`}**.\n\n` +
            `This will:\n` +
            `• Reset your level and XP to **0**\n` +
            `• Grant permanent bonuses: **${bonusSummary(newTier.bonuses || {})}**\n` +
            `• Unlock: ${(newUnlocks.filter(u => !(tierFor(oldRank).unlocks || []).includes(u)).map(u => UNLOCK_LABELS[u] || u).join(', ')) || 'no new unlocks at this tier'}\n\n` +
            `This **cannot be undone**.`
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prestige_confirm').setLabel('Ascend').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('prestige_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );

    const msg = await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true });

    const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: i => i.user.id === interaction.user.id,
        time: CONFIRM_TIMEOUT_MS,
        max: 1,
    });

    collector.on('collect', async btn => {
        if (btn.customId === 'prestige_cancel') {
            return btn.update({ content: 'Prestige cancelled.', embeds: [], components: [] });
        }
        await btn.deferUpdate();

        // Atomically apply prestige: increment rank, reset level/xp, set unlocks, stamp prestigedAt.
        // Guard with rank match so concurrent runs only succeed once.
        // Treat a missing accountPrestige.rank field as 0 so legacy users (created
        // before the schema introduced this subdoc) can prestige without a
        // pre-migration. $expr + $ifNull normalizes the comparison at the DB.
        const updated = await User.findOneAndUpdate(
            {
                userId: interaction.user.id,
                guildId,
                level: { $gte: minLevel },
                $expr: { $eq: [{ $ifNull: ['$accountPrestige.rank', 0] }, oldRank] },
            },
            {
                $inc: { 'accountPrestige.rank': 1, 'accountPrestige.lifetimePrestigeXp': userDoc.xp ?? 0 },
                $set: {
                    level: 0,
                    xp:    0,
                    'accountPrestige.prestigedAt': new Date(),
                    'accountPrestige.unlocks':     newUnlocks,
                },
            },
            { new: true }
        );

        if (!updated) {
            return interaction.editReply({ content: 'Could not complete prestige — your level may have changed. Try again.', embeds: [], components: [] });
        }

        // Public reset ceremony — only announce if rank exceeds previous announced peak.
        const announcedRank = updated.accountPrestige.announcedRank ?? 0;
        const announceChannelId = guildSettings?.accountPrestige?.announceChannelId
            ?? guildSettings?.economy?.announcementChannelId
            ?? null;
        if (newRank > announcedRank && announceChannelId) {
            const ceremony = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setTitle('✨ A New Ascension')
                .setDescription(
                    `<@${interaction.user.id}> has ascended to **${newTier.title || `Rank ${newRank}`}** ` +
                    `${badgeFor(newRank)}\n\n` +
                    `**Unlocks this tier:** ${newUnlocks.map(u => UNLOCK_LABELS[u] || u).join(' · ') || '—'}\n` +
                    `**Permanent bonuses:** ${bonusSummary(newTier.bonuses || {})}`
                )
                .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                .setTimestamp();
            await postAnnouncement(interaction.client, guildId, announceChannelId, { embeds: [ceremony] });
            await User.updateOne(
                { userId: interaction.user.id, guildId },
                { $set: { 'accountPrestige.announcedRank': newRank } }
            ).catch(() => {});
        }

        // Optional elite role
        const eliteRoleId = guildSettings?.accountPrestige?.eliteRoleId;
        const eliteMin    = guildSettings?.accountPrestige?.eliteRoleMinRank ?? 5;
        if (eliteRoleId && newRank >= eliteMin) {
            await interaction.member.roles.add(eliteRoleId).catch(() => {});
        }

        const doneEmbed = new EmbedBuilder()
            .setColor(COLORS.PRIZE)
            .setTitle(`${badgeFor(newRank)} Welcome to ${newTier.title || `Rank ${newRank}`}`)
            .setDescription(
                `Your level has been reset, but you carry forward:\n\n` +
                `• **Bonuses:** ${bonusSummary(newTier.bonuses || {})}\n` +
                `• **Unlocks:** ${newUnlocks.map(u => UNLOCK_LABELS[u] || u).join(', ') || '—'}\n\n` +
                `The climb starts again — at a new altitude.`
            );

        return interaction.editReply({ embeds: [doneEmbed], components: [] });
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            interaction.editReply({ content: 'Prestige confirmation timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('prestige')
        .setDescription('Account-level prestige — reset your level for permanent rewards and unlocks.')
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription("Show your (or someone else's) prestige rank, bonuses, and unlocks.")
                .addUserOption(o => o.setName('user').setDescription('User to inspect (defaults to yourself).').setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('info')
                .setDescription('Show every prestige tier and what each one unlocks.'))
        .addSubcommand(sub =>
            sub.setName('up')
                .setDescription('Prestige your account (requires the server-configured level threshold).')),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }
        const sub = interaction.options.getSubcommand();
        if (sub === 'status') return handleStatus(interaction);
        if (sub === 'info')   return handleInfo(interaction);
        if (sub === 'up')     return handleUp(interaction);
    },
};
