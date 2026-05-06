'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { ZONES, ZONE_LIST, TIER_COLORS, LIMITS, WEAPON_BY_TIER } = require('../../data/huntData');
const {
    ensureHuntData,
    applyStaminaRegen,
    applyDailyReset,
    msUntilNextStamina,
    getMaxStamina,
    calculateSuccessChance,
    executeHunt,
    formatMs,
    weaponStatusEmoji,
    durabilityBar,
    getLevelData,
    xpToNextLevel
} = require('../../services/huntService');

// Zone slug → display name for the autocomplete choices list
const ZONE_CHOICES = ZONE_LIST.map(z => ({ name: z.name, value: z.id }));

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('hunt')
        .setDescription('Head out on a hunt and see what you can catch')
        .addStringOption(o =>
            o.setName('zone')
                .setDescription('Hunting zone to use (defaults to your active zone)')
                .setRequired(false)
                .addChoices(...ZONE_CHOICES)),

    async execute(interaction) {
        // ── Guild guard ────────────────────────────────────────────────────
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        const currency = guildSettings?.economy?.currency ?? '💰';

        // ── Load user ──────────────────────────────────────────────────────
        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );

        ensureHuntData(user);
        applyStaminaRegen(user);
        applyDailyReset(user);

        // Persist stamina regen / daily-reset mutations before any early return
        // so the computed state is not re-derived on every rejected call.
        if (user.isModified()) {
            await user.save().catch(e => console.error('[hunt] pre-check save error:', e));
        }

        const h = user.hunt;

        // ── Zone resolution ────────────────────────────────────────────────
        const requestedZone = interaction.options.getString('zone');
        const zoneId = requestedZone ?? h.activeZone;
        const zone   = ZONES[zoneId];

        if (!zone) {
            return interaction.reply({ content: `Unknown zone \`${zoneId}\`. Use \`/zone list\` to see available zones.`, ephemeral: true });
        }
        if (!h.unlockedZones.includes(zoneId)) {
            return interaction.reply({
                content: `You haven't unlocked **${zone.name}** yet. Use \`/zone unlock ${zoneId}\` to unlock it.`,
                ephemeral: true
            });
        }
        if (h.level < zone.unlockLevel) {
            return interaction.reply({
                content: `You need to be Hunter Level **${zone.unlockLevel}** to hunt in **${zone.name}**.`,
                ephemeral: true
            });
        }

        // ── Injury cooldown ────────────────────────────────────────────────
        if (h.injuryUntil && Date.now() < h.injuryUntil.getTime()) {
            const remaining = h.injuryUntil.getTime() - Date.now();
            return interaction.reply({
                content: `You're injured and need to rest. Back in action in **${formatMs(remaining)}**.`,
                ephemeral: true
            });
        }

        // ── Hunt cooldown ──────────────────────────────────────────────────
        if (h.lastHunt && Date.now() - h.lastHunt.getTime() < LIMITS.HUNT_COOLDOWN_MS) {
            const remaining = LIMITS.HUNT_COOLDOWN_MS - (Date.now() - h.lastHunt.getTime());
            return interaction.reply({
                content: `You need to catch your breath. Ready again in **${formatMs(remaining)}**.`,
                ephemeral: true
            });
        }

        // ── Stamina check ──────────────────────────────────────────────────
        if (h.stamina <= 0) {
            const regenMs = msUntilNextStamina(user);
            return interaction.reply({
                content: `You're exhausted! Stamina regens in **${formatMs(regenMs)}**. Buy a Stamina Tonic from \`/huntshop\` to recover faster.`,
                ephemeral: true
            });
        }

        // ── Weapon check ───────────────────────────────────────────────────
        if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
            return interaction.reply({
                content: `You don't have a weapon equipped! Buy one with \`/buygun\` and equip it with \`/huntinv equip 1\`.`,
                ephemeral: true
            });
        }

        const weapon = h.weapons[h.equippedWeaponIndex];

        if (weapon.status === 'broken' || weapon.currentDurability <= 0) {
            return interaction.reply({
                content: `Your **${weapon.name}** is broken! Repair it with \`/repair\` or buy a new one with \`/buygun\`.`,
                ephemeral: true
            });
        }

        // ── Ammo check ─────────────────────────────────────────────────────
        const weaponData = WEAPON_BY_TIER[weapon.tier];
        if (weaponData.requiresAmmo) {
            const ammoStock = h.ammo[weaponData.ammoType] ?? 0;
            if (ammoStock <= 0) {
                return interaction.reply({
                    content: `You're out of **${weaponData.ammoType.replace(/_/g, ' ')}**! Buy more with \`/huntshop buy\`.`,
                    ephemeral: true
                });
            }
            // Deduct ammo now (before roll — it's consumed on the attempt)
            h.ammo[weaponData.ammoType] = ammoStock - 1;
            user.markModified('hunt');
        }

        await interaction.deferReply();

        // ── Execute hunt ───────────────────────────────────────────────────
        const result = executeHunt(user, zoneId);

        try {
            await user.save();
        } catch (err) {
            if (err.name === 'VersionError') {
                return interaction.editReply({ content: 'A simultaneous request conflicted with your hunt. Please try `/hunt` again.' });
            }
            console.error('[hunt] save error:', err);
            return interaction.editReply({ content: 'Something went wrong saving your hunt. Please try again.' });
        }

        // ── Build result embed ─────────────────────────────────────────────
        const embed = buildHuntEmbed(result, user, zone, weapon, currency, interaction.user);
        await interaction.editReply({ embeds: [embed] });
    }
};

