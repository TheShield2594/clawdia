'use strict';

const { expectNonNegativeBalance } = require('./helpers/balanceInvariant');

// /rob used to write the robber's balance as an absolute $set guarded only by a
// lastRob compare-and-set — so any credit landing between the read and the write
// was silently erased. The victim side of the same function already used deltas.
// These tests assert both sides now write deltas.

let mockStore;   // userId -> document
let mockUpdates; // ordered log of { userId, query, update }
let mockBeforeWrite; // optional hook: fires just before an update is applied

function mockFindDoc(query) {
    const doc = mockStore[query.userId];
    return doc && doc.guildId === query.guildId ? doc : null;
}

// Only the guard shapes rob.js builds.
function mockGuardsPass(doc, query) {
    if (query.lastRob !== undefined && String(doc.lastRob ?? '') !== String(query.lastRob ?? '')) return false;
    if (query.balance?.$gte !== undefined && (doc.balance ?? 0) < query.balance.$gte) return false;
    if (query.bank?.$gte !== undefined && (doc.bank ?? 0) < query.bank.$gte) return false;
    const trapAfter = query['trap.expiresAt']?.$gt;
    if (trapAfter !== undefined && !(doc.trap?.expiresAt && new Date(doc.trap.expiresAt) > trapAfter)) return false;
    if (query.$or) {
        const ok = query.$or.some((clause) => {
            if ('lastRob' in clause) return clause.lastRob === null ? (doc.lastRob ?? null) === null : true;
            if ('lastRobbedAt' in clause) {
                if (clause.lastRobbedAt === null) return (doc.lastRobbedAt ?? null) === null;
                const before = clause.lastRobbedAt.$lte;
                return doc.lastRobbedAt && new Date(doc.lastRobbedAt) <= before;
            }
            return true;
        });
        if (!ok) return false;
    }
    return true;
}

function mockApply(doc, update) {
    // Aggregation-pipeline update: [{ $set: { field: { $max: [0, { $add: [...] }] } } }]
    if (Array.isArray(update)) {
        for (const [field, expr] of Object.entries(update[0].$set)) {
            const delta = expr.$max[1].$add[1];
            doc[field] = Math.max(0, (doc[field] ?? 0) + delta);
        }
        return;
    }
    for (const [path, value] of Object.entries(update.$set ?? {})) {
        if (path.includes('.')) continue; // nested trap/effect paths are not asserted here
        doc[path] = value;
    }
    for (const [path, delta] of Object.entries(update.$inc ?? {})) {
        doc[path] = (doc[path] ?? 0) + delta;
    }
}

jest.mock('../src/models/User', () => ({
    findOne: jest.fn((query) => {
        const doc = mockFindDoc(query);
        const copy = doc ? { ...doc } : null;
        return { lean: async () => copy, then: (res, rej) => Promise.resolve(copy).then(res, rej) };
    }),
    findOneAndUpdate: jest.fn(async (query, update = {}, options = {}) => {
        let doc = mockFindDoc(query);
        if (!doc && options.upsert) {
            doc = { userId: query.userId, guildId: query.guildId, balance: 0, bank: 0, inventory: [], activeEffects: [], pets: [] };
            mockStore[query.userId] = doc;
        }
        if (Object.keys(update).length && mockBeforeWrite) mockBeforeWrite(query, update);
        if (!doc || !mockGuardsPass(doc, query)) return null;
        if (Object.keys(update).length) {
            mockUpdates.push({ userId: doc.userId, query, update });
            mockApply(doc, update);
        }
        return { ...doc };
    }),
    updateOne: jest.fn(async (query, update = {}) => {
        const doc = mockFindDoc(query);
        if (Object.keys(update).length && mockBeforeWrite) mockBeforeWrite(query, update);
        if (!doc || !mockGuardsPass(doc, query)) return { matchedCount: 0 };
        mockUpdates.push({ userId: doc.userId, query, update });
        mockApply(doc, update);
        return { matchedCount: 1 };
    }),
}));

jest.mock('../src/models/Guild', () => ({
    findOne: jest.fn(async () => ({ guildId: 'g1', economy: { currency: '💰', enabled: true, robEnabled: true, robMinWallet: 100, robFailFineRate: 0.2 } })),
}));

jest.mock('../src/services/effectsService', () => ({
    hasEffect: jest.fn(() => false),
    consumeEffect: jest.fn(),
    timeRemaining: jest.fn(() => '0m'),
}));

jest.mock('../src/services/achievementService', () => ({
    checkAndAward: jest.fn(async () => []),
    announceAchievements: jest.fn(),
}));

