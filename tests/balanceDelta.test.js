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
const { grindCommandSource } = require('./helpers/grindSources');
const {
    detachBalanceDelta, applyBalanceDelta, commitBalanceDelta, saveWithBalanceDelta,
} = require('../src/utils/balanceDelta');

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

    test('a net charge is clamped at zero rather than run through a bare $inc', async () => {
        // `$inc` walks straight past zero. A flow whose net change is a charge
        // has no more claim on funds it read seconds ago than any other debit.
        const Model = {
            updates: [],
            findOneAndUpdate: async function (filter, update) {
                this.updates.push(update);
                return { balance: 100 }; // pre-image: less than the charge
            },
        };
        const doc = makeDoc(1_000);
        const result = await applyBalanceDelta(Model, {}, doc, -400);

        // A pipeline update carrying the clamp, not `{ $inc: { balance: -400 } }`.
        expect(Array.isArray(Model.updates[0])).toBe(true);
        expect(result).toBe(0);
        expect(doc.balance).toBe(0);
    });

    test('a charge smaller than the balance takes exactly its amount', async () => {
        const Model = {
            findOneAndUpdate: async () => ({ balance: 1_000 }),
        };
        const doc = makeDoc(1_000);
        await expect(applyBalanceDelta(Model, {}, doc, -400)).resolves.toBe(600);
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

describe('commitBalanceDelta', () => {
    const failing = () => ({ findOneAndUpdate: async () => { throw new Error('connection lost'); } });

    let errorSpy;
    beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => errorSpy.mockRestore());

    test('reports success when the credit lands', async () => {
        const Model = makeModel(1_000);
        const doc = makeDoc(1_000);
        await expect(commitBalanceDelta(Model, {}, doc, 250)).resolves.toEqual({ credited: true, balance: 1_250 });
    });

    test('a zero delta is a no-op success', async () => {
        const Model = makeModel(1_000);
        const doc = makeDoc(1_000);
        await expect(commitBalanceDelta(Model, {}, doc, 0)).resolves.toEqual({ credited: true, balance: 1_000 });
        expect(Model.state.updates).toEqual([]);
    });

    test('retries before giving up', async () => {
        let calls = 0;
        const Model = {
            findOneAndUpdate: async () => {
                calls++;
                if (calls < 3) throw new Error('transient');
                return { balance: 1_250 };
            },
        };
        await expect(commitBalanceDelta(Model, {}, makeDoc(1_000), 250)).resolves.toMatchObject({ credited: true });
        expect(calls).toBe(3);
    });

    test('records the credit as owed rather than losing it', async () => {
        const FailedJob = require('../src/models/FailedJob');
        const create = jest.spyOn(FailedJob, 'create').mockResolvedValue({});

        const result = await commitBalanceDelta(failing(), { userId: 'u1', guildId: 'g1' }, makeDoc(1_000), 250, {
            service: 'fish', jobName: 'castPayout', guildId: 'g1',
        });

        expect(result.credited).toBe(false);
        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0]).toMatchObject({
            service: 'fish',
            jobName: 'castPayout',
            payload: { userId: 'u1', guildId: 'g1', delta: 250 },
        });
        create.mockRestore();
    });

    test('a dead-letter write that itself fails does not throw at the caller', async () => {
        const FailedJob = require('../src/models/FailedJob');
        const create = jest.spyOn(FailedJob, 'create').mockRejectedValue(new Error('also down'));
        await expect(commitBalanceDelta(failing(), {}, makeDoc(1_000), 250)).resolves.toMatchObject({ credited: false });
        create.mockRestore();
    });
});

