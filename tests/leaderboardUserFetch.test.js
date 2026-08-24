'use strict';

// #588: rendering one ten-name leaderboard page cost ten serial Discord API
// round trips, because each row awaited its own client.users.fetch(). Nothing
// in the loop depends on the previous row, so they go out together.

jest.mock('discord.js', () => ({
    SlashCommandBuilder: jest.fn().mockImplementation(() => {
        const self = {
            setName: jest.fn().mockReturnThis(),
            setDescription: jest.fn().mockReturnThis(),
            addStringOption: jest.fn().mockReturnThis(),
            addChoices: jest.fn().mockReturnThis(),
            setRequired: jest.fn().mockReturnThis(),
        };
        return self;
    }),
    EmbedBuilder: jest.fn().mockImplementation(() => {
        const self = {
            data: {},
            setColor: jest.fn().mockReturnThis(),
            setTitle: jest.fn().mockReturnThis(),
            setDescription: jest.fn().mockImplementation(d => { self.data.description = d; return self; }),
            setFooter: jest.fn().mockReturnThis(),
            setTimestamp: jest.fn().mockReturnThis(),
        };
        return self;
    }),
    MessageFlags: { Ephemeral: 64 },
}));

jest.mock('../src/models/User', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));

const User = require('../src/models/User');
const leaderboard = require('../src/commands/leveling/leaderboard');

function makeUsers(n) {
    return Array.from({ length: n }, (_, i) => ({
        userId: `u${i}`, level: 10 - i, xp: 100 - i,
    }));
}

// User.find(...).select(...).sort(...).limit(...).lean() resolves to the rows.
// `select` is recorded: #586 is that these rows used to arrive as full user
// documents, pets and inventories included, to print ten names.
const seen = {};
function mockRows(rows) {
    const chain = {
        select(fields) { seen.select = fields; return chain; },
        sort() { return chain; },
        limit() { return chain; },
        lean: async () => rows,
    };
    User.find.mockReturnValue(chain);
}

/**
 * A users.fetch() that records how many calls were outstanding at once, so the
 * test can tell a parallel batch from a serial chain rather than just counting.
 */
function makeTracingFetch({ resolve = id => ({ id, tag: `${id}#0` }) } = {}) {
    let inFlight = 0;
    const trace = { peakConcurrency: 0, calls: 0 };
    const fetch = jest.fn(async id => {
        trace.calls++;
        inFlight++;
        trace.peakConcurrency = Math.max(trace.peakConcurrency, inFlight);
        await new Promise(r => setImmediate(r));
        inFlight--;
        const value = resolve(id);
        if (value === null) throw new Error('Unknown User');
        return value;
    });
    return { fetch, trace };
}

function makeInteraction(fetch) {
    return {
        options: { getString: () => 'levels' },
        guild: { id: 'g1', name: 'Test Guild' },
        user: { id: 'caller' },
        client: { users: { fetch } },
        reply: jest.fn().mockResolvedValue(undefined),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    // No caller row, so the "you are here" tail is skipped.
    User.findOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    User.countDocuments.mockResolvedValue(0);
});

describe('leaderboard row rendering', () => {
    it('issues all ten user fetches together instead of one at a time', async () => {
        mockRows(makeUsers(10));
        const { fetch, trace } = makeTracingFetch();

        await leaderboard.execute(makeInteraction(fetch));

        expect(trace.calls).toBe(10);
        expect(trace.peakConcurrency).toBe(10);
    });

    it('reads only the fields the rows print', async () => {
        mockRows(makeUsers(10));
        const { fetch } = makeTracingFetch();

        await leaderboard.execute(makeInteraction(fetch));

        expect(seen.select).toBe('userId level xp');
    });

    it('still renders every row in rank order', async () => {
        mockRows(makeUsers(3));
        const { fetch } = makeTracingFetch();
        const interaction = makeInteraction(fetch);

        await leaderboard.execute(interaction);

        const { description } = interaction.reply.mock.calls[0][0].embeds[0].data;
        expect(description).toContain('🥇 u0#0 — Level 10');
        expect(description).toContain('🥈 u1#0 — Level 9');
        expect(description).toContain('🥉 u2#0 — Level 8');
    });

    it('skips a user Discord cannot resolve without dropping the others', async () => {
        mockRows(makeUsers(3));
        const { fetch } = makeTracingFetch({
            resolve: id => (id === 'u1' ? null : { id, tag: `${id}#0` }),
        });
        const interaction = makeInteraction(fetch);

        await leaderboard.execute(interaction);

        const { description } = interaction.reply.mock.calls[0][0].embeds[0].data;
        expect(description).toContain('u0#0');
        expect(description).not.toContain('u1#0');
        // The medal still comes from the row's rank, not its printed position.
        expect(description).toContain('🥉 u2#0');
    });
});
