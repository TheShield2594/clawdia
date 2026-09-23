'use strict';

/**
 * Who is in a syndicate, written as guarded single-document updates (#873,
 * pass 22).
 *
 * Membership lives in two places, `Syndicate.memberIds` and each member's
 * `User.syndicateId`, and `/syndicate` changed both from reads it had taken a
 * moment earlier:
 *
 *   - a join checked the member cap on a loaded roster and then `save()`d a
 *     `$push`, which Mongoose writes without a version check, so two joins to an
 *     open syndicate with one seat left both landed and it went over its cap;
 *   - a join's `User` write was an unconditional `$set`, so a `/syndicate
 *     create` landing between the join's check and its write left the player
 *     leading one syndicate while `User.syndicateId` pointed at another — the
 *     one they had founded (and paid 50,000 for) could no longer be managed;
 *   - leave and kick cleared `User.syndicateId` unconditionally, which could
 *     wipe a pointer to a syndicate the player had joined since;
 *   - a leader leaving alone deleted the syndicate without checking the roster
 *     it had read, so a member who joined in between was told "Joined" and
 *     left pointing at a syndicate that no longer existed.
 *
 * Each is now one conditional write whose filter holds the check.
 */

const User = require('../models/User');
const Syndicate = require('../models/Syndicate');

const noSyndicate = { $or: [{ syndicateId: null }, { syndicateId: { $exists: false } }] };

/**
 * Seat `userId` in `synDoc`, if it still has room and still admits them.
 *
 * @returns {Promise<{ok: true, doc: object} | {ok: false, reason: 'full' | 'elsewhere'}>}
 *   `full` covers every way the syndicate refused (no seat, no longer open, the
 *   invite withdrawn); `elsewhere` means the player joined or founded another
 *   syndicate first, and the seat was given back.
 */
async function claimSeat(synDoc, userId, guildId, cap) {
    const seated = await Syndicate.findOneAndUpdate(
        {
            _id: synDoc._id,
            memberIds: { $ne: userId },
            // A cap-th member does not exist yet: the seat check and the push in
            // one write.
            [`memberIds.${cap - 1}`]: { $exists: false },
            $or: [{ openToJoin: true }, { pendingInvites: userId }],
        },
        { $push: { memberIds: userId }, $pull: { pendingInvites: userId } },
        { new: true },
    );
    if (!seated) return { ok: false, reason: 'full' };

    // The player's side, only while they are still in no syndicate. The document
    // is created first so the guarded write below never has to upsert (an upsert
    // behind a filter that misses an existing document is a duplicate key).
    await User.updateOne({ userId, guildId }, { $setOnInsert: { syndicateId: null } }, { upsert: true });
    const pointed = await User.updateOne(
        { userId, guildId, ...noSyndicate },
        { $set: { syndicateId: synDoc.syndicateId } },
    );
    if ((pointed?.matchedCount ?? 0) > 0) return { ok: true, doc: seated };

    await Syndicate.updateOne({ _id: synDoc._id }, { $pull: { memberIds: userId } });
    return { ok: false, reason: 'elsewhere' };
}

/**
 * Take `userId` off `syndicateId`'s roster and clear their pointer — only if it
 * still points there. `$pull` rather than a saved filtered copy of the roster,
 * so a member who joined since the caller's read is not written back out.
 */
async function releaseSeat(syndicateId, guildId, userId) {
    await Syndicate.updateOne({ syndicateId, guildId }, { $pull: { memberIds: userId, pendingInvites: userId } });
    await User.updateOne({ userId, guildId, syndicateId }, { $set: { syndicateId: null } });
}

/**
 * Disband a syndicate whose only member is its leader. Refused (false) when
 * anyone else holds a seat by the time the delete runs.
 */
async function disbandIfAlone(syndicateId, guildId, leaderId) {
    const res = await Syndicate.deleteOne({ syndicateId, guildId, memberIds: { $size: 1 }, leaderId });
    if ((res?.deletedCount ?? 0) === 0) return false;
    await User.updateOne({ userId: leaderId, guildId, syndicateId }, { $set: { syndicateId: null } });
    return true;
}

module.exports = { claimSeat, releaseSeat, disbandIfAlone };
