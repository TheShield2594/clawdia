'use strict';

// `/leaderboard economy` sorted by `{ balance: -1, bank: -1 }` while printing
// `balance + bank`, so a user who banked their coins showed a high total and
// never placed. The dashboard sorted by the real total, the weekly badge job and
// the newspaper each sorted by `balance` alone: one guild, four rankings.
//
// These tests pin the ordering the shared helper produces and check that every
// surface now goes through it, since the failure mode is not a wrong number in
// one place but two places quietly disagreeing.

const fs   = require('fs');
const path = require('path');
const { netWorthOf, topByNetWorth, netWorthRank, NET_WORTH_EXPR } = require('../src/utils/netWorth');
const { evaluate } = require('./helpers/pipelineUpdate');

// Stands in for User.aggregate over one guild, applying the stages the helper
// builds so the ordering under test is the one Mongo would produce.
function fakeUserModel(docs) {
    return {
        aggregate: async (stages) => {
            let rows = docs.filter(d => d.guildId === stages[0].$match.guildId).map(d => ({ ...d }));
            for (const stage of stages.slice(1)) {
                if (stage.$addFields) {
                    rows = rows.map(r => ({ ...r, ...Object.fromEntries(
                        Object.entries(stage.$addFields).map(([k, expr]) => [k, evaluate(expr, r)]),
                    ) }));
                } else if (stage.$sort) {
                    const [[key, dir], ...rest] = Object.entries(stage.$sort);
                    rows.sort((a, b) => {
                        if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * dir;
                        for (const [k, d] of rest) {
                            if (a[k] !== b[k]) return (a[k] < b[k] ? -1 : 1) * d;
                        }
                        return 0;
                    });
                } else if (stage.$limit) {
                    rows = rows.slice(0, stage.$limit);
                } else if (stage.$project) {
                    const keep = Object.entries(stage.$project).filter(([, v]) => v === 1).map(([k]) => k);
                    rows = rows.map(r => Object.fromEntries(keep.filter(k => k in r).map(k => [k, r[k]])));
                }
            }
            return rows;
        },
        countDocuments: async (query) => docs.filter(d => {
            if (d.guildId !== query.guildId) return false;
            const worth = evaluate(NET_WORTH_EXPR, d);
            // Either strictly richer, or level with the caller and ahead on the
            // `_id` tie-break the sort uses.
            return query.$or.some(clause => (
                clause.$expr.$gt ? worth > clause.$expr.$gt[1]
                    : worth === clause.$expr.$eq[1] && d._id < clause._id.$lt
            ));
        }).length,
    };
}

const GUILD = 'g1';
const POPULATION = [
    { _id: 1, userId: 'banker',   guildId: GUILD, balance: 10,     bank: 500_000 },
    { _id: 2, userId: 'hoarder',  guildId: GUILD, balance: 400_000, bank: 0 },
    { _id: 3, userId: 'balanced', guildId: GUILD, balance: 300_000, bank: 300_000 },
    { _id: 4, userId: 'broke',    guildId: GUILD, balance: 0,       bank: 0 },
    { _id: 5, userId: 'elsewhere', guildId: 'g2', balance: 9_000_000, bank: 0 },
];

describe('netWorthOf', () => {
    test('adds balance and bank', () => {
        expect(netWorthOf({ balance: 100, bank: 25 })).toBe(125);
    });

    test('treats missing fields and a missing user as zero', () => {
        expect(netWorthOf({ balance: 100 })).toBe(100);
        expect(netWorthOf({ bank: 100 })).toBe(100);
        expect(netWorthOf({})).toBe(0);
        expect(netWorthOf(null)).toBe(0);
    });
});

