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

module.exports = { hasManagePermission, ADMINISTRATOR, MANAGE_GUILD };
