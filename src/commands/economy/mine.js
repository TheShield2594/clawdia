'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { DEPTHS, DEPTH_LIST, TIER_COLORS, LIMITS, PICKAXE_BY_TIER } = require('../../data/mineData');
const { checkAndAward, announceAchievements } = require('../../services/achievementService');
const {
    ensureMineData,
    applyStaminaRegen,
    applyDailyReset,
    msUntilNextStamina,
    getMaxStamina,
    executeMine,
    assignDailyMineQuests,
    updateMineQuestProgress,
    formatMs,
    pickaxeStatusEmoji,
    durabilityBar,
    getLevelData,
    xpToNextLevel
} = require('../../services/mineService');

const DEPTH_CHOICES = DEPTH_LIST.map(d => ({ name: d.name, value: d.id }));

module.exports = {
    cooldown: 30,

    data: new SlashCommandBuilder()
        .setName('mine')
        .setDescription('Mine ore in your current depth. Uses 1 stamina. Cooldown: 30s. Equip a pickaxe with /mineinv.')
        .addStringOption(o =>
            o.setName('depth')
                .setDescription('Depth to mine in (defaults to your active depth). Unlock more with /mineshop unlock.')
                .setRequired(false)
                .addChoices(...DEPTH_CHOICES)),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        const currency = guildSettings?.economy?.currency ?? '💰';

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );

        ensureMineData(user);
        applyStaminaRegen(user);
        applyDailyReset(user);
        assignDailyMineQuests(user);

        if (user.isModified()) {
            await user.save().catch(e => console.error('[mine] pre-check save error:', e));
        }

        const m = user.mining;

        // ── Depth resolution ───────────────────────────────────────────────
        const requestedDepth = interaction.options.getString('depth');
        const depthId = requestedDepth ?? m.activeDepth;
        const depth   = DEPTHS[depthId];

        if (!depth) {
            return interaction.reply({ content: `Unknown depth \`${depthId}\`. Use \`/mineshop list\` to see available depths.`, ephemeral: true });
        }
        if (!m.unlockedDepths.includes(depthId)) {
            return interaction.reply({
                content: `You haven't unlocked **${depth.name}** yet. Use \`/mineshop unlock\` to unlock it.`,
                ephemeral: true
            });
        }
        if (m.level < depth.unlockLevel) {
            return interaction.reply({
                content: `You need to be Miner Level **${depth.unlockLevel}** to mine in **${depth.name}**.`,
                ephemeral: true
            });
        }

        // ── Injury cooldown ────────────────────────────────────────────────
        if (m.injuryUntil && Date.now() < m.injuryUntil.getTime()) {
            const remaining = m.injuryUntil.getTime() - Date.now();
            return interaction.reply({
                content: `You're injured and need to rest. Back to work in **${formatMs(remaining)}**.`,
                ephemeral: true
            });
        }

        // ── Mine cooldown ──────────────────────────────────────────────────
        if (m.lastMine && Date.now() - m.lastMine.getTime() < LIMITS.MINE_COOLDOWN_MS) {
            const remaining = LIMITS.MINE_COOLDOWN_MS - (Date.now() - m.lastMine.getTime());
            return interaction.reply({
                content: `You need a breather. Ready again in **${formatMs(remaining)}**.`,
                ephemeral: true
            });
        }

        // ── Stamina check ──────────────────────────────────────────────────
        if (m.stamina <= 0) {
            const regenMs = msUntilNextStamina(user);
            return interaction.reply({
                content: `You're exhausted! Stamina regens in **${formatMs(regenMs)}**. Buy an Energy Tonic from \`/mineshop\` to recover faster.`,
                ephemeral: true
            });
        }

        // ── Pickaxe check ──────────────────────────────────────────────────
        if (m.equippedPickaxeIndex < 0 || !m.pickaxes[m.equippedPickaxeIndex]) {
            return interaction.reply({
                content: `You don't have a pickaxe equipped! Buy one with \`/mineshop pickaxe\` and equip it with \`/mineinv equip 1\`.`,
                ephemeral: true
            });
        }

        const pickaxe = m.pickaxes[m.equippedPickaxeIndex];

        if (pickaxe.status === 'broken' || pickaxe.currentDurability <= 0) {
            return interaction.reply({
                content: `Your **${pickaxe.name}** is broken! Repair it with \`/mineshop repair\` or buy a new one with \`/mineshop pickaxe\`.`,
                ephemeral: true
            });
        }

        // ── Blast charge check ─────────────────────────────────────────────
        const pickaxeData = PICKAXE_BY_TIER[pickaxe.tier];
        if (pickaxeData.requiresCharge) {
            const chargeStock = m.charges[pickaxeData.chargeType] ?? 0;
            if (chargeStock <= 0) {
                return interaction.reply({
                    content: `You're out of **${pickaxeData.chargeType.replace(/_/g, ' ')}**! Buy more with \`/mineshop buy\`.`,
                    ephemeral: true
                });
            }
            m.charges[pickaxeData.chargeType] = chargeStock - 1;
            user.markModified('mining');
        }

        await interaction.deferReply();

        const result = executeMine(user, depthId);
        updateMineQuestProgress(user, result, depthId);

        const mineAchievements = await checkAndAward(user, guildSettings).catch(() => []);

        try {
            await user.save();
            if (mineAchievements.length) {
                announceAchievements(interaction.client, guildSettings, user, interaction.member, mineAchievements).catch(() => null);
            }
        } catch (err) {
            if (err.name === 'VersionError') {
                return interaction.editReply({ content: 'A simultaneous request conflicted with your mine. Please try `/mine` again.' });
            }
            console.error('[mine] save error:', err);
            return interaction.editReply({ content: 'Something went wrong saving your mine. Please try again.' });
        }

        const embed = buildMineEmbed(result, user, depth, pickaxe, currency, interaction.user);
        await interaction.editReply({ embeds: [embed] });
    }
};