describe('topByNetWorth', () => {
    test('ranks on the total, so a bank-heavy user places above a cash-heavy one', () => {
        // The exact case the old `{ balance: -1, bank: -1 }` sort got wrong:
        // `banker` has the most coins and the least cash, and used to place last.
        return topByNetWorth(fakeUserModel(POPULATION), GUILD, 10).then(rows => {
            expect(rows.map(r => r.userId)).toEqual(['balanced', 'banker', 'hoarder', 'broke']);
        });
    });

    test('reports the total it ranked on', async () => {
        const rows = await topByNetWorth(fakeUserModel(POPULATION), GUILD, 10);
        expect(rows.find(r => r.userId === 'banker').netWorth).toBe(500_010);
    });

    test('stays inside the guild', async () => {
        const rows = await topByNetWorth(fakeUserModel(POPULATION), GUILD, 10);
        expect(rows.map(r => r.userId)).not.toContain('elsewhere');
    });

    test('honours the limit', async () => {
        const rows = await topByNetWorth(fakeUserModel(POPULATION), GUILD, 2);
        expect(rows).toHaveLength(2);
        expect(rows[0].userId).toBe('balanced');
    });

    test('breaks ties deterministically so two surfaces list the same order', async () => {
        const tied = [
            { _id: 2, userId: 'b', guildId: GUILD, balance: 50, bank: 50 },
            { _id: 1, userId: 'a', guildId: GUILD, balance: 100, bank: 0 },
            { _id: 3, userId: 'c', guildId: GUILD, balance: 0, bank: 100 },
        ];
        const first  = await topByNetWorth(fakeUserModel(tied), GUILD, 10);
        const second = await topByNetWorth(fakeUserModel([...tied].reverse()), GUILD, 10);
        expect(first.map(r => r.userId)).toEqual(['a', 'b', 'c']);
        expect(second.map(r => r.userId)).toEqual(first.map(r => r.userId));
    });
});

describe('netWorthRank', () => {
    test('agrees with the position topByNetWorth puts a user in', async () => {
        const Model = fakeUserModel(POPULATION);
        const rows = await topByNetWorth(Model, GUILD, 10);
        for (const [index, row] of rows.entries()) {
            const doc = POPULATION.find(d => d.userId === row.userId);
            expect(await netWorthRank(Model, GUILD, row.netWorth, doc._id)).toBe(index + 1);
        }
    });

    test('tied users get the ranks their rows occupy, not one shared rank', async () => {
        // The self-rank line prints directly beneath the top-ten list, so giving
        // three tied users "#1" each would contradict the three rows above it.
        const tied = [
            { _id: 3, userId: 'c', guildId: GUILD, balance: 0,   bank: 100 },
            { _id: 1, userId: 'a', guildId: GUILD, balance: 100, bank: 0 },
            { _id: 2, userId: 'b', guildId: GUILD, balance: 50,  bank: 50 },
        ];
        const Model = fakeUserModel(tied);
        const rows  = await topByNetWorth(Model, GUILD, 10);
        expect(rows.map(r => r.userId)).toEqual(['a', 'b', 'c']);

        expect(await netWorthRank(Model, GUILD, 100, 1)).toBe(1);
        expect(await netWorthRank(Model, GUILD, 100, 2)).toBe(2);
        expect(await netWorthRank(Model, GUILD, 100, 3)).toBe(3);
    });

    test('without an id, ties fall back to a shared competition rank', async () => {
        const tied = [
            { _id: 1, userId: 'a', guildId: GUILD, balance: 100, bank: 0 },
            { _id: 2, userId: 'b', guildId: GUILD, balance: 100, bank: 0 },
        ];
        expect(await netWorthRank(fakeUserModel(tied), GUILD, 100)).toBe(1);
    });

    test('a user richer than everyone ranks first', async () => {
        expect(await netWorthRank(fakeUserModel(POPULATION), GUILD, 10_000_000, 99)).toBe(1);
    });
});

describe('every wealth surface goes through the shared helper', () => {
    const read = rel => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

    // Listing them explicitly is the point: a new surface that sorts wealth its
    // own way is exactly the regression this issue was about, and adding it here
    // is the cheapest way to notice.
    const SURFACES = [
        'commands/leveling/leaderboard.js',
        'dashboard/routes/api/economy.js',
        'services/schedulerService.js',
        'services/newspaperService.js',
    ];

    test.each(SURFACES)('%s imports netWorth', (rel) => {
        expect(read(rel)).toMatch(/require\(.*utils\/netWorth.*\)/);
    });

    test.each(SURFACES)('%s no longer sorts on balance alone', (rel) => {
        expect(read(rel)).not.toMatch(/\.sort\(\{\s*balance:\s*-1/);
    });

    // Importing it proves nothing on its own — a surface could import the helper
    // and still rank its own way.
    test.each(SURFACES)('%s actually calls the shared ranking helper', (rel) => {
        expect(read(rel)).toMatch(/(topByNetWorth|netWorthRank)\(/);
    });
});
