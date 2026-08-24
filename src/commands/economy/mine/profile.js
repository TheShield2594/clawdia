'use strict';

// /mine profile and /mine prestige: what the miner has and what they have
// become.

const Guild = require('../../../models/Guild');
const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const {
    ensureMineData,
    getLevelData,
    applyStaminaRegen,
    xpToNextLevel,
    getMaxStamina,
    msUntilNextStamina,
    formatMs
} = require('../../../services/mineService');
const { PRESTIGE_BONUSES, MINER_LEVELS, DEPTHS, LIMITS } = require('../../../data/mineData');
const { getActiveSynergies } = require('../../../services/synergyService');
const GrindProfile = require('../../../models/GrindProfile');
const { MAX_MINER_LEVEL, MAX_MINE_PRESTIGE, PRESTIGE_BADGES } = require('./shared');
const { buildXpBar, prestigeBonusLines } = require('./embeds');
const COLORS = require('../../../utils/embedColors');

async function handlePrestige(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureMineData(user);

    const m        = user.mining;
    const prestige = m.prestige ?? 0;
    const badge    = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';

    if (prestige >= MAX_MINE_PRESTIGE) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor(COLORS.WARN)
                .setTitle(`${badge} Maximum Prestige`)
                .setDescription(`You are a **P${prestige} Master Miner** — the deepest rank there is.`)
                .addFields({ name: 'Your Bonuses', value: prestigeBonusLines(PRESTIGE_BONUSES[prestige]).join('\n') || 'None' })
                .setTimestamp()],
        });
    }

    const nextBonus = PRESTIGE_BONUSES[prestige + 1];
    const nextBadge = PRESTIGE_BADGES[prestige + 1] ?? '';

    if (m.level < MAX_MINER_LEVEL) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle(`${badge} Miner Prestige — P${prestige}`)
                .setDescription(
                    `Reach **Miner Level ${MAX_MINER_LEVEL}** to ascend to ${nextBadge} **P${prestige + 1}**.\n` +
                    `You're Level **${m.level}**.`
                )
                .addFields(
                    { name: `${nextBadge} P${prestige + 1} would grant`, value: prestigeBonusLines(nextBonus).join('\n') || 'Nothing new', inline: true },
                    { name: 'Progress',  value: `${m.xp.toLocaleString()} / ${MINER_LEVELS[MAX_MINER_LEVEL - 1].xpRequired.toLocaleString()} XP`, inline: true },
                )
                .setFooter({ text: 'Prestige keeps your pickaxes, depths, materials and stats — only Miner Level and XP reset.' })
                .setTimestamp()],
            flags: MessageFlags.Ephemeral,
        });
    }

    // Losing the level also drops any synergy gated on it, so say so up front rather
    // than letting a miner discover their stamina pool shrank after ascending.
    const lostSynergies = getActiveSynergies(user)
        .filter(syn => (syn.requirements.mining ?? 0) > 1)
        .map(syn => `${syn.emoji} ${syn.name}`);

    const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`${nextBadge} Ascend to Prestige ${prestige + 1}?`)
        .setDescription(
            `You've reached **Miner Level ${MAX_MINER_LEVEL}**. Ascending is permanent and cannot be undone.\n\n` +
            `**Resets:** Miner Level → 1, Miner XP → 0\n` +
            `**Keeps:** pickaxes, unlocked depths, materials, consumables, charges and every lifetime stat`
        )
        .addFields({ name: `${nextBadge} P${prestige + 1} bonuses`, value: prestigeBonusLines(nextBonus).join('\n') || 'Nothing new', inline: false });

    if (lostSynergies.length) {
        confirmEmbed.addFields({
            name: '⚠️ Synergies you will drop until you re-level',
            value: lostSynergies.join('\n'),
            inline: false,
        });
    }
    confirmEmbed.setFooter({ text: 'Confirmation expires in 30 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mineprestige_confirm').setLabel('Ascend').setStyle(ButtonStyle.Success).setEmoji('⛏️'),
        new ButtonBuilder().setCustomId('mineprestige_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const response = await interaction.reply({ embeds: [confirmEmbed], components: [row], withResponse: true });
    const reply = response.resource.message;
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    let actionPromise = null;
    collector.on('collect', btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }

        if (btn.customId === 'mineprestige_cancel') {
            collector.stop();
            return btn.update({ content: 'Ascension cancelled.', embeds: [], components: [] });
        }

        // Assigned before collector.stop(): stop() emits 'end' synchronously, so an
        // assignment after it would leave the handler below awaiting a null and let
        // the command — and the per-user mining lock with it — resolve while this
        // write was still in flight.
        actionPromise = (async () => {
            try {
                await btn.deferUpdate();

                // Nothing is written from the in-memory snapshot here. It was read
                // before a 30-second confirmation window during which a raid, a craft
                // or another dig may have moved this profile, and a save() would put
                // all of that back. The ascension is the conditional update alone.
                //
                // `data.prestige` is absent on profiles that predate the field, so a
                // first ascension has to match that shape too — ensureMineData only
                // defaulted it in memory.
                const rankMatches = prestige === 0
                    ? [{ 'data.prestige': 0 }, { 'data.prestige': { $exists: false } }, { 'data.prestige': null }]
                    : [{ 'data.prestige': prestige }];

                // Conditional so a second confirmation cannot ascend twice: the level
                // requirement and the prestige rank both have to still hold.
                const ascended = await GrindProfile.findOneAndUpdate(
                    {
                        userId: user.userId, guildId: user.guildId, system: 'mining',
                        'data.level': { $gte: MAX_MINER_LEVEL },
                        $or: rankMatches,
                    },
                    { $set: { 'data.prestige': prestige + 1, 'data.level': 1, 'data.xp': 0 } },
                    { new: true }
                ).catch(err => { console.error('[mine prestige] ascend error:', err); return null; });

                if (!ascended) {
                    return interaction.editReply({
                        content: 'Your miner changed while that confirmation was open — run `/mine prestige` again.',
                        embeds: [], components: [],
                    });
                }

                m.prestige = prestige + 1;
                m.level    = 1;
                m.xp       = 0;

                const embed = new EmbedBuilder()
                    .setColor(COLORS.WARN)
                    .setTitle(`${nextBadge} Prestige ${prestige + 1} — ${getLevelData(1).title} Again`)
                    .setDescription(
                        `You climb back to the surface, hand in your papers, and start over as a **P${prestige + 1}** miner.\n` +
                        `The tunnels remember you — everything you own came back up with you.`
                    )
                    .addFields(
                        { name: 'Permanent Bonuses', value: prestigeBonusLines(PRESTIGE_BONUSES[prestige + 1]).join('\n') || 'None', inline: true },
                        { name: 'Miner Level',       value: `**${MAX_MINER_LEVEL}** → **1**`, inline: true },
                        { name: 'Kept',              value: `${m.pickaxes.length} pickaxe(s) · ${m.unlockedDepths.length} depth(s)`, inline: true },
                    )
                    .setFooter({ text: prestige + 1 >= MAX_MINE_PRESTIGE
                        ? 'That is the deepest rank there is.'
                        : `Reach Miner Level ${MAX_MINER_LEVEL} again to ascend to P${prestige + 2}.` })
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed], components: [] });
            } catch (err) {
                console.error('[mine prestige] error:', err);
                interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
            }
        })();

        collector.stop();
    });

    return new Promise(resolve => {
        collector.on('end', async (_, reason) => {
            if (reason === 'time') {
                interaction.editReply({ content: 'Ascension timed out.', embeds: [], components: [] }).catch(() => {});
            }
            if (actionPromise) await actionPromise.catch(() => {});
            resolve();
        });
    });
}

