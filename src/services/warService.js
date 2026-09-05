/**
 * Guild wars: resolving one whose window has closed, and the sweep that finds
 * them (#931).
 *
 * `/war` (commands/economy/war.js) declares, accepts and scores a war; this is
 * the other end of it. The sweep is registered as a job in
 * `services/scheduler/index.js`, which owns the cron expression and runs it
 * through `runJob` — so a throw is recorded on the health payload and filed as
 * a dead-letter entry, and a tick is dropped rather than overlapped while the
 * previous run is still going. Nothing here schedules itself; a `setInterval`
 * in this file would cost all of that (#611).
 *
 * The shape is the one a job that pays people out has to have:
 *
 * - **Idempotent.** The resolution is claimed by flipping `activeWar.status`
 *   from 'active' to 'ended' in a single atomic update, so a job that runs
 *   twice — a retry, two processes, a resolution racing a manual one — awards
 *   once.
 * - **Per-guild failure isolation.** One guild's error is logged and the loop
 *   moves to the next; a bad document does not cost every other server its war.
 * - **Announcements are best-effort.** A missing channel or a revoked
 *   permission never rolls back rewards that already landed.
 *
 * @module services/warService
 */

const Guild = require('../models/Guild');
const User  = require('../models/User');
const { handlesGuild } = require('../utils/sharding');
const { createWarVictoryBanner } = require('../utils/cardGenerator');
const { postAnnouncement } = require('../utils/guildAnnounce');
const { eventCommentary, addCommentary } = require('./commentaryService');
const COLORS = require('../utils/embedColors');

const WAR_BOOSTER_DURATION_MS = 24 * 60 * 60 * 1000;
const WAR_BADGE_DURATION_MS   = 30 * 24 * 60 * 60 * 1000;

