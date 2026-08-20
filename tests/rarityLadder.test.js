'use strict';

const {
    TIER_NUM, TIER_RIBBON, TIER_LABELS, TIER_STARS, TIER_COLORS,
} = require('../src/data/materialRarity');
const { ORES_BY_TIER, TIER_COLORS: MINE_TIER_COLORS } = require('../src/data/mineData');

// hunt, fish and mine all roll an `event` tier above legendary. It was missing from
// TIER_NUM, so every presentation path that keys off the ladder — the rarity ribbon,
// the staged loot reveal, the rare-drop announcement — fell through to its `?? 0` or
// `?? 1` default and rendered the rarest drops in the game as common.
const LADDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'event'];

describe('rarity ladder', () => {
    test('covers every tier the grind systems can roll', () => {
        expect(Object.keys(TIER_NUM).sort()).toEqual([...LADDER].sort());
    });

    test('numbers the tiers in ascending rarity with no gaps', () => {
        expect(LADDER.map(t => TIER_NUM[t])).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test('event outranks legendary', () => {
        expect(TIER_NUM.event).toBeGreaterThan(TIER_NUM.legendary);
    });

    test('every rung has a label, stars and a colour', () => {
        for (const tier of LADDER) {
            const n = TIER_NUM[tier];
            expect(TIER_LABELS[n]).toBeTruthy();
            expect(TIER_STARS[n]).toBeTruthy();
            expect(TIER_COLORS[n]).toMatch(/^#[0-9a-f]{6}$/i);
        }
    });

    test('the ribbon marks the tier it was given and shows the whole ladder', () => {
        for (const tier of LADDER) {
            const ribbon = TIER_RIBBON(TIER_NUM[tier]);
            expect(ribbon.split(' ─ ')).toHaveLength(LADDER.length);
            expect(ribbon).toMatch(/\[.+\]/);
        }
    });

    test('an event drop is not rendered as a common one', () => {
        expect(TIER_RIBBON(TIER_NUM.event)).not.toEqual(TIER_RIBBON(TIER_NUM.common));
    });

    // The two colour tables are independently tuned and have never matched rung for
    // rung; only the event rung added here is pinned to the mine palette.
    test('the event rung uses the same colour the mine embeds already use', () => {
        expect(TIER_COLORS[TIER_NUM.event].toLowerCase())
            .toBe(MINE_TIER_COLORS.event.toLowerCase());
    });

    test('every mine ore sits on a rung of the ladder', () => {
        for (const tier of Object.keys(ORES_BY_TIER)) {
            expect(TIER_NUM[tier]).toBeDefined();
        }
    });
});