describe('saveWithBalanceDelta', () => {
    /** A document that records when it was saved, relative to the credit. */
    function makeSavingDoc(balance, log, { failSave = false } = {}) {
        const doc = makeDoc(balance);
        doc.userId  = 'u1';
        doc.guildId = 'g1';
        doc.save = async () => {
            if (failSave) throw new Error('write conflict');
            log.push(`save:${doc.balance}`);
        };
        return doc;
    }

    function makeLoggingModel(stored, log) {
        return {
            state: { balance: stored },
            findOneAndUpdate: async (filter, update) => {
                log.push(`inc:${update.$inc.balance}`);
                return { balance: (stored += update.$inc.balance) };
            },
        };
    }

    test('saves without balance, then credits the change as an $inc', async () => {
        const log = [];
        const doc = makeSavingDoc(1_000, log);
        doc.balance += 250;                       // a quest completed on this message

        const result = await saveWithBalanceDelta(makeLoggingModel(1_000, log), doc, 1_000);

        // The save carries the pre-flow balance — i.e. nothing for this path —
        // and only then does the reward land.
        expect(log).toEqual(['save:1000', 'inc:250']);
        expect(result).toEqual({ credited: true, balance: 1_250 });
    });

    test('a concurrent debit during the flow survives the save', async () => {
        const log = [];
        const doc = makeSavingDoc(1_000, log);
        doc.balance += 250;
        // A casino bet placed while the handler was awaiting quest work.
        const Model = makeLoggingModel(200, log);

        await saveWithBalanceDelta(Model, doc, 1_000);

        expect(doc.balance).toBe(450);            // 200 left + the 250 reward
        expect(doc.modified.has('balance')).toBe(false);
    });

    test('addresses the credit at the document it just saved', async () => {
        const seen = [];
        const doc = makeSavingDoc(1_000, []);
        doc.balance += 10;
        await saveWithBalanceDelta({
            findOneAndUpdate: async (filter) => { seen.push(filter); return { balance: 1_010 }; },
        }, doc, 1_000);
        expect(seen).toEqual([{ userId: 'u1', guildId: 'g1' }]);
    });

    test('a failed save credits nothing and leaves the rewind in place', async () => {
        const log = [];
        const doc = makeSavingDoc(1_000, log, { failSave: true });
        doc.balance += 250;

        await expect(saveWithBalanceDelta(makeLoggingModel(1_000, log), doc, 1_000))
            .rejects.toThrow('write conflict');

        // Nothing was paid, and the caller's error branch sees the balance it
        // started with rather than a reward it never persisted.
        expect(log).toEqual([]);
        expect(doc.balance).toBe(1_000);
    });

    test('a penalty cannot push the stored balance below zero', async () => {
        // The seasonal commands (/trickortreat and friends) clamp their penalty
        // against the balance they read at the cooldown claim. If the player
        // spends between that read and this write, the clamp is stale — so the
        // commit routes a net charge through the pipeline debit, which clamps
        // again against the balance it is actually writing.
        const updates = [];
        const Model = {
            findOneAndUpdate: async (filter, update) => {
                updates.push(update);
                return { balance: 30 }; // pre-image: the player spent nearly everything
            },
        };
        const doc = makeSavingDoc(500, []);
        doc.balance = Math.max(0, doc.balance - 200);   // the trick penalty, clamped to a stale 500

        const result = await saveWithBalanceDelta(Model, doc, 500);

        expect(Array.isArray(updates[0])).toBe(true);   // pipeline clamp, not a bare $inc
        expect(result.balance).toBe(0);
        expect(doc.balance).toBe(0);
    });

    test('a flow that moved no coins issues no write', async () => {
        const log = [];
        const doc = makeSavingDoc(1_000, log);
        await saveWithBalanceDelta(makeLoggingModel(1_000, log), doc, 1_000);
        expect(log).toEqual(['save:1000']);
    });
});

// The same read-to-save window exists in every grind command, not just /fish:
// /hunt and /mine wait on approach prompts, and /explore holds an encounter
// prompt for up to 20 seconds and writes coins twice around it. All four are
// converted; these assertions are what keeps them that way.
// /fish's cast transaction was pushed into fishService (#613), so its delta
// mechanics are asserted against the service; the other three still hold the
// transaction inline in the command.
const TRANSACTION_SOURCES = {
    fish:    path.join('services', 'fishService.js'),
    hunt:    path.join('services', 'huntService.js'),
    mine:    path.join('services', 'mineService.js'),
    explore: path.join('commands', 'economy', 'explore.js'),
};

describe.each(['fish', 'hunt', 'mine', 'explore'])('/%s keeps balance out of its save', (command) => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', TRANSACTION_SOURCES[command]), 'utf8',
    );
    // Every file of the command, since /fish, /hunt and /mine are folders (#721)
    // — reading only index.js would scan the dispatch and none of the payout.
    const commandSource = grindCommandSource(command);

    test('detaches the balance and commits it as a delta', () => {
        expect(source).toMatch(/detachBalanceDelta\(user, balance(AtLoad|Baseline)\)/);
        expect(source).toMatch(/commitBalanceDelta\(User, balanceFilter, user,/);
    });

    test('the delta is committed after the save, never before', () => {
        // Credit-then-save would pay for a run a failed save lets the player take
        // again; save-then-credit at worst owes coins, which is recoverable.
        const detachAt = source.indexOf('detachBalanceDelta(user, balance');
        const saveAt   = source.indexOf('await user.save();', detachAt);
        const commitAt = source.indexOf('commitBalanceDelta(User, balanceFilter', detachAt);
        expect(detachAt).toBeGreaterThan(-1);
        expect(saveAt).toBeGreaterThan(detachAt);
        expect(commitAt).toBeGreaterThan(saveAt);
    });

    test('an uncredited payout is shown to the player, not swallowed', () => {
        expect(source).toMatch(/payoutOwed/);
        expect(commandSource).toMatch(/payoutOwed/);
        expect(commandSource).toMatch(/Payout Not Yet Credited/);
    });
});

describe('/fish uses the helper', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'services', 'fishService.js'), 'utf8',
    );

    test('a credit that will not land is surfaced, not swallowed', () => {
        // The failure mode this guards: save lands, $inc does not, and the player
        // is shown a catch they were never paid for.
        expect(source).toMatch(/payoutOwed: payout\.credited \? 0 : balanceDelta/);
    });
});
