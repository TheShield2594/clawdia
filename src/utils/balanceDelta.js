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

const { debitUpTo } = require('./balanceDebit');
const { delay } = require('./delay');
const FailedJob = require('../models/FailedJob');

const CREDIT_ATTEMPTS = 3;

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
 * Applies `delta` and refreshes `user.balance` with the authoritative post-write
 * value, so anything rendered afterwards shows the real number rather than the
 * flow's private arithmetic. The path is left unmarked: a later `save()` in the
 * same flow must not write this value back as a `$set`.
 *
 * A negative delta goes through the clamped debit rather than a bare `$inc`.
 * `$inc` runs straight past zero, and a flow whose net change is a charge has no
 * more claim on funds it read seconds ago than any other debit does — the same
 * reasoning as src/utils/balanceDebit.js, which this defers to.
 *
 * Returns the resulting balance.
 */
async function applyBalanceDelta(Model, filter, user, delta) {
    if (!delta) return user.balance ?? 0;

    if (delta < 0) {
        const { balance, matched } = await debitUpTo(Model, filter, -delta, {});
        user.balance = matched ? balance : Math.max(0, (user.balance ?? 0) + delta);
        user.unmarkModified('balance');
        return user.balance;
    }

    const bumped = await Model.findOneAndUpdate(
        filter,
        { $inc: { balance: delta } },
        { new: true, projection: { balance: 1 } },
    );

    user.balance = bumped ? bumped.balance : (user.balance ?? 0) + delta;
    user.unmarkModified('balance');
    return user.balance;
}

/**
 * `applyBalanceDelta` with somewhere for the failure to go.
 *
 * Folding the coin movement out of `save()` split one write into two, and a
 * second write can fail on its own: the save lands, the `$inc` does not, and the
 * player is shown a successful catch they were never paid for. Logging that to
 * the console and carrying on makes the coins disappear silently, which is the
 * one outcome an economy cannot afford.
 *
 * There is no transaction to reach for — the deployment is a standalone mongod,
 * so `save()` and the `$inc` cannot be made one write. What is available is a
 * retry and a durable record: the dead-letter queue in src/utils/jobRunner.js
 * already exists for work that has to happen but did not, and is replayable from
 * the dashboard. So the credit is retried, and if it still will not land it is
 * written down as owed rather than lost.
 *
 * Returns `{ credited, balance }`. A false `credited` means the caller must not
 * present the flow as fully successful — the amount is recorded, not paid.
 */
async function commitBalanceDelta(Model, filter, user, delta, context = {}) {
    if (!delta) return { credited: true, balance: user.balance ?? 0 };

    let lastError = null;
    for (let attempt = 1; attempt <= CREDIT_ATTEMPTS; attempt++) {
        try {
            return { credited: true, balance: await applyBalanceDelta(Model, filter, user, delta) };
        } catch (err) {
            lastError = err;
            if (attempt < CREDIT_ATTEMPTS) await delay(attempt * 250);
        }
    }

    console.error(`[${context.service ?? 'balance'}] credit of ${delta} failed after ${CREDIT_ATTEMPTS} attempts:`, lastError?.message);

    await FailedJob.create({
        service:      context.service ?? 'balanceDelta',
        jobName:      context.jobName ?? 'applyBalanceDelta',
        guildId:      context.guildId ?? null,
        payload:      { ...filter, delta },
        errorMessage: lastError?.message ?? 'unknown error',
        errorStack:   lastError?.stack ?? null,
        lastAttemptAt: new Date(),
    }).catch(err => console.error('[balanceDelta] could not record the owed credit:', err.message));

    return { credited: false, balance: user.balance ?? 0 };
}

module.exports = { detachBalanceDelta, applyBalanceDelta, commitBalanceDelta };