jest.mock('../src/services/petService', () => ({ getTotalBonus: jest.fn(() => 0) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));

const robCommand = require('../src/commands/economy/rob.js');

const OLD_ACCOUNT = Date.now() - 365 * 24 * 60 * 60 * 1000;

function buildInteraction() {
    const state = { replies: [], editReplies: [] };
    const interaction = {
        guild: { id: 'g1' },
        guildId: 'g1',
        user: { id: 'robber', username: 'robber', createdTimestamp: OLD_ACCOUNT },
        member: {},
        client: {},
        options: { getUser: () => ({ id: 'victim', username: 'victim', bot: false, createdTimestamp: OLD_ACCOUNT }) },
        reply: jest.fn(async (p) => { state.replies.push(p); }),
        editReply: jest.fn(async (p) => { state.editReplies.push(p); }),
        replied: false,
        deferred: false,
    };
    return { interaction, state };
}

function robberWrite() {
    return mockUpdates.find(u => u.userId === 'robber');
}

beforeEach(() => {
    mockUpdates = [];
    mockBeforeWrite = null;
    mockStore = {
        robber: { userId: 'robber', guildId: 'g1', balance: 1000, bank: 0, lastRob: null, successfulRobs: 0, failedRobs: 0, inventory: [], activeEffects: [], pets: [] },
        victim: { userId: 'victim', guildId: 'g1', balance: 5000, bank: 0, lastRobbedAt: null, inventory: [], activeEffects: [], pets: [] },
    };
    jest.clearAllMocks();
    jest.spyOn(Math, 'random').mockReturnValue(0.2); // < 0.40 success chance, min steal roll
});

afterEach(() => { Math.random.mockRestore(); });

test('a successful rob credits the robber with $inc, never an absolute $set', async () => {
    const { interaction } = buildInteraction();
    await robCommand.execute(interaction);

    const write = robberWrite();
    expect(write).toBeTruthy();
    expect(write.update.$set).not.toHaveProperty('balance');
    expect(write.update.$inc.balance).toBeGreaterThan(0);
    expect(write.update.$inc.successfulRobs).toBe(1);
    expect(write.update.$set.lastRob).toBeInstanceOf(Date);
});

test("a credit landing mid-heist survives the robber's write", async () => {
    // A payout lands after the command read the robber but before it commits.
    const original = mockStore.robber.balance;
    let injected = false;
    mockBeforeWrite = (query, update) => {
        if (!injected && query.userId === 'robber' && update.$inc?.balance !== undefined) {
            injected = true;
            mockStore.robber.balance += 750;
        }
    };

    const { interaction } = buildInteraction();
    await robCommand.execute(interaction);

    expect(injected).toBe(true);
    const stolen = robberWrite().update.$inc.balance;
    // The delta write preserves the concurrent credit; an absolute $set of the
    // stale (read + stolen) value would have thrown the 750 away.
    expect(mockStore.robber.balance).toBe(original + 750 + stolen);
});

test('a failed rob debits the robber with a guarded $inc', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.99); // above the 0.40 success chance
    const { interaction } = buildInteraction();
    await robCommand.execute(interaction);

    const write = robberWrite();
    expect(write.update.$set).not.toHaveProperty('balance');
    expect(write.update.$inc.balance).toBeLessThan(0);
    expect(write.update.$inc.failedRobs).toBe(1);
    // The lastRob CAS says nothing about balance, so the debit carries its own guard.
    expect(write.query.balance.$gte).toBe(-write.update.$inc.balance);
});

test('the victim write stays a delta too', async () => {
    const { interaction } = buildInteraction();
    await robCommand.execute(interaction);

    const victimWrite = mockUpdates.find(u => u.userId === 'victim' && u.update.$inc);
    expect(victimWrite.update.$set).not.toHaveProperty('balance');
    expect(victimWrite.update.$inc.balance).toBeLessThan(0);
});

describe('rollback when the victim write fails', () => {
    // Force the victim update to find nothing, which is what drives the compensator.
    function blockVictimWrite() {
        mockBeforeWrite = (query) => {
            if (query.userId === 'victim') mockStore.victim.lastRobbedAt = new Date();
        };
    }

    test('the reversal is clamped so spending mid-heist cannot go negative', async () => {
        // Success path: the robber is credited, so the reversal is a debit. If the
        // robber spends the haul before the compensator runs, a raw $inc of
        // -stolen would leave a negative balance.
        blockVictimWrite();
        const priorHook = mockBeforeWrite;
        mockBeforeWrite = (query, update) => {
            priorHook(query, update);
            // The clamped reversal is a pipeline update — drain right before it.
            if (Array.isArray(update) && query.userId === 'robber') {
                mockStore.robber.balance = 0;
            }
        };

        const { interaction } = buildInteraction();
        await robCommand.execute(interaction).catch(() => {});

        expect(mockStore.robber.balance).toBe(0);
        expect(mockStore.robber.balance).toBeGreaterThanOrEqual(0);
    });

    test('the cooldown slot is only handed back while it is still ours', async () => {
        blockVictimWrite();
        const { interaction } = buildInteraction();
        await robCommand.execute(interaction).catch(() => {});

        const restore = mockUpdates.find(u => u.update.$set && 'lastRob' in u.update.$set && u.userId === 'robber' && u.query.lastRob !== undefined);
        expect(restore).toBeTruthy();
        // The restore is conditional on the value this attempt wrote.
        expect(restore.query.lastRob).toBeInstanceOf(Date);
        expect(mockStore.robber.lastRob).toBeNull(); // handed back
    });

    test('a rob that started after ours keeps its cooldown', async () => {
        blockVictimWrite();
        const { interaction } = buildInteraction();
        const foreign = new Date(Date.now() + 5_000);
        const origBefore = mockStore.robber.balance;

        // Another rob wins the slot after our write but before the compensator.
        const priorHook = mockBeforeWrite;
        mockBeforeWrite = (query, update) => {
            priorHook(query, update);
            if (query.userId === 'robber' && update.$set && 'lastRob' in update.$set && query.lastRob !== undefined) {
                mockStore.robber.lastRob = foreign;
            }
        };

        await robCommand.execute(interaction).catch(() => {});

        expect(mockStore.robber.lastRob).toBe(foreign);   // not stomped
        expect(mockStore.robber.balance).toBe(origBefore); // balance still reversed
    });
});

// Every /rob outcome moves coins between two users; neither side may end below zero.
afterEach(() => {
    expectNonNegativeBalance(mockStore, 'rob');
});