// Resolves a single expired war atomically. Returns true if this call performed
// the resolution (idempotent — concurrent invocations will only resolve once).
async function resolveOneWar(client, guildDoc) {
    const guildId = guildDoc.guildId;
    const war = guildDoc.activeWar;

    // Atomically flip status='active' → 'ended' so duplicate sweeps no-op
    const claimed = await Guild.findOneAndUpdate(
        { guildId, 'activeWar.status': 'active' },
        { $set: { 'activeWar.status': 'ended' } },
        { new: false }
    );
    if (!claimed) return false;

    const myScore = war.myScore ?? 0;
    const oppScore = war.opponentScore ?? 0;
    const tied = myScore === oppScore;
    const iWon = myScore > oppScore;

    // Opponent guild id and doc
    const opponentGuildId = war.opponentGuildId;
    const oppName = war.opponentGuildName ?? 'Enemy Server';

    // End the opponent's mirrored war record too
    if (opponentGuildId) {
        await Guild.findOneAndUpdate(
            { guildId: opponentGuildId, 'activeWar.opponentGuildId': guildId, 'activeWar.status': 'active' },
            { $set: { 'activeWar.status': 'ended' } }
        ).catch(err => console.error(`[scheduler] opponent war end failed:`, err.message));
    }

    // Determine winning/losing guild ids for badge and booster grants
    const winnerGuildId = iWon ? guildId : (tied ? null : opponentGuildId);
    const winnerName    = iWon ? guildDoc.name : (tied ? null : oppName);
    const loserName     = iWon ? oppName        : (tied ? null : guildDoc.name);
    const winnerScore   = iWon ? myScore : oppScore;
    const loserScore    = iWon ? oppScore : myScore;

    // Find MVP (highest duel wins in winning guild) and most-clutch (highest streak)
    let mvpUserId = null, mvpName = null, clutchUserId = null, clutchName = null;
    if (winnerGuildId && !tied) {
        try {
            const discordGuild = await client.guilds.fetch(winnerGuildId).catch(() => null);
            const [mvpUser, clutchUser] = await Promise.all([
                User.findOne({ guildId: winnerGuildId }).sort({ duelWins: -1 }).select('userId duelWins').lean(),
                User.findOne({ guildId: winnerGuildId }).sort({ 'streak.current': -1 }).select('userId streak').lean(),
            ]);
            if (mvpUser && discordGuild) {
                const m = await discordGuild.members.fetch(mvpUser.userId).catch(() => null);
                mvpUserId = mvpUser.userId;
                mvpName = m?.user?.username ?? null;
            }
            if (clutchUser && discordGuild && clutchUser.userId !== mvpUserId) {
                const c = await discordGuild.members.fetch(clutchUser.userId).catch(() => null);
                clutchUserId = clutchUser.userId;
                clutchName = c?.user?.username ?? null;
            }
        } catch {}
    }

    // Reward winners with a 24h 2x coin booster + 30d War Victor badge
    if (!tied && winnerGuildId) {
        const boosterExpiry = new Date(Date.now() + WAR_BOOSTER_DURATION_MS);
        const badgeExpiry   = new Date(Date.now() + WAR_BADGE_DURATION_MS);
        await User.updateMany(
            { guildId: winnerGuildId },
            {
                $push: {
                    activeEffects: { type: 'coin_booster_2x', expiresAt: boosterExpiry, charges: -1 },
                    badges:        { id: 'war_victor', label: '🎖️ War Victor', expiresAt: badgeExpiry }
                }
            }
        ).catch(err => console.error(`[scheduler] war rewards grant failed:`, err.message));
    }

    const { EmbedBuilder, AttachmentBuilder } = require('discord.js');

    // Build the victory banner image for the winning guild announcement
    let bannerAttachment = null;
    if (!tied && winnerName) {
        try {
            const buf = await createWarVictoryBanner(winnerName, winnerScore, loserName, loserScore, mvpName);
            bannerAttachment = new AttachmentBuilder(buf, {
                name: 'war_victory.png',
                description: `Victory banner: ${winnerName} beat ${loserName} by ${winnerScore} points to ${loserScore}`
                    + (mvpName ? `, with ${mvpName} as MVP.` : '.'),
            });
        } catch (err) {
            console.error('[scheduler] war banner generation failed:', err.message);
        }
    }

    // Helper to build guild-specific embed
    function buildWarEmbed(perspective) {
        // perspective: 'winner' | 'loser' | 'tie'
        if (perspective === 'tie') {
            return new EmbedBuilder()
                .setColor(COLORS.NEUTRAL)
                .setTitle('⚔️ War Ended — Tie!')
                .setDescription(
                    `The war between **${guildDoc.name}** and **${oppName}** ended in a tie!\n\n` +
                    `**${myScore.toLocaleString()}** pts — **${oppScore.toLocaleString()}** pts`
                )
                .setTimestamp();
        }
        if (perspective === 'winner') {
            const embed = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setTitle(`🏆 ${winnerName} WINS THE WAR`)
                .setDescription(
                    `**${winnerName}** has crushed **${loserName}**!\n\n` +
                    `**Score:** ${winnerScore.toLocaleString()} — ${loserScore.toLocaleString()}\n\n` +
                    `All members receive a **2× coin booster** for 24 hours and a **🎖️ War Victor** badge for 30 days!`
                );
            // Only when the banner was actually built: announceWar attaches the
            // file only if it exists, and an embed pointing at an attachment
            // that was never sent renders as a broken image rather than as no
            // image. Banner generation is best-effort (it is caught above), so
            // this is the state a failed render leaves behind.
            if (bannerAttachment) embed.setImage('attachment://war_victory.png');
            if (mvpUserId) embed.addFields({ name: '🏅 MVP', value: `<@${mvpUserId}> • ${mvpName ?? ''}`, inline: true });
            if (clutchUserId) embed.addFields({ name: '💪 Most Clutch', value: `<@${clutchUserId}> • ${clutchName ?? ''}`, inline: true });
            embed.setTimestamp();
            return embed;
        }
        // loser perspective
        return new EmbedBuilder()
            .setColor(COLORS.ERROR)
            .setTitle('⚔️ War Lost')
            .setDescription(
                `**${oppName}** has defeated **${guildDoc.name}**.\n\n` +
                `**Score:** ${myScore.toLocaleString()} — ${oppScore.toLocaleString()}\n\n` +
                `Train harder and challenge them again!`
            )
            .setTimestamp();
    }

    // Everything a commentator may say about this war, and nothing else (#836).
    // Built from the numbers the resolution above already computed, so the
    // colour commentary cannot invent a score or a player.
    const warFacts = {
        outcome: tied
            ? `${guildDoc.name} and ${oppName} drew`
            : `${winnerName} beat ${loserName}`,
        'final score': tied
            ? `${guildDoc.name} ${myScore.toLocaleString()} — ${oppName} ${oppScore.toLocaleString()}`
            : `${winnerName} ${winnerScore.toLocaleString()} — ${loserName} ${loserScore.toLocaleString()}`,
        margin: tied ? 'nothing in it — a draw' : Math.abs(myScore - oppScore).toLocaleString(),
        'MVP of the winning server': mvpName,
        'most clutch player': clutchName,
        'what the winners get': tied ? null : 'a 24-hour 2× coin booster and a 30-day War Victor badge'
    };

    /**
     * Post one side's announcement, with that server's own commentary on it.
     *
     * Each guild is asked separately and pays for its own: the two servers have
     * different personas, different budgets, and one of them may have the
     * feature switched off entirely. A guild that does gets exactly the embed it
     * would have got before — the commentary is a field on top of a complete
     * announcement, never a replacement for one, so a provider outage here costs
     * nobody their war result.
     */
    async function announceWar(targetDoc, targetGuildId, channelId, perspective) {
        if (!channelId) return;
        const embed = buildWarEmbed(perspective);

        const commentary = await eventCommentary(targetDoc, {
            event: 'war',
            facts: {
                ...warFacts,
                'the server you are writing for': targetDoc?.name || 'this server',
                'how it went for them': perspective === 'tie' ? 'a draw' : perspective === 'winner' ? 'they won' : 'they lost'
            }
        }).catch(() => null);
        addCommentary(embed, commentary);

        // The banner is the winner's, and only the winner's.
        const payload = perspective === 'winner' && bannerAttachment
            ? { embeds: [embed], files: [bannerAttachment] }
            : { embeds: [embed] };
        await postAnnouncement(client, targetGuildId, channelId, payload);
    }

    const oppDoc = opponentGuildId
        ? await Guild.findOne({ guildId: opponentGuildId }).lean()
        : null;
    const oppChannelId = oppDoc?.activeWar?.announcementChannelId ?? null;

    if (tied) {
        await announceWar(guildDoc, guildId, war.announcementChannelId, 'tie');
        if (opponentGuildId) await announceWar(oppDoc, opponentGuildId, oppChannelId, 'tie');
    } else if (iWon) {
        await announceWar(guildDoc, guildId, war.announcementChannelId, 'winner');
        if (opponentGuildId) await announceWar(oppDoc, opponentGuildId, oppChannelId, 'loser');
    } else {
        await announceWar(guildDoc, guildId, war.announcementChannelId, 'loser');
        if (opponentGuildId) await announceWar(oppDoc, opponentGuildId, oppChannelId, 'winner');
    }

    return true;
}

/**
 * Resolve every guild war whose window has closed: award the winner, hand out
 * boosters and badges, and post the victory banner to both servers.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function resolveExpiredWars(client) {
    const expired = await Guild.find({
        'activeWar.status': 'active',
        'activeWar.endsAt': { $ne: null, $lte: new Date() }
    });

    for (const guildDoc of expired) {
        // Per-guild job (src/services/scheduler). A war has two sides and only
        // the declaring guild decides the partition, so the opponent's copy of
        // the announcement still depends on where that guild routes — but this
        // is strictly more of it than shard 0 alone could deliver.
        if (!handlesGuild(guildDoc.guildId, client)) continue;

        try {
            await resolveOneWar(client, guildDoc);
        } catch (err) {
            console.error(`[scheduler] resolveOneWar failed for guild ${guildDoc.guildId}:`, err);
        }
    }
}

module.exports = { resolveExpiredWars };