// ─── EMBED BUILDER ────────────────────────────────────────────────────────────

function buildHuntEmbed(result, user, zone, weapon, currency, discordUser) {
    const h = user.hunt;

    if (result.success) {
        const { animal, tier, finalPayout, isCrit, critMultiplier, specialDrop, xpEarned, levelUp, cappedByHard } = result;
        const color = isCrit ? '#FFD700' : TIER_COLORS[tier];

        const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
        const payoutDisplay = cappedByHard ? `~~${currency}${finalPayout}~~ (daily cap reached)` : `**${currency}${finalPayout.toLocaleString()}**`;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`${animal.emoji} ${isCrit ? '✨ CRITICAL! ' : ''}${animal.name} ${isCrit ? '✨' : ''}`)
            .setDescription(`*${animal.flavor}*`)
            .addFields(
                { name: 'Zone',     value: `${zone.emoji} ${zone.name}`,         inline: true },
                { name: 'Tier',     value: `${tierLabel}`,                        inline: true },
                { name: 'Reward',   value: payoutDisplay,                         inline: true },
                { name: 'XP',       value: `+${xpEarned} XP${isCrit ? ' (crit bonus)' : ''}`, inline: true },
                { name: 'Weapon',   value: `${weapon.name} ${weaponStatusEmoji(weapon.status)}\n${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}`, inline: true },
                { name: 'Stamina',  value: buildStaminaLine(user),                inline: true }
            );

        if (isCrit) {
            embed.addFields({ name: 'Crit Multiplier', value: `×${critMultiplier}`, inline: true });
        }

        if (specialDrop) {
            embed.addFields({ name: '🎁 Special Drop!', value: `You found **${specialDrop.name}**!`, inline: false });
        }

        if (levelUp) {
            const ld = getLevelData(levelUp.newLevel);
            embed.addFields({ name: '⬆️ Level Up!', value: `Hunter Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
        }

        if (result.expiredBait)  embed.addFields({ name: '🪱 Bait Expired', value: `Your ${result.expiredBait.replace(/_/g, ' ')} has worn off.`, inline: false });
        if (result.expiredCharm) embed.addFields({ name: '🍀 Charm Expired', value: `Your luck charm has worn off.`, inline: false });

        if (weapon.status === 'broken') {
            embed.addFields({ name: '⚠️ Weapon Broke!', value: `Your **${weapon.name}** has broken! Use \`/repair\` before hunting again.`, inline: false });
        } else if (weapon.currentDurability <= Math.floor(weapon.maxDurability * 0.20)) {
            embed.addFields({ name: '⚠️ Low Durability', value: `Your **${weapon.name}** is nearly worn out (${weapon.currentDurability}/${weapon.maxDurability}). Repair soon!`, inline: false });
        }

        const balanceLine = `${currency}${user.balance.toLocaleString()}`;
        const xpLine = buildXpLine(user);
        embed.addFields({ name: 'Balance', value: balanceLine, inline: true }, { name: 'Hunter XP', value: xpLine, inline: true });
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
            { name: 'Zone',    value: `${zone.emoji} ${zone.name}`,  inline: true },
            { name: 'Reward',  value: 'Nothing',                      inline: true },
            { name: 'XP',      value: xpEarned > 0 ? `+${xpEarned} XP` : 'None', inline: true },
            { name: 'Weapon',  value: `${weapon.name} ${weaponStatusEmoji(weapon.status)}\n${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}`, inline: true },
            { name: 'Stamina', value: buildStaminaLine(user), inline: true }
        );

    if (failure.severity.injuryMs > 0) {
        embed.addFields({ name: '🤕 Injured', value: `Extra cooldown: **${formatMs(failure.severity.injuryMs)}**`, inline: true });
    }

    if (levelUp) {
        const ld = getLevelData(levelUp.newLevel);
        embed.addFields({ name: '⬆️ Level Up!', value: `Hunter Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
    }

    if (weapon.status === 'broken') {
        embed.addFields({ name: '❌ Weapon Broke!', value: `Your **${weapon.name}** has broken! Use \`/repair\` before hunting again.`, inline: false });
    }

    embed.setFooter({ text: 'Tip: Use consumables from /huntshop to boost your success chance' });
    embed.setTimestamp();
    return embed;
}

function buildFailureTitle(severityId) {
    return { clean_miss: '💨 Miss!', spooked: '😰 Spooked!', jammed: '🔧 Jammed!', injured: '🤕 Injured!' }[severityId] ?? '❌ Failed Hunt';
}

function buildStaminaLine(user) {
    const h   = user.hunt;
    const max = getMaxStamina(user);
    return `${h.stamina}/${max} ⚡`;
}

function buildXpLine(user) {
    const h   = user.hunt;
    const toNext = xpToNextLevel(h.level, h.xp);
    if (toNext === null) return `${h.xp.toLocaleString()} XP (MAX)`;
    return `${h.xp.toLocaleString()} XP (${toNext} to Lv.${h.level + 1})`;
}

function buildActiveConsumablesLine(user) {
    const h = user.hunt;
    const parts = [];
    if (h.activeBait)  parts.push(`Bait (${h.activeBaitHuntsLeft} hunts left)`);
    if (h.activeCharm) parts.push(`Charm (${h.activeCharmHuntsLeft} hunts left)`);
    if (h.activeFocus) parts.push(`Focus (queued)`);
    if (h.activeXpScroll) parts.push(`XP Scroll (queued)`);
    return parts.length ? parts.join(' • ') : 'No active buffs';
}