// ─── EMBED BUILDER ────────────────────────────────────────────────────────────

function buildMineEmbed(result, user, depth, pickaxe, currency, discordUser) {
    const m = user.mining;

    if (result.success) {
        const { ore, tier, finalPayout, isCrit, critMultiplier, specialDrop, xpEarned, levelUp, cappedByHard } = result;
        const color = isCrit ? '#FFD700' : TIER_COLORS[tier];

        const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
        const payoutDisplay = cappedByHard ? `~~${currency}${finalPayout}~~ (daily cap reached)` : `**${currency}${finalPayout.toLocaleString()}**`;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`${ore.emoji} ${isCrit ? '✨ CRITICAL! ' : ''}${ore.name} ${isCrit ? '✨' : ''}`)
            .setDescription(`*${ore.flavor}*`)
            .addFields(
                { name: 'Depth',    value: `${depth.emoji} ${depth.name}`,         inline: true },
                { name: 'Tier',     value: tierLabel,                               inline: true },
                { name: 'Reward',   value: payoutDisplay,                           inline: true },
                { name: 'XP',       value: `+${xpEarned} XP${isCrit ? ' (crit bonus)' : ''}`, inline: true },
                { name: 'Pickaxe',  value: `${pickaxe.name} ${pickaxeStatusEmoji(pickaxe.status)}\n${durabilityBar(pickaxe.currentDurability, pickaxe.maxDurability)} ${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
                { name: 'Stamina',  value: buildStaminaLine(user),                  inline: true }
            );

        if (isCrit) {
            embed.addFields({ name: 'Crit Multiplier', value: `×${critMultiplier}`, inline: true });
        }

        if (specialDrop) {
            embed.addFields({ name: '🪨 Material Drop!', value: `You found **${specialDrop.name}**!`, inline: false });
        }

        if (levelUp) {
            const ld = getLevelData(levelUp.newLevel);
            embed.addFields({ name: '⬆️ Level Up!', value: `Miner Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
        }

        if (result.expiredMagnet) embed.addFields({ name: '🧲 Magnet Expired', value: `Your ${result.expiredMagnet.replace(/_/g, ' ')} has worn off.`, inline: false });
        if (result.expiredLamp)   embed.addFields({ name: '🪔 Lamp Expired',    value: `Your miner's lamp has flickered out.`, inline: false });

        if (pickaxe.status === 'broken') {
            embed.addFields({ name: '⚠️ Pickaxe Broke!', value: `Your **${pickaxe.name}** has broken! Use \`/mineshop repair\` before mining again.`, inline: false });
        } else if (pickaxe.currentDurability <= Math.floor(pickaxe.maxDurability * 0.20)) {
            embed.addFields({ name: '⚠️ Low Durability', value: `Your **${pickaxe.name}** is nearly worn out (${pickaxe.currentDurability}/${pickaxe.maxDurability}). Repair soon!`, inline: false });
        }

        embed.addFields(
            { name: 'Balance',   value: `${currency}${user.balance.toLocaleString()}`,   inline: true },
            { name: 'Miner XP',  value: buildXpLine(user),                               inline: true }
        );
        embed.setFooter({ text: `Cooldown: 30s • ${buildActiveConsumablesLine(user)}` });
        embed.setTimestamp();
        return embed;
    }

    // ── Failure embed ──────────────────────────────────────────────────────
    const { failure, xpEarned, levelUp } = result;
    const embed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle(buildFailureTitle(failure.severity.id))
        .setDescription(`*${failure.message}*`)
        .addFields(
            { name: 'Depth',   value: `${depth.emoji} ${depth.name}`,  inline: true },
            { name: 'Reward',  value: 'Nothing',                        inline: true },
            { name: 'XP',      value: xpEarned > 0 ? `+${xpEarned} XP` : 'None', inline: true },
            { name: 'Pickaxe', value: `${pickaxe.name} ${pickaxeStatusEmoji(pickaxe.status)}\n${durabilityBar(pickaxe.currentDurability, pickaxe.maxDurability)} ${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
            { name: 'Stamina', value: buildStaminaLine(user), inline: true }
        );

    if (failure.severity.injuryMs > 0) {
        embed.addFields({ name: '🤕 Cave-in', value: `Extra cooldown: **${formatMs(failure.severity.injuryMs)}**`, inline: true });
    }

    if (result.collapseEvent) {
        embed.setColor('#8B0000');
        embed.addFields({ name: '💀 Catastrophic Collapse!', value: `The tunnel caved in around you — your **${result.collapseEvent.weaponName}** was completely destroyed! Use \`/mineshop repair\` to fix it.`, inline: false });
    }

    if (levelUp) {
        const ld = getLevelData(levelUp.newLevel);
        embed.addFields({ name: '⬆️ Level Up!', value: `Miner Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
    }

    if (pickaxe.status === 'broken' && !result.collapseEvent) {
        embed.addFields({ name: '❌ Pickaxe Broke!', value: `Your **${pickaxe.name}** has broken! Use \`/mineshop repair\` before mining again.`, inline: false });
    }

    embed.setFooter({ text: 'Tip: Use consumables from /mineshop to boost your success chance' });
    embed.setTimestamp();
    return embed;
}