// ─── PROFILE ──────────────────────────────────────────────────────────────────

async function handleProfile(interaction) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const isSelf = target.id === interaction.user.id;

    const [userData, guildSettings] = await Promise.all([
        User.findOne({ userId: target.id, guildId: interaction.guild.id }),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);
    await attachGrind(userData);

    const currency = guildSettings?.economy?.currency ?? '💰';

    if (!userData) {
        return interaction.reply({
            content: isSelf
                ? "You haven't started mining yet! Buy a pickaxe with `/mine shop pickaxe` and use `/mine dig` to begin."
                : `${target.username} hasn't started mining yet.`,
            flags: MessageFlags.Ephemeral
        });
    }

    ensureMineData(userData);
    if (isSelf) applyStaminaRegen(userData);

    const m         = userData.mining;
    const levelData = getLevelData(m.level);
    const toNext    = xpToNextLevel(m.level, m.xp);
    const maxStam   = getMaxStamina(userData);
    const regenMs   = msUntilNextStamina(userData);
    const depth     = DEPTHS[m.activeDepth];
    const prestige  = m.prestige ?? 0;
    const badge     = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';

    const successRate = m.totalMines > 0
        ? `${Math.round((m.successfulMines / m.totalMines) * 100)}%`
        : 'N/A';

    const xpProgressBar = buildXpBar(m, toNext);
    const stamBar = '⚡'.repeat(m.stamina) + '▪️'.repeat(Math.max(0, maxStam - m.stamina));

    const buffs = [];
    if (m.activeMagnet)   buffs.push(`Magnet (${m.activeMagnetMinesLeft} mines)`);
    if (m.activeLamp)     buffs.push(`Lamp (${m.activeLampMinesLeft} mines)`);
    if (m.activeInstinct) buffs.push('Instinct (queued)');
    if (m.activeXpScroll) buffs.push('XP Scroll (queued)');

    const pBonus = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)];

    const embed = new EmbedBuilder()
        .setColor(prestige >= 4 ? '#f39c12' : prestige >= 2 ? '#95a5a6' : '#b5651d')
        .setTitle(`${badge} ${target.username}'s Miner Profile`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
            {
                name: '⛏️ Rank',
                value: `**${levelData.title}** (Level ${m.level})${prestige > 0 ? `\nPrestige ${badge} P${prestige}` : ''}`,
                inline: true
            },
            {
                name: '⭐ Miner XP',
                value: toNext !== null
                    ? `${m.xp.toLocaleString()} / ${MINER_LEVELS[m.level]?.xpRequired?.toLocaleString() ?? '?'} XP\n${xpProgressBar}\n${toNext.toLocaleString()} to Level ${m.level + 1}`
                    : `${m.xp.toLocaleString()} XP — **MAX LEVEL**`,
                inline: true
            },
            {
                name: '🗺️ Active Depth',
                value: depth ? `${depth.emoji} ${depth.name}` : 'Unknown',
                inline: true
            },
            {
                name: '⚡ Stamina',
                value: `${stamBar}\n${m.stamina}/${maxStam}${m.stamina < maxStam ? `\nNext regen: ${formatMs(regenMs)}` : '\nFull!'}`,
                inline: true
            },
            {
                name: '💰 Balance',
                value: `${currency}${userData.balance.toLocaleString()}`,
                inline: true
            },
            {
                name: '🔋 Active Buffs',
                value: buffs.length ? buffs.join('\n') : 'None',
                inline: true
            },
            {
                name: '📊 Mining Stats',
                value: [
                    `Total Mines:     **${m.totalMines.toLocaleString()}**`,
                    `Success Rate:    **${successRate}**`,
                    `Total Earned:    **${currency}${m.totalEarned.toLocaleString()}**`,
                    `Best Payout:     **${currency}${m.bestPayout.toLocaleString()}**`,
                    `Legendary Finds: **${m.legendaryFinds}**`,
                    `Event Finds:     **${m.eventFinds}**`
                ].join('\n'),
                inline: false
            }
        );

    if (prestige > 0) {
        embed.addFields({
            name: `${badge} Prestige Bonuses`,
            value: prestigeBonusLines(pBonus).join('\n') || 'None yet',
            inline: true
        });
    }

    const depthList = m.unlockedDepths.map(id => {
        const d = DEPTHS[id];
        return d ? `${d.emoji} ${d.name}` : id;
    }).join('\n');
    embed.addFields({ name: '🗺️ Unlocked Depths', value: depthList || 'Surface Quarry only', inline: true });

    // Cross-system synergies
    const activeSynergies = getActiveSynergies(userData);
    if (activeSynergies.length > 0) {
        embed.addFields({
            name: '🔗 Active Synergies',
            value: activeSynergies.map(s => `${s.emoji} **${s.name}** — ${s.description}`).join('\n'),
            inline: false
        });
    } else if (m.level >= 25) {
        embed.addFields({
            name: '🔗 Synergies',
            value: 'Reach combined level milestones across Hunt, Fish & Mine to unlock cross-system bonuses!',
            inline: false
        });
    }

    // Only nudge the player who can act on it; someone else's maxed miner just gets
    // the standing, and the daily-cap line stays a self-only stat either way.
    if (m.level >= MAX_MINER_LEVEL && prestige >= MAX_MINE_PRESTIGE) {
        embed.setFooter({ text: `${PRESTIGE_BADGES[MAX_MINE_PRESTIGE]} Fully prestiged Master Miner — nothing left to prove down there.` });
    } else if (isSelf && m.level >= MAX_MINER_LEVEL) {
        embed.setFooter({ text: `Max Miner Level — use /mine prestige to ascend to P${prestige + 1}` });
    } else if (m.level >= MAX_MINER_LEVEL) {
        embed.setFooter({ text: 'Max Miner Level' });
    } else if (isSelf) {
        embed.setFooter({ text: `Daily: ${m.dailyMines} mines · ${currency}${m.dailyCoins.toLocaleString()} earned (cap: ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()})` });
    }

    embed.setTimestamp();
    return interaction.reply({ embeds: [embed] });
}

module.exports = {
    handlePrestige,
    handleProfile,
};
