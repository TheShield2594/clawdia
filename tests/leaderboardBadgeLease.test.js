'use strict';

// The weekly leaderboard-badge job leases each guild before awarding, so two
// shards cannot both hand out the 👑 badges. Its filter carried two `$or` keys
// in one object literal — the cadence check and the lease check — and the
// second silently replaced the first, because a duplicate key in a JS object
// literal is the last one wins. Only the lease was ever evaluated, so the job
// would re-award as soon as a five-minute lease lapsed rather than once a week.
//
// Found by the linter added in #714, which is the point of having one.

jest.mock('discord.js', () => ({
    EmbedBuilder: class {
        setColor() { return this; }
        setTitle() { return this; }
        setDescription() { return this; }
        setFooter() { return this; }
        setTimestamp() { return this; }
    },
}));

jest.mock('../src/models/Guild', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ find: jest.fn(), aggregate: jest.fn(), updateOne: jest.fn(), bulkWrite: jest.fn() }));

const Guild = require('../src/models/Guild');
const { awardWeeklyLeaderboardBadges } = require('../src/services/schedulerService');

/** Every condition in the lease filter, flattened out of any $and wrapper. */
function conditions(filter) {
    return (filter.$and || []).concat(
        Object.entries(filter)
            .filter(([key]) => key !== '$and')
            .map(([key, value]) => ({ [key]: value }))
    );
}

function fieldsChecked(filter) {
    return conditions(filter)
        .flatMap(clause => (clause.$or || [clause]))
        .flatMap(clause => Object.keys(clause))
        .sort();
}

describe('weekly leaderboard badge lease', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Guild.find.mockReturnValue({ lean: async () => [{ guildId: 'g1', name: 'Guild', economy: {} }] });
        // Refusing the lease ends the job for that guild, which is all these
        // assertions need — the filter has already been built by then.
        Guild.findOneAndUpdate.mockResolvedValue(null);
    });

    it('checks the weekly cadence as well as the lease', async () => {
        await awardWeeklyLeaderboardBadges({});

        expect(Guild.findOneAndUpdate).toHaveBeenCalledTimes(1);
        const [filter] = Guild.findOneAndUpdate.mock.calls[0];

        expect(fieldsChecked(filter)).toEqual([
            'badgesAwardLeaseAt',
            'badgesAwardLeaseAt',
            'badgesLastAwardedAt',
            'badgesLastAwardedAt',
            'guildId',
        ]);
    });

    // Two conditions that share a key can only both survive under $and — as
    // sibling keys of one object, the second overwrites the first.
    it('carries the two $or conditions as separate clauses', async () => {
        await awardWeeklyLeaderboardBadges({});

        const [filter] = Guild.findOneAndUpdate.mock.calls[0];
        expect(conditions(filter).filter(clause => clause.$or)).toHaveLength(2);
    });

    it('leases only a guild whose current lease has lapsed', async () => {
        await awardWeeklyLeaderboardBadges({});

        const [filter, update] = Guild.findOneAndUpdate.mock.calls[0];
        const lease = conditions(filter).find(clause =>
            (clause.$or || []).some(part => 'badgesAwardLeaseAt' in part));

        expect(lease.$or).toContainEqual({ badgesAwardLeaseAt: null });
        expect(update.$set.badgesAwardLeaseAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('leases only a guild whose badges are at least a week old', async () => {
        await awardWeeklyLeaderboardBadges({});

        const [filter] = Guild.findOneAndUpdate.mock.calls[0];
        const cadence = conditions(filter).find(clause =>
            (clause.$or || []).some(part => 'badgesLastAwardedAt' in part));

        expect(cadence).toBeDefined();
        const weekAgo = cadence.$or.find(part => part.badgesLastAwardedAt?.$lte).badgesLastAwardedAt.$lte;
        const ageMs = Date.now() - weekAgo.getTime();
        expect(ageMs).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 5000);
        expect(ageMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 5000);
    });
});
