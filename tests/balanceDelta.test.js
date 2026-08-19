'use strict';

// `/fish` read the user, waited 2–5s for a bite, ran a 2–3s reel-in collector,
// and then `save()`d — writing `balance` as an absolute `$set` computed from a
// value read roughly eight seconds earlier. Spend coins during the reel-in
// prompt and the cast's save put them back: place a casino bet in another
// channel while the prompt is up and the bet is refunded for free. The required
// reel-in miss made it worse, restoring a whole pre-cast snapshot.
//
// The fix keeps `balance` out of the save entirely and applies the cast's net
// change as an atomic `$inc`. These tests drive that helper directly, including
// the interleaving that used to lose the concurrent write.

const fs   = require('fs');
const path = require('path');
const { detachBalanceDelta, applyBalanceDelta } = require('../src/utils/balanceDelta');

/** Minimal stand-in for the parts of a mongoose document these helpers touch. */
function makeDoc(balance) {
    return {
        balance,
        modified: new Set(['balance']),
        unmarkModified(path) { this.modified.delete(path); },
        markModified(path) { this.modified.add(path); },
    };
}

/** A Model whose stored balance can be moved out from under the flow. */
function makeModel(stored) {
    const state = { balance: stored, updates: [] };
    return {
        state,
        findOneAndUpdate: async (filter, update) => {
            state.updates.push(update);
            state.balance += update.$inc.balance;
            return { balance: state.balance };
        },
    };
}

describe('detachBalanceDelta', () => {
    test('returns the net change the flow made', () => {
        const doc = makeDoc(1_000);
        doc.balance += 250;
        expect(detachBalanceDelta(doc, 1_000)).toBe(250);
    });

    test('rewinds the document so a save writes nothing for balance', () => {
        const doc = makeDoc(1_000);
        doc.balance += 250;
        detachBalanceDelta(doc, 1_000);
        expect(doc.balance).toBe(1_000);
        expect(doc.modified.has('balance')).toBe(false);
    });

    test('a flow that reversed its own reward produces no write at all', () => {
        // The required reel-in miss restores every pre-cast field. That path used
        // to write an eight-second-old absolute balance; now it nets to zero.
        const doc = makeDoc(1_000);
        const preCast = doc.balance;
        doc.balance += 5_000;   // executeCast credits the payout
        doc.balance = preCast;  // the fish escapes and the payout is reversed
        expect(detachBalanceDelta(doc, 1_000)).toBe(0);
        expect(doc.modified.has('balance')).toBe(false);
    });

    test('a penalty is carried as a negative delta', () => {
        const doc = makeDoc(1_000);
        doc.balance -= 400;
        expect(detachBalanceDelta(doc, 1_000)).toBe(-400);
    });

    test('treats a missing balance as zero rather than producing NaN', () => {
        const doc = makeDoc(undefined);
        expect(detachBalanceDelta(doc, 0)).toBe(0);
    });
});

describe('applyBalanceDelta', () => {
    test('issues no write when nothing changed', async () => {
        const Model = makeModel(1_000);
        const doc = makeDoc(1_000);
        await applyBalanceDelta(Model, {}, doc, 0);
        expect(Model.state.updates).toEqual([]);
    });

    test('applies the change as a relative $inc, never an absolute $set', async () => {
        const Model = makeModel(1_000);
        const doc = makeDoc(1_000);
        await applyBalanceDelta(Model, {}, doc, 250);
        expect(Model.state.updates).toEqual([{ $inc: { balance: 250 } }]);
    });

    test('a concurrent spend during the reel-in window survives the cast', async () => {
        // The reproduction from the issue: read 1000, wait, bet 800 elsewhere,
        // then land a 250-coin catch. The answer is 450, not the 1250 an
        // absolute write would have produced.
        const Model = makeModel(1_000);
        const doc = makeDoc(1_000);

        doc.balance += 250;                 // the cast's payout, in memory
        Model.state.balance -= 800;         // a casino bet placed in another channel

        const delta = detachBalanceDelta(doc, 1_000);
        const result = await applyBalanceDelta(Model, {}, doc, delta);

        expect(result).toBe(450);
        expect(Model.state.balance).toBe(450);
    });

    test('refreshes the document with the authoritative post-write balance', async () => {
        const Model = makeModel(1_000);
        const doc = makeDoc(1_000);
        Model.state.balance -= 800;
        await applyBalanceDelta(Model, {}, doc, 250);
        expect(doc.balance).toBe(450);
    });

    test('leaves balance unmarked so a later save cannot write it back', async () => {
        // /fish saves a second time on the escape path; that save must not undo
        // the $inc by writing the in-memory value as a $set.
        const Model = makeModel(1_000);
        const doc = makeDoc(1_000);
        await applyBalanceDelta(Model, {}, doc, 250);
        expect(doc.modified.has('balance')).toBe(false);
    });

    test('falls back to local arithmetic when the update matches no document', async () => {
        const Model = { findOneAndUpdate: async () => null };
        const doc = makeDoc(1_000);
        await expect(applyBalanceDelta(Model, {}, doc, 250)).resolves.toBe(1_250);
    });

    test('two flows overlapping on one user both land', async () => {
        const Model = makeModel(1_000);
        const fishing = makeDoc(1_000);
        const mining  = makeDoc(1_000);

        fishing.balance += 300;
        mining.balance  += 700;

        // Interleaved the way two commands would be: both read the same balance
        // before either writes.
        const fishDelta = detachBalanceDelta(fishing, 1_000);
        const mineDelta = detachBalanceDelta(mining, 1_000);
        await applyBalanceDelta(Model, {}, fishing, fishDelta);
        await applyBalanceDelta(Model, {}, mining, mineDelta);

        expect(Model.state.balance).toBe(2_000);
    });
});

describe('/fish uses the helper', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'commands', 'economy', 'fish.js'), 'utf8',
    );

    test('the cast captures a balance reading and applies a delta', () => {
        expect(source).toMatch(/detachBalanceDelta\(user, balanceAtLoad\)/);
        expect(source).toMatch(/applyBalanceDelta\(User, balanceFilter, user, balanceDelta\)/);
    });

    test('the delta is applied after the save, not before it', () => {
        const saveAt   = source.indexOf('const balanceDelta = detachBalanceDelta');
        const applyAt  = source.indexOf('applyBalanceDelta(User, balanceFilter');
        const userSave = source.indexOf('await user.save();', saveAt);
        expect(saveAt).toBeGreaterThan(-1);
        expect(userSave).toBeGreaterThan(saveAt);
        expect(applyAt).toBeGreaterThan(userSave);
    });
});
