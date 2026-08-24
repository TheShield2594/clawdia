'use strict';

/**
 * Whether a Discord OAuth guild entry grants the user dashboard access.
 *
 * The permission bitfield from /users/@me/guilds arrives as a decimal *string*
 * because it long ago outgrew 32 bits. Evaluating it with JavaScript's bitwise
 * operators (`guild.permissions & 0x20`) coerces it through ToInt32, which
 * silently discards everything above bit 31. That happens to leave MANAGE_GUILD
 * (bit 5) intact today, so the old check worked — but it is only correct by
 * accident, and a `Number()` round-trip also loses precision once Discord
 * allocates a permission past bit 53. BigInt is the only representation that
 * stays correct as the bitfield grows.
 *
 * This lives in one place because the rule was previously implemented twice —
 * once for rendering the guild list and once for authorising API calls — and
 * two copies of an authorization rule drift.
 */

const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;

function hasManagePermission(guild) {
    if (!guild) return false;
    // Discord reports the owner explicitly; it also grants owners every bit, but
    // the flag is checked first so ownership never depends on bitfield parsing.
    if (guild.owner === true) return true;
    try {
        const perms = BigInt(guild.permissions ?? 0);
        return (perms & ADMINISTRATOR) === ADMINISTRATOR
            || (perms & MANAGE_GUILD) === MANAGE_GUILD;
    } catch {
        // Malformed or absent bitfield — fail closed.
        return false;
    }
}

const LIVE_ACCESS_TTL_MS = 60_000;
// FIFO-evicted, like every other cache in the bot: the ceiling is what keeps a
// stream of distinct user/guild pairs from growing the map without bound.
const LIVE_ACCESS_MAX_ENTRIES = 5_000;

const liveAccessCache = new Map(); // `${guildId}:${userId}` -> { expiresAt, allowed }

function cacheLiveAccess(key, allowed) {
    if (!liveAccessCache.has(key) && liveAccessCache.size >= LIVE_ACCESS_MAX_ENTRIES) {
        liveAccessCache.delete(liveAccessCache.keys().next().value);
    }
    liveAccessCache.set(key, { expiresAt: Date.now() + LIVE_ACCESS_TTL_MS, allowed });
}

/**
 * Whether Discord *currently* says this user administers the guild.
 *
 * `hasManagePermission` above answers the same question from `req.user.guilds`,
 * which is a snapshot taken once at OAuth time and then kept in the session for
 * as long as the session lives (#558). Nothing refreshes it: an admin whose
 * MANAGE_GUILD is revoked, or who is kicked from the guild outright, keeps
 * every dashboard privilege the snapshot recorded until the cookie expires.
 * So the snapshot is treated as a claim to be checked rather than as the
 * authority, and the gateway — which is talking to Discord — is asked.
 *
 * Three answers, and the third is the interesting one:
 *
 *   true   the member is there and holds ADMINISTRATOR or MANAGE_GUILD.
 *   false  the member is gone, or no longer holds either. Deny.
 *   null   nobody could say: the bot is not in the guild, Discord refused the
 *          fetch, or the caller passed a gateway without the method. Denying on
 *          null would mean a Discord outage locks every operator out of their
 *          own dashboard, so the session snapshot — which the caller has
 *          already checked — stands in until an answer is available.
 *
 * Answers are cached briefly because this runs on every API request and each
 * miss is a member fetch. LIVE_ACCESS_TTL_MS is therefore the real revocation
 * window: a minute, against the 24 hours it replaces.
 *
 * @returns {Promise<boolean|null>}
 */
async function verifyLiveGuildAccess(bot, guildId, userId) {
    if (!guildId || !userId || typeof bot?.canManageGuild !== 'function') return null;

    const key = `${guildId}:${userId}`;
    const hit = liveAccessCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.allowed;

    let allowed;
    try {
        allowed = await bot.canManageGuild(guildId, userId);
    } catch (err) {
        console.warn(`[DASHBOARD] Live permission check failed for ${userId} in ${guildId}: ${err.message}`);
        return null;
    }
    if (allowed !== true && allowed !== false) return null;

    cacheLiveAccess(key, allowed);
    return allowed;
}

/**
 * Drops a cached answer, so the next check asks Discord again. Exported for
 * tests, and for any future path that knows an answer has just gone stale.
 */
function forgetLiveGuildAccess(guildId, userId) {
    if (guildId === undefined && userId === undefined) return liveAccessCache.clear();
    liveAccessCache.delete(`${guildId}:${userId}`);
}

module.exports = {
    hasManagePermission,
    verifyLiveGuildAccess,
    forgetLiveGuildAccess,
    LIVE_ACCESS_TTL_MS,
    ADMINISTRATOR,
    MANAGE_GUILD,
};
