'use strict';

/**
 * #836. The newspaper's sections as a registry.
 *
 * The paper reported on six things because adding a seventh meant editing three
 * functions in step — the query, the block for the model, and the plain-text
 * rendering — so nothing was ever added and the paper covered a fraction of the
 * bot. Each section is one entry now, and these pin the two properties that
 * makes worth having: a section still switches off exactly the way the original
 * six did, and one broken query costs its own section rather than the paper.
 */

jest.mock('../src/models/User', () => ({ find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock('../src/models/Case', () => ({ countDocuments: jest.fn() }));
jest.mock('../src/models/Transaction', () => ({ find: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/AiItem', () => ({ find: jest.fn() }));
jest.mock('../src/models/AiQuest', () => ({ find: jest.fn() }));
jest.mock('../src/models/WeeklyChampion', () => ({ find: jest.fn() }));
jest.mock('../src/utils/netWorth', () => ({ topByNetWorth: jest.fn(async () => []) }));

const User = require('../src/models/User');
const Case = require('../src/models/Case');
const Transaction = require('../src/models/Transaction');
const GrindProfile = require('../src/models/GrindProfile');
const AiItem = require('../src/models/AiItem');
const AiQuest = require('../src/models/AiQuest');
const WeeklyChampion = require('../src/models/WeeklyChampion');
const { topByNetWorth } = require('../src/utils/netWorth');

const {
    SIGNALS, collectSignals, signalUserIds, buildDataSummary, buildSections
} = require('../src/services/newspaper/signals');

/** A find()-style chain that resolves to `docs`. */
function chain(docs) {
    const c = { sort: () => c, limit: () => c, select: () => c, lean: async () => docs };
    return c;
}

let warnLog;

beforeEach(() => {
    jest.clearAllMocks();
    warnLog = jest.spyOn(console, 'warn').mockImplementation(() => {});

    topByNetWorth.mockResolvedValue([]);
    User.find.mockReturnValue(chain([]));
    User.countDocuments.mockResolvedValue(0);
    User.aggregate.mockResolvedValue([]);
    Case.countDocuments.mockResolvedValue(0);
    Transaction.find.mockReturnValue(chain([]));
    GrindProfile.findOne.mockReturnValue(chain(null));
    AiItem.find.mockReturnValue(chain([]));
    AiQuest.find.mockReturnValue(chain([]));
    WeeklyChampion.find.mockReturnValue(chain([]));
});

afterEach(() => warnLog.mockRestore());

const guildDoc = (over = {}) => ({ guildId: 'g1', name: 'Home', ...over });
const context = { names: { u1: 'Ann', u2: 'Ben' }, currency: '💰' };

describe('collecting the signals', () => {
    test('runs every section a guild has not switched off', async () => {
        const data = await collectSignals({ guildId: 'g1', guildDoc: guildDoc(), sections: {} });

        // Every signal reported something, even if that something is "nothing".
        expect(Object.keys(data).sort()).toEqual(SIGNALS.map(s => s.id).sort());
    });

    test('and skips the ones it has, without querying for them', async () => {
        const data = await collectSignals({
            guildId: 'g1', guildDoc: guildDoc(),
            sections: { topEarners: false, casinoHighlights: false },
        });

        expect(data.topEarners).toBeUndefined();
        expect(data.casinoHighlights).toBeUndefined();
        expect(topByNetWorth).not.toHaveBeenCalled();
        expect(Transaction.find).not.toHaveBeenCalled();
        // The rest still ran.
        expect(data.levelUps).toEqual([]);
    });

    // Eleven queries behind one weekly embed: a bad collection must cost its own
    // section and not the guild's paper.
    test('a query that throws costs its section and nothing else', async () => {
        Case.countDocuments.mockRejectedValue(new Error('collection gone'));

        const data = await collectSignals({ guildId: 'g1', guildDoc: guildDoc(), sections: {} });

        expect(data.moderationDigest).toBeUndefined();
        expect(data.levelUps).toEqual([]);
        expect(warnLog).toHaveBeenCalledWith(expect.stringMatching(/moderationDigest/));
    });

    test('everything is read against the same week', async () => {
        await collectSignals({ guildId: 'g1', guildDoc: guildDoc(), sections: {} });

        const modSince = Case.countDocuments.mock.calls[0][0].createdAt.$gte;
        const memberSince = User.countDocuments.mock.calls[0][0].createdAt.$gte;
        expect(modSince.getTime()).toBe(memberSince.getTime());
        expect(Date.now() - modSince.getTime()).toBeCloseTo(7 * 24 * 3600_000, -4);
    });
});

describe('resolving the names', () => {
    test('gathers every id the collected signals want, once each', async () => {
        topByNetWorth.mockResolvedValue([{ userId: 'u1', netWorth: 10 }]);
        Transaction.find.mockReturnValue(chain([{ userId: 'u2', type: 'gamble', amount: 5 }]));
        AiItem.find.mockReturnValue(chain([{ name: 'Sunblade', createdBy: 'u1' }]));

        const data = await collectSignals({ guildId: 'g1', guildDoc: guildDoc(), sections: {} });

        expect(signalUserIds(data).sort()).toEqual(['u1', 'u2']);
    });

    test('and asks for none when nothing happened', async () => {
        const data = await collectSignals({ guildId: 'g1', guildDoc: guildDoc(), sections: {} });
        expect(signalUserIds(data)).toEqual([]);
    });
});

describe('the two renderings', () => {
    test('a quiet week still tells the model it was quiet at the tables', () => {
        const summary = buildDataSummary({ casinoHighlights: [] }, context);
        expect(summary).toMatch(/A quiet week at the tables/);
        // But prints no casino section in the paper, which would be an empty
        // heading.
        expect(buildSections({ casinoHighlights: [] }, context)).toEqual([]);
    });

    test('a section with data prints a heading and its lines', () => {
        const blocks = buildSections({ topEarners: [{ userId: 'u1', netWorth: 4200 }] }, context);

        expect(blocks).toHaveLength(1);
        expect(blocks[0][0]).toMatch(/Top Earners/);
        expect(blocks[0][1]).toMatch(/Ann/);
        expect(blocks[0][1]).toMatch(/4,200/);
    });

    test('a counted section reads correctly at one and at none', () => {
        expect(buildDataSummary({ moderationDigest: 1 }, context)).toMatch(/1 action taken/);
        expect(buildDataSummary({ moderationDigest: 0 }, context)).toMatch(/0 actions taken/);
        expect(buildDataSummary({ newMembers: 1 }, context)).toMatch(/1 new member joined/);
    });

    test('and an unknown user is named rather than left blank', () => {
        const summary = buildDataSummary({ topEarners: [{ userId: 'nobody', netWorth: 1 }] }, context);
        expect(summary).toMatch(/Unknown/);
    });

    test('sections the guild switched off contribute to neither', () => {
        expect(buildDataSummary({}, context)).toBe('');
        expect(buildSections({}, context)).toEqual([]);
    });
});

// ── The signals the paper never had ────────────────────────────────────────

describe('the war report', () => {
    const query = SIGNALS.find(s => s.id === 'warReport').query;
    const signal = SIGNALS.find(s => s.id === 'warReport');

    test('says nothing when the server has never fought one', () => {
        expect(query({ guildDoc: guildDoc() })).toBeNull();
        expect(signal.render(null, context)).toEqual([]);
    });

    test('calls a finished war', () => {
        const war = query({ guildDoc: guildDoc({ activeWar: { status: 'ended', myScore: 100, opponentScore: 40, opponentGuildName: 'Away' } }) });

        expect(signal.brief(war, context)).toMatch(/we won/);
        expect(signal.render(war, context)[0]).toMatch(/War Report/);
        expect(signal.render(war, context)[0]).toMatch(/100 — 40/);
    });

    test('and reports one still being fought as such', () => {
        const war = query({ guildDoc: guildDoc({ activeWar: { status: 'active', myScore: 10, opponentScore: 90, opponentGuildName: 'Away' } }) });

        expect(signal.brief(war, context)).toMatch(/WAR IN PROGRESS/);
        expect(signal.render(war, context)[0]).toMatch(/still running/);
    });

    test('a draw is a draw', () => {
        const war = query({ guildDoc: guildDoc({ activeWar: { status: 'ended', myScore: 50, opponentScore: 50, opponentGuildName: 'Away' } }) });
        expect(signal.brief(war, context)).toMatch(/a draw/);
    });
});

describe('the forge', () => {
    const signal = SIGNALS.find(s => s.id === 'legendaryForges');

    test('credits the item and whoever forged it', () => {
        const rows = [{ name: 'Sunblade', emoji: '🗡️', rarity: 'Mythic', createdBy: 'u1' }];

        expect(signal.userIds(rows)).toEqual(['u1']);
        expect(signal.brief(rows, context)).toMatch(/Sunblade \(Mythic\) — forged by Ann/);
        expect(signal.render(rows, context)[0]).toMatch(/🗡️ \*\*Sunblade\*\* — forged by Ann/);
    });

    test('and stays quiet on a week nobody forged anything', () => {
        expect(signal.brief([], context)).toBeFalsy();
        expect(signal.render([], context)).toEqual([]);
    });
});

describe('the quest log', () => {
    const signal = SIGNALS.find(s => s.id === 'questLog');

    // Completions live in an array on each user, so this is one row per
    // completion rather than one per player.
    test('counts completions across the whole server', async () => {
        User.aggregate.mockResolvedValue([{ total: 17 }]);
        AiQuest.find.mockReturnValue(chain([{ name: 'The Sunken Bell', emoji: '🔔', mechanic: 'explore' }]));

        const data = await signal.query({ guildId: 'g1', since: new Date(0) });

        expect(data.completed).toBe(17);
        expect(signal.brief(data, context)).toMatch(/17 quests completed/);
        expect(signal.render(data, context).join('\n')).toMatch(/The Sunken Bell/);
    });

    test('an empty aggregate is nought, not undefined', async () => {
        const data = await signal.query({ guildId: 'g1', since: new Date(0) });

        expect(data.completed).toBe(0);
        expect(signal.brief(data, context)).toBeFalsy();
        expect(signal.render(data, context)).toEqual([]);
    });
});

describe('last week\'s champions', () => {
    const signal = SIGNALS.find(s => s.id === 'championBoard');

    test('reads only the rows the sweep actually crowned', async () => {
        await signal.query({ guildId: 'g1' });

        const [filter] = WeeklyChampion.find.mock.calls[0];
        expect(filter.rewarded).toBe(true);
        expect(filter.guildId).toBe('g1');
        expect(filter.week).toMatch(/^\d{4}-W\d{2}$/);
    });

    test('and prints them', () => {
        const rows = [{ category: 'mine', username: 'Ann', userId: 'u1', total: 900, runs: 4 }];

        expect(signal.brief(rows, context)).toMatch(/mine: Ann — 900 over 4 runs/);
        expect(signal.render(rows, context)[0]).toMatch(/👑 \*\*Ann\*\* — mine/);
    });
});

describe('market watch', () => {
    const signal = SIGNALS.find(s => s.id === 'priceMovers');
    const day = 24 * 3600_000;
    const since = new Date(Date.now() - 7 * day);

    const shopItem = (over = {}) => ({
        name: 'Lantern',
        currentPrice: 150,
        priceHistory: [
            { at: new Date(Date.now() - 6 * day), price: 100 },
            { at: new Date(Date.now() - day), price: 130 },
        ],
        ...over,
    });

    test('says nothing at all when the guild does not price dynamically', () => {
        const doc = guildDoc({ dynamicPricing: { enabled: false }, shop: [shopItem()] });
        expect(signal.query({ guildDoc: doc, since })).toEqual([]);
    });

    test('reports the move against where the week opened', () => {
        const doc = guildDoc({ dynamicPricing: { enabled: true }, shop: [shopItem()] });
        const movers = signal.query({ guildDoc: doc, since });

        expect(movers).toEqual([{ name: 'Lantern', change: 50, price: 150 }]);
        expect(signal.render(movers, context)[0]).toMatch(/📈 \*\*Lantern\*\* \+50%/);
    });

    test('a fall reads as a fall', () => {
        const doc = guildDoc({
            dynamicPricing: { enabled: true },
            shop: [shopItem({ currentPrice: 60 })],
        });
        expect(signal.render(signal.query({ guildDoc: doc, since }), context)[0]).toMatch(/📉 \*\*Lantern\*\* -40%/);
    });

    // A price that drifted two percent is not news, and printing it would push
    // the ones that are out of the section.
    test('ignores a price that barely moved', () => {
        const doc = guildDoc({
            dynamicPricing: { enabled: true },
            shop: [shopItem({ currentPrice: 102 })],
        });
        expect(signal.query({ guildDoc: doc, since })).toEqual([]);
    });

    test('and an item with no history this week has no opening price to compare', () => {
        const doc = guildDoc({
            dynamicPricing: { enabled: true },
            shop: [shopItem({ priceHistory: [{ at: new Date(Date.now() - 30 * day), price: 100 }] })],
        });
        expect(signal.query({ guildDoc: doc, since })).toEqual([]);
    });

    test('the biggest movers come first, and only three of them', () => {
        const doc = guildDoc({
            dynamicPricing: { enabled: true },
            shop: [
                shopItem({ name: 'A', currentPrice: 110 }),
                shopItem({ name: 'B', currentPrice: 300 }),
                shopItem({ name: 'C', currentPrice: 20 }),
                shopItem({ name: 'D', currentPrice: 140 }),
            ],
        });
        const movers = signal.query({ guildDoc: doc, since });

        expect(movers).toHaveLength(3);
        expect(movers.map(m => m.name)).toEqual(['B', 'C', 'D']);
    });
});
