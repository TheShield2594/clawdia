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
 * `context.payoutKey` makes the credit exactly-once (#807). Without one this
 * path is at-least-once, and knowingly so: the record it writes below is filed
 * against a credit whose write may have committed and merely lost its response,
 * so replaying it can pay twice. With one, the key travels in the owed payload
 * and the replay's own credit is guarded by it, so a second application moves no
 * coins. It is caller-supplied because only the caller knows what makes this
 * credit the same credit — a quest id, a mission id, the interaction id — and a
 * key invented here would be different on every attempt and guard nothing.
 *
 * Credits only. A negative delta is a charge, goes through the clamped debit,
 * and is not replayable in the first place; a key on one would be inert.
 *
 * Returns `{ credited, balance }`. A false `credited` means the caller must not
 * present the flow as fully successful — the amount is recorded, not paid.
 */
async function commitBalanceDelta(Model, filter, user, delta, context = {}) {
    if (!delta) return { credited: true, balance: user.balance ?? 0 };

    const payoutKey = delta > 0 ? (context.payoutKey || null) : null;

    let lastError = null;
    for (let attempt = 1; attempt <= CREDIT_ATTEMPTS; attempt++) {
        try {
            if (!payoutKey) {
                return { credited: true, balance: await applyBalanceDelta(Model, filter, user, delta) };
            }

            const { creditCoinsOnce } = require('./payoutKey');
            const { status, doc } = await creditCoinsOnce(filter, delta, payoutKey, {
                Model, projection: { balance: 1 },
            });

            // 'duplicate' is a success: an earlier attempt landed and only its
            // response was lost. 'missing' is not — there is no document to
            // credit, and unlike the unkeyed path above (which cannot tell)
            // this one knows, so it records the payout rather than reporting a
            // credit that never happened.
            if (status === 'paid' || status === 'duplicate') {
                if (doc) {
                    user.balance = doc.balance;
                    user.unmarkModified('balance');
                }
                return { credited: true, balance: user.balance ?? 0 };
            }

            lastError = new Error(
                status === 'missing'
                    ? `no user document to credit (${JSON.stringify(filter)})`
                    : `credit matched nothing but ${payoutKey} is absent`,
            );
            // A missing document will still be missing on the next attempt, so
            // there is nothing to retry — go straight to recording it as owed.
            if (status === 'missing') break;
        } catch (err) {
            lastError = err;
        }
        if (attempt < CREDIT_ATTEMPTS) await delay(attempt * 250);
    }

    console.error(`[${context.service ?? 'balance'}] credit of ${delta} failed after ${CREDIT_ATTEMPTS} attempts:`, lastError?.message);

    // With a key the credit is replayable, so it is filed the way every other
    // replayable payout is — suffixed job name, a `replayOwedPayout` payload,
    // and the key itself — which is also what puts it in front of
    // `npm run payouts:replay`. The keyless record below predates that and is
    // left as it was: it carries no `kind`, so the replay script would not know
    // how to pay it even if it could see it.
    if (payoutKey) {
        const { recordOwedPayout } = require('./owedPayout');
        await recordOwedPayout({
            service:  context.service ?? 'balanceDelta',
            jobName:  context.jobName ?? 'applyBalanceDelta',
            guildId:  context.guildId ?? filter.guildId ?? null,
            payload:  {
                kind:      'coins',
                userId:    filter.userId,
                guildId:   filter.guildId,
                amount:    delta,
                payoutKey,
            },
            error: lastError,
        });
        return { credited: false, balance: user.balance ?? 0 };
    }

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

/**
 * The whole read-mutate-save shape in one call, for the many flows that load a
 * user, let a service credit it (a quest completion, a streak milestone, a
 * mission reward) and then save.
 *
 * `balanceAtLoad` is the balance the flow started from — capture it before the
 * first mutation, not after. The save runs first for the same reason as in
 * `commitBalanceDelta`, and its failure propagates: nothing has been credited at
 * that point, so the caller's existing error handling is still correct.
 *
 * `context` is passed through to `commitBalanceDelta`, `payoutKey` included, so
 * a caller that can name this credit gets the exactly-once guarantee here too.
 *
 * Returns `{ credited, balance }` from the credit, or `{ credited: true }` with
 * the untouched balance when the flow moved no coins at all.
 */
async function saveWithBalanceDelta(Model, user, balanceAtLoad, context = {}) {
    const delta = detachBalanceDelta(user, balanceAtLoad);
    await user.save();
    return commitBalanceDelta(
        Model,
        { userId: user.userId, guildId: user.guildId },
        user,
        delta,
        context,
    );
}

module.exports = { detachBalanceDelta, applyBalanceDelta, commitBalanceDelta, saveWithBalanceDelta };
