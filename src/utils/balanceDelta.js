/**
 * Keeps `balance` out of a document `save()` and re-applies it as an `$inc`.
 *
 * `save()` writes every modified path as an absolute `$set`, so a flow that
 * reads a user, mutates `user.balance` in memory and saves is writing the value
 * it read — plus its own change — over whatever else happened in between. In a
 * flow with interactive awaits that window is seconds wide: `/fish` reads the
 * user, waits 2–5s for the bite and up to 3s more for the reel-in prompt, then
 * saves. A casino bet placed in another channel during the prompt is simply
 * erased when the cast lands, refunding the bet for free.
 *
 * Wrapping the save turns the in-memory change into a relative one:
 *
 *     const at = user.balance;              // before the awaits
 *     ...                                    // flow mutates user.balance freely
 *     const delta = detachBalanceDelta(user, at);
 *     await user.save();                     // no longer touches balance
 *     await applyBalanceDelta(User, filter, user, delta);
 *
 * Concurrent writers each apply their own `$inc`, so both changes survive.
 *
 * The save runs first on purpose. If it fails, nothing is credited and the flow
 * can be retried; the reverse order would credit coins that a failed save then
 * lets the player earn again.
 */

/**
 * Rewinds `user.balance` to `balanceAtLoad` and clears its modified flag, so the
 * next `save()` leaves the stored balance alone. Returns the net change the flow
 * made, to be handed to `applyBalanceDelta` once the save has landed.
 */
function detachBalanceDelta(user, balanceAtLoad) {
    const delta = (user.balance ?? 0) - balanceAtLoad;
    user.balance = balanceAtLoad;
    user.unmarkModified('balance');
    return delta;
}

/**
 * Applies `delta` as an atomic `$inc` and refreshes `user.balance` with the
 * authoritative post-write value, so anything rendered afterwards shows the real
 * number rather than the flow's private arithmetic. The path is left unmarked:
 * a later `save()` in the same flow must not write this value back as a `$set`.
 *
 * Returns the resulting balance.
 */
async function applyBalanceDelta(Model, filter, user, delta) {
    if (!delta) return user.balance ?? 0;

    const bumped = await Model.findOneAndUpdate(
        filter,
        { $inc: { balance: delta } },
        { new: true, projection: { balance: 1 } },
    );

    user.balance = bumped ? bumped.balance : (user.balance ?? 0) + delta;
    user.unmarkModified('balance');
    return user.balance;
}

module.exports = { detachBalanceDelta, applyBalanceDelta };