function buildFailureTitle(severityId) {
    return {
        clean_miss: '💨 Empty Vein!',
        rockfall:   '🪨 Rockfall!',
        stuck:      '🔧 Pickaxe Stuck!',
        cave_in:    '🕳️ Cave-in!'
    }[severityId] ?? '❌ Failed Mine';
}

function buildStaminaLine(user) {
    const m   = user.mining;
    const max = getMaxStamina(user);
    return `${m.stamina}/${max} ⚡`;
}

function buildXpLine(user) {
    const m      = user.mining;
    const toNext = xpToNextLevel(m.level, m.xp);
    if (toNext === null) return `${m.xp.toLocaleString()} XP (MAX)`;
    return `${m.xp.toLocaleString()} XP (${toNext} to Lv.${m.level + 1})`;
}

function buildActiveConsumablesLine(user) {
    const m = user.mining;
    const parts = [];
    if (m.activeMagnet)   parts.push(`Magnet (${m.activeMagnetMinesLeft} mines left)`);
    if (m.activeLamp)     parts.push(`Lamp (${m.activeLampMinesLeft} mines left)`);
    if (m.activeInstinct) parts.push(`Instinct (queued)`);
    if (m.activeXpScroll) parts.push(`XP Scroll (queued)`);
    return parts.length ? parts.join(' • ') : 'No active buffs';
}
