'use strict';

/**
 * #890. `/invest` was at 11.9% statement coverage and a **branch floor of 0**.
 * It debits a wallet and adds the coins to a shared server pool, which makes it
 * a coin sink with a refund path — and the refund path is the interesting one:
 * the district is checked for "already active", the user is debited, and only
 * then does the pool `$inc` run under a filter that re-checks activation. When
 * that filter misses, the coins have already left the wallet and the command
 * has to put them back.
 *
 * That is the same shape as #868 — two writes, the second refusing, nothing
 * watching — and there was no test on it at all.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');
const { expectNonNegativeBalance } = require('./helpers/balanceInvariant');
const { useFixedClock, DEFAULT_CLOCK } = require('./helpers/fixedClock');

const mockUsers = fakeCollection('User', { balance: 0 });
const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));

const invest = require('../src/commands/economy/invest');
const { logTransaction } = require('../src/utils/logTransaction');

useFixedClock();
const NOW = new Date(DEFAULT_CLOCK).getTime();

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
const GOAL = 1_000_000;

const DISTRICT_IDS = ['marketplace', 'bank', 'underground', 'wilderness', 'arena'];

const districts = (overrides = {}) => DISTRICT_IDS.map(id => ({
    districtId: id, pool: 0, goal: GOAL, activeUntil: null, topContributors: [],
    ...(overrides[id] ?? {}),
}));

const seedGuild = (fields = {}) => mockGuilds.seed({
    guildId: GUILD_ID, name: 'Guild', economy: { currency: '💰', enabled: true },
    districts: districts(), ...fields,
});

const seedUser = (balance) => mockUsers.seed({ userId: USER_ID, guildId: GUILD_ID, balance });

const me = () => mockUsers.get(USER_ID);
const district = id => mockGuilds.get(GUILD_ID).districts.find(d => d.districtId === id);

const run = async (subcommand, options = {}) => {
    const interaction = makeInteraction({ subcommand, options, userId: USER_ID });
    await invest.execute(interaction);
    return interaction;
};

const contribute = (amount, districtId = 'marketplace') =>
    run('contribute', { district: districtId, amount });

beforeEach(() => {
    mockUsers.reset();
    mockGuilds.reset();
    jest.clearAllMocks();
});

// The refund test below replaces a model method outright, which is the only way
// to make one specific write miss. `reset()` and `clearAllMocks()` clear call
// history but leave the replacement standing, so without this the stub is
// inherited by every test after it — an order-dependent failure that only shows
// up in a full run.
const pristineGuildModel = { ...mockGuilds.model };
afterEach(() => { Object.assign(mockGuilds.model, pristineGuildModel); });

describe('/invest contribute', () => {
    it('moves the coins from the wallet into the district pool', async () => {
        seedGuild();
        seedUser(5000);

        const interaction = await contribute(1000);

        expect(me().balance).toBe(4000);
        expect(district('marketplace').pool).toBe(1000);
        expect(repliedText(interaction)).toContain('Investment Received');
        expectNonNegativeBalance(me());
    });

    it('debits under a guard rather than after a read', async () => {
        seedGuild();
        seedUser(5000);

        await contribute(1000);

        const debit = mockUsers.writes.find(w => w.update?.$inc?.balance === -1000);
        expect(debit.query.balance).toEqual({ $gte: 1000 });
    });

    it('refuses a contribution the wallet cannot cover, and takes nothing', async () => {
        seedGuild();
        seedUser(500);

        const interaction = await contribute(1000);

        expect(me().balance).toBe(500);
        expect(district('marketplace').pool).toBe(0);
        expect(repliedText(interaction)).toContain('but only have');
        expect(logTransaction).not.toHaveBeenCalled();
    });

    it('refuses a user with no account at all', async () => {
        seedGuild();

        const interaction = await contribute(1000);

        expect(repliedText(interaction)).toContain('but only have');
        expect(district('marketplace').pool).toBe(0);
    });

    it('refuses a district that is already active, before touching the wallet', async () => {
        seedGuild({
            districts: districts({ marketplace: { activeUntil: new Date(NOW + 3_600_000) } }),
        });
        seedUser(5000);

        const interaction = await contribute(1000);

        expect(repliedText(interaction)).toContain('already active');
        expect(me().balance).toBe(5000);
    });

    it('accepts a contribution to a district whose activation has expired', async () => {
        seedGuild({
            districts: districts({ marketplace: { activeUntil: new Date(NOW - 3_600_000) } }),
        });
        seedUser(5000);

        await contribute(1000);

        expect(district('marketplace').pool).toBe(1000);
        expect(me().balance).toBe(4000);
    });

    it('refuses when the economy is off', async () => {
        seedGuild({ economy: { currency: '💰', enabled: false } });
        seedUser(5000);

        const interaction = await contribute(1000);

        expect(repliedText(interaction)).toContain('economy is disabled');
        expect(me().balance).toBe(5000);
    });

    it('records the contribution as a negative wallet movement', async () => {
        seedGuild();
        seedUser(5000);

        await contribute(1000);

        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            type: 'invest', amount: -1000, balance: 4000, note: 'district:marketplace',
        }));
    });
});

describe('/invest contribute — the refund path', () => {
    it('gives the coins back when the district activates between the check and the pool write', async () => {
        // The pre-check passes, the debit commits, and then the `$inc`'s own
        // filter finds the district active — a concurrent contribution got
        // there first. The coins are out of the wallet and belong to nobody.
        seedGuild();
        seedUser(5000);

        const realFindOneAndUpdate = mockGuilds.model.findOneAndUpdate;
        mockGuilds.model.findOneAndUpdate = jest.fn(async (query, update, options) => {
            // The upsert at the top of the command still goes through; only the
            // guarded pool increment is made to miss.
            if (update?.$inc?.['districts.$.pool'] === undefined) {
                return realFindOneAndUpdate(query, update, options);
            }
            return null;
        });

        const interaction = await contribute(1000);

        expect(me().balance).toBe(5000);
        expect(district('marketplace').pool).toBe(0);
        expect(repliedText(interaction)).toContain('Coins refunded');
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            type: 'invest_refund', amount: 1000, balance: 5000,
        }));
    });
});

describe('/invest contribute — funding the goal', () => {
    it('activates the district, empties the pool and clears the contributors', async () => {
        seedGuild({ districts: districts({ arena: { pool: GOAL - 500, topContributors: [
            { userId: 'someone', username: 'someone', amount: GOAL - 500 },
        ] } }) });
        seedUser(5000);

        const interaction = await contribute(500, 'arena');

        const arena = district('arena');
        expect(arena.pool).toBe(0);
        expect(new Date(arena.activeUntil).getTime()).toBe(NOW + 7 * 24 * 3_600_000);
        expect(arena.topContributors).toEqual([]);
        expect(repliedText(interaction)).toContain('ACTIVATED');
    });

    it('announces the activation in the configured channel', async () => {
        const sent = [];
        seedGuild({
            districts: districts({ arena: { pool: GOAL - 500 } }),
            districtAnnounceChannelId: 'announce-1',
        });
        seedUser(5000);

        const interaction = makeInteraction({
            subcommand: 'contribute',
            options: { district: 'arena', amount: 500 },
            userId: USER_ID,
            channels: new Map([['announce-1', { send: async payload => { sent.push(payload); } }]]),
        });
        await invest.execute(interaction);

        expect(sent).toHaveLength(1);
        expect(sent[0].embeds[0].data.title).toContain('FUNDED');
    });

    it('does not announce into the channel the command was run in', async () => {
        const sent = [];
        seedGuild({
            districts: districts({ arena: { pool: GOAL - 500 } }),
            districtAnnounceChannelId: 'channel-1',   // the harness's own channel
        });
        seedUser(5000);

        const interaction = makeInteraction({
            subcommand: 'contribute',
            options: { district: 'arena', amount: 500 },
            userId: USER_ID,
            channels: new Map([['channel-1', { send: async payload => { sent.push(payload); } }]]),
        });
        await invest.execute(interaction);

        expect(sent).toEqual([]);
    });
});

describe('/invest contribute — top contributors', () => {
    it('adds a first-time investor', async () => {
        seedGuild();
        seedUser(5000);

        await contribute(1000);

        expect(district('marketplace').topContributors)
            .toEqual([{ userId: USER_ID, username: 'player', amount: 1000 }]);
    });

    it('accumulates a repeat investor rather than listing them twice', async () => {
        seedGuild();
        seedUser(5000);

        await contribute(1000);
        await contribute(500);

        expect(district('marketplace').topContributors).toHaveLength(1);
        expect(district('marketplace').topContributors[0].amount).toBe(1500);
        expect(district('marketplace').pool).toBe(1500);
    });

    it('keeps the list sorted and capped at ten', async () => {
        seedGuild({ districts: districts({ marketplace: { topContributors:
            Array.from({ length: 10 }, (_, i) => ({ userId: `u${i}`, username: `u${i}`, amount: 100 + i })),
        } }) });
        seedUser(50_000);

        await contribute(10_000);

        const top = district('marketplace').topContributors;
        expect(top).toHaveLength(10);
        expect(top[0]).toMatchObject({ userId: USER_ID, amount: 10_000 });
        expect(top.map(c => c.amount)).toEqual([...top.map(c => c.amount)].sort((a, b) => b - a));
    });
});

describe('/invest status', () => {
    it('lists every district with its progress', async () => {
        seedGuild({ districts: districts({ marketplace: { pool: 250_000 } }) });

        const interaction = await run('status');

        const text = repliedText(interaction);
        for (const id of DISTRICT_IDS) expect(text.toLowerCase()).toContain(id === 'bank' ? 'bank' : id);
        expect(text).toContain('25%');
    });

    it('shows an active district as active rather than as a part-filled bar', async () => {
        seedGuild({ districts: districts({
            arena: { pool: 10, activeUntil: new Date(NOW + 3 * 24 * 3_600_000) },
        }) });

        const interaction = await run('status');

        expect(repliedText(interaction)).toContain('ACTIVE');
    });

    it('names the top investors when a district has any', async () => {
        seedGuild({ districts: districts({ marketplace: { pool: 300, topContributors: [
            { userId: 'a', username: 'alice', amount: 200 },
            { userId: 'b', username: 'bob', amount: 100 },
        ] } }) });

        const interaction = await run('status');

        expect(repliedText(interaction)).toContain('alice');
        expect(repliedText(interaction)).toContain('bob');
    });

    it('fills in districts a guild document predates', async () => {
        // A guild whose document was written before a district was added has a
        // short array; the command backfills it and saves.
        seedGuild({ districts: [{ districtId: 'marketplace', pool: 0, goal: GOAL, activeUntil: null, topContributors: [] }] });

        await run('status');

        expect(mockGuilds.get(GUILD_ID).districts).toHaveLength(DISTRICT_IDS.length);
    });
});
