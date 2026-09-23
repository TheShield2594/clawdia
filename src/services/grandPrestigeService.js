'use strict';

// Grand Master: Diamond prestige in all three skill tracks (#873, pass 20).
//
// This lived as two identical copies in hunt/profile.js and fish/profile.js,
// and had two faults:
//
//   - `/mine prestige` never called it. Every track tops out at Diamond, so a
//     player who maxed /hunt and /fish first and finished on /mine had no
//     prestige left that would ever run the check — Grand Master was
//     unreachable for them.
//   - It read the flag off the document it was handed and then wrote with an
//     unguarded `$set`, so two prestiges finishing together could both pass the
//     read and both announce the achievement.
//
// One copy now, called by all three. It reads the three ranks from the stored
// profiles rather than a snapshot, claims the title with a write guarded on
// not already holding it, and announces only when this call made the claim.

const User = require('../models/User');
const GrindProfile = require('../models/GrindProfile');
const { getGuildSettings } = require('../utils/guildSettingsCache');
const COLORS = require('../utils/embedColors');

const GRAND_PRESTIGE_DIAMOND = 5;
const SYSTEMS = ['hunt', 'fishing', 'mining'];

/**
 * Award Grand Master if the player now holds Diamond in all three tracks.
 * Never throws. @returns {Promise<boolean>} true when this call awarded it.
 */
async function checkGrandPrestige(client, userId, guildId, guild = null) {
    try {
        const profiles = await GrindProfile.find(
            { userId, guildId, system: { $in: SYSTEMS } },
            'system data.prestige',
        ).lean();
        const rank = system => profiles.find(p => p.system === system)?.data?.prestige ?? 0;
        if (!SYSTEMS.every(system => rank(system) >= GRAND_PRESTIGE_DIAMOND)) return false;

        const claimed = await User.findOneAndUpdate(
            { userId, guildId, $or: [
                { 'grandPrestige.level': { $lt: 1 } },
                { 'grandPrestige.level': null },
            ] },
            { $set: { 'grandPrestige.level': 1, 'grandPrestige.awardedAt': new Date() } },
            { new: true },
        );
        if (!claimed) return false;

        const guildSettings = await getGuildSettings(guildId).catch(() => null);
        const announceChannelId = guildSettings?.accountPrestige?.announceChannelId
            ?? guildSettings?.economy?.announcementChannelId
            ?? null;
        if (announceChannelId && client) {
            const { EmbedBuilder } = require('discord.js');
            const broadcastEmbed = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setTitle('⚜️ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ⚜️')
                .setDescription(
                    `**GRAND MASTER ACHIEVED!**\n\n` +
                    `<@${userId}> has reached **Diamond Prestige** in all three skill tracks!\n\n` +
                    `🏹 Diamond Hunter · 🎣 Diamond Angler · ⛏️ Diamond Miner\n\n` +
                    `*The rarest achievement in this server.*`
                )
                .setTimestamp();
            const g  = guild ?? await client.guilds.fetch(guildId).catch(() => null);
            const ch = g?.channels?.cache?.get(announceChannelId);
            if (ch?.isTextBased?.()) ch.send({ embeds: [broadcastEmbed] }).catch(() => {});
        }
        return true;
    } catch (err) {
        console.error('[grand prestige] check failed:', err?.message);
        return false;
    }
}

module.exports = { checkGrandPrestige, GRAND_PRESTIGE_DIAMOND };
