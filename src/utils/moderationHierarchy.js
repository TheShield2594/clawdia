'use strict';

/**
 * Does the moderator running this command actually outrank the member they are
 * aiming at?
 *
 * Every moderation command used to answer a different question. `member.bannable`,
 * `member.kickable` and `member.moderatable` all describe the *bot's* power over
 * the target — whether the bot's highest role sits above theirs and whether it
 * holds the permission. None of them look at the invoker at all. So a trial
 * moderator holding only Ban Members could ban the head moderator, or an admin,
 * as long as the bot outranked them: an action Discord's own right-click menu
 * would refuse, waved through because the check asked about the wrong actor.
 *
 * This is the missing half. It compares the invoker's highest role against the
 * target's, the way Discord does, and is deliberately the only place that
 * comparison lives — the repo previously had exactly one `roles.highest` call
 * site in the whole tree, in antiNukeService.
 *
 * Returns a ready-to-send refusal string, or `null` when the action may proceed.
 * Callers read as:
 *
 *     const denial = hierarchyDenial(interaction.member, member, 'ban');
 *     if (denial) return interaction.reply({ content: denial, ... });
 */

/**
 * @param {import('discord.js').GuildMember|null|undefined} invoker  the moderator
 * @param {import('discord.js').GuildMember|null|undefined} target   the member being acted on
 * @param {string} action  verb for the refusal message, e.g. 'ban'
 * @returns {string|null} refusal text, or null if allowed
 */
function hierarchyDenial(invoker, target, action = 'moderate') {
    // Not a member of this guild — a banned-by-ID user, someone who already left.
    // There is no role to outrank, so hierarchy has nothing to say; the caller's
    // own permission and bannable checks still apply.
    if (!target) return null;

    // Should not happen for a guild interaction, but an absent invoker means we
    // cannot establish rank, and an unestablished rank is not a passing one.
    if (!invoker) return `Could not verify your role position, so this ${action} was not performed.`;

    const ownerId = invoker.guild?.ownerId ?? target.guild?.ownerId ?? null;

    // The owner sits above the role list entirely — outside it, in fact, since
    // their highest role can be anything. Check both ends against ownership
    // before touching positions.
    if (ownerId && invoker.id === ownerId) return null;
    if (ownerId && target.id === ownerId) {
        return `You cannot ${action} the server owner.`;
    }

    let outranks;
    try {
        outranks = invoker.roles.highest.comparePositionTo(target.roles.highest) > 0;
    } catch {
        // Malformed member objects, or roles from different guilds — fail closed.
        return `Could not compare your role position with theirs, so this ${action} was not performed.`;
    }

    if (!outranks) {
        return `You cannot ${action} someone whose highest role is above or equal to yours.`;
    }

    return null;
}

/**
 * The member behind a user id, or null if they are not in this guild.
 *
 * The commands used to read `guild.members.cache.get(id)` and treat a miss as
 * "not a member". That is not what a miss means here: GuildMemberManager is
 * capped at 200 per guild with an hourly sweep (utils/cacheOptions), so in any
 * guild worth moderating the cache is a small recently-seen sample, not a
 * roster. A hierarchy check that only runs on cache hits is a hierarchy check an
 * attacker skips by picking a target who has been quiet — which is most of the
 * senior staff this guard exists to protect.
 *
 * A genuine non-member (banning a raider by id, the case massban is for) still
 * comes back null; the fetch just makes that answer true rather than assumed.
 */
async function resolveMember(guild, userId) {
    const cached = guild?.members?.cache?.get(userId);
    if (cached) return cached;
    try {
        return await guild.members.fetch(userId);
    } catch {
        // Unknown Member, or the fetch failed. Either way there is no member to
        // compare against; the caller's own permission checks still apply.
        return null;
    }
}

/**
 * The same resolution for a batch of ids, in one round trip rather than fifty.
 * Returns a Map of id -> member, holding only the ids that are members.
 */
async function resolveMembers(guild, userIds) {
    const resolved = new Map();
    for (const id of userIds) {
        const cached = guild?.members?.cache?.get(id);
        if (cached) resolved.set(id, cached);
    }

    const unresolved = userIds.filter(id => !resolved.has(id));
    if (unresolved.length === 0) return resolved;

    try {
        const fetched = await guild.members.fetch({ user: unresolved });
        for (const [id, member] of fetched) resolved.set(id, member);
    } catch {
        // A failed batch fetch leaves the ids unresolved, which reads as "not a
        // member" — the same answer the cache-only code always gave, and the
        // bot's own bannable check still stands behind it.
    }
    return resolved;
}

module.exports = { hierarchyDenial, resolveMember, resolveMembers };
