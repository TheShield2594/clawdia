'use strict';

/**
 * #873. `/heist` and `/syndicate` split a haul between the crew, and neither
 * could tell a share that landed from one that did not.
 *
 * `/syndicate` retried an unguarded `$inc` three times and then set
 * `credited = true` from whether the call threw — so a `findOneAndUpdate` that
 * matched no document, which does not throw, counted as a payout and walked past
 * the recovery record written for exactly that case. That record was itself
 * unreachable: `jobName: 'heist_credit'` has no `.owed` suffix, so
 * `npm run payouts:replay` never lists it, and the payload carried no `kind`, so
 * `replayOwedPayout` could not have paid it either.
 *
 * `/heist` logged a rejected payout to the console and moved on, with no record
 * anywhere, and announced the share to the channel regardless.
 *
 * Both go through the shared credit-or-owe helper now. What these pin is the
 * outcome that matters: a share that does not reach a player is written down in
 * the shape the replay understands, and the crew is told.
 */

const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, paidPayouts: [] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/Syndicate', () => ({ findOne: jest.fn(async () => null) }));
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/balanceDebit', () => ({
    ...jest.requireActual('../src/utils/balanceDebit'),
    debitUpTo: jest.fn(async () => ({ taken: 0, matched: true })),
}));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn(async () => ({})) }));
jest.mock('../src/services/syndicateService', () => ({
    activeSyndicateHeists: new Map(),
    SYNDICATE_TARGETS: { vault: { label: 'Vault', heatGain: 5 } },
    SYNDICATE_ROLES: { hacker: { emoji: '💻', label: 'Hacker' }, driver: { emoji: '🚗', label: 'Driver' } },
    createSyndicateLobby: jest.fn(),
    joinSyndicateLobby: jest.fn(),
    endSyndicateLobby: jest.fn(),
    clearSyndicateHeist: jest.fn(),
    getSyndicateHeist: jest.fn(),
    getEffectiveHeat: jest.fn(() => 0),
    computeSyndicateOutcome: jest.fn(),
}));

const Guild = require('../src/models/Guild');
const { recordOwedPayout } = require('../src/utils/owedPayout');
const { computeSyndicateOutcome } = require('../src/services/syndicateService');
const { resolveHeist: resolveCrewHeist, createLobby, joinLobby, clearHeist } =
    require('../src/services/heistService');
const { resolveHeist: resolveSyndicateHeist } = require('../src/commands/economy/syndicate').__test__;

const GUILD = 'guild-1';
const SHARE = 500;

const sentEmbeds = [];
const client = {
    guilds: {
        fetch: jest.fn(async () => ({
            channels: {
                fetch: jest.fn(async () => ({
                    isTextBased: () => true,
                    send: jest.fn(async payload => { sentEmbeds.push(payload); }),
                })),
            },
        })),
    },
};

/** Everything the resolution posted to the channel, flattened to text. */
const announced = () => sentEmbeds.flatMap(p => (p.embeds ?? []).map(e => {
    const data = e?.data ?? e;
    return [data.title, data.description, ...(data.fields ?? []).map(f => `${f.name} ${f.value}`)].join(' ');
})).join('\n');

const seed = userId => mockUsers.seed({ userId, guildId: GUILD, balance: 0 });
const balanceOf = userId => mockUsers.get(userId)?.balance;

/** A `/heist` with two crew members, both of whom passed. */
function crewHeist() {
    const heist = createLobby({
        guildId: GUILD, channelId: 'chan-1', initiatorId: 'u1',
        target: 'bank', lobbyDurationSeconds: 60, maxPayout: 1000,
    });
    joinLobby(GUILD, 'u1', 'one', 'hacker');
    joinLobby(GUILD, 'u2', 'two', 'driver');
    for (const player of heist.players.values()) player.skillPassed = true;
    return heist;
}

/** A `/syndicate` raid with the same two crew members. */
function syndicateHeist() {
    return {
        heistId: 'syn-1', syndicateId: 'syn', guildId: GUILD, channelId: 'chan-1',
        target: 'vault', sabotageCount: 0, heatAtStart: 0, resolving: false,
        players: new Map([
            ['u1', { role: 'hacker', username: 'one', skillPassed: true }],
            ['u2', { role: 'driver', username: 'two', skillPassed: true }],
        ]),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    sentEmbeds.length = 0;
    mockUsers.reset();
    clearHeist(GUILD);
    Guild.findOne.mockReturnValue({ lean: async () => ({ economy: { currency: '💰' }, heist: {} }) });
    recordOwedPayout.mockResolvedValue(true);
    computeSyndicateOutcome.mockReturnValue({
        outcome: 'full_success', payout: SHARE * 2, perPlayer: SHARE,
        passedCount: 2, totalCount: 2,
    });
});

afterEach(() => { clearHeist(GUILD); jest.restoreAllMocks(); });

describe.each([
    ['/heist',     (c, h) => resolveCrewHeist(c, h),      crewHeist,      'heistService'],
    ['/syndicate', (c, h) => resolveSyndicateHeist(c, h), syndicateHeist, 'syndicateService'],
])('%s paying the crew', (_label, resolve, makeHeist, service) => {
    test('pays every share when every crew member has a document', async () => {
        seed('u1'); seed('u2');

        await resolve(client, makeHeist());

        expect(balanceOf('u1')).toBeGreaterThan(0);
        expect(balanceOf('u2')).toBeGreaterThan(0);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('does not count a write that matched no document as a payout', async () => {
        seed('u2');   // u1 has no document in this guild

        await resolve(client, makeHeist());

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service,
            guildId: GUILD,
            payload: expect.objectContaining({
                kind: 'coins', userId: 'u1', guildId: GUILD,
                payoutKey: expect.stringMatching(/^crew:/),
            }),
        }));
    });

    test('still pays the rest of the crew', async () => {
        seed('u2');

        await resolve(client, makeHeist());

        expect(balanceOf('u2')).toBeGreaterThan(0);
    });

    test('tells the channel whose share did not arrive', async () => {
        seed('u2');

        await resolve(client, makeHeist());

        expect(announced()).toContain('one');
        expect(announced()).toMatch(/recorded|logged for recovery/);
    });

    test('records a share that every attempt rejected', async () => {
        seed('u1'); seed('u2');
        const store = mockUsers.model.findOneAndUpdate.getMockImplementation();
        mockUsers.model.findOneAndUpdate.mockImplementation(async (filter, update, options) => {
            // The credit is the only pipeline update either resolution issues.
            if (Array.isArray(update)) throw new Error('mongo is down');
            return store(filter, update, options);
        });

        await resolve(client, makeHeist());

        expect(recordOwedPayout).toHaveBeenCalledTimes(2);
        mockUsers.model.findOneAndUpdate.mockImplementation(store);
    });
});
