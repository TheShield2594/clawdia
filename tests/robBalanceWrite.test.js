'use strict';

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
        if (doc) { mockUpdates.push({ userId: doc.userId, query, update }); mockApply(doc, update); }
        return {};
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
