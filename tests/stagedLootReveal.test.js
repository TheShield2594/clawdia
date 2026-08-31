'use strict';

// #917. /hunt start, /fish cast and /mine dig each carried their own copy of
// the staged reveal — the same tier thresholds, the same 1500 ms beats, the
// same embed shapes, three times over, differing only in flavour text. Nothing
// tested any of the three: each sat inside a 700-line command behind a real
// cast, and the copies could have drifted apart without anything saying so.
//
// It is one module now, and this is what pins the ladder: which tiers stage,
// how many stages each gets, and that every path ends on the caller's embed.

jest.mock('../src/utils/delay', () => ({ delay: jest.fn().mockResolvedValue(undefined) }));

const { delay } = require('../src/utils/delay');
const { stagedLootReveal, REVEAL_COPY, REVEAL_FROM_TIER, STAGE_MS } = require('../src/utils/stagedLootReveal');

const ACTIVITIES = Object.keys(REVEAL_COPY);
const FINAL = { final: true };

// The embeds this builds are real EmbedBuilders; `.data` is what they carry.
function recorder() {
    const edits = [];
    return {
        interaction: { editReply: async payload => { edits.push(payload); } },
        titles: () => edits.map(e => e.embeds[0].data?.title ?? e.embeds[0]),
        edits,
    };
}

beforeEach(() => delay.mockClear());

describe('which drops are worth staging', () => {
    test.each(ACTIVITIES)('%s: a miss and anything under rare goes straight to the result', async activity => {
        for (const tier of [null, undefined, 'common', 'uncommon']) {
            const { interaction, edits } = recorder();
            await stagedLootReveal(interaction, tier, FINAL, activity);

            expect(edits).toEqual([{ embeds: [FINAL] }]);
            expect(delay).not.toHaveBeenCalled();
        }
    });

    test.each(ACTIVITIES)('%s: rare gets the fog and nothing more', async activity => {
        const { interaction, edits, titles } = recorder();
        await stagedLootReveal(interaction, 'rare', FINAL, activity);

        expect(titles()).toEqual([REVEAL_COPY[activity].fogTitle, FINAL]);
        expect(edits).toHaveLength(2);
        expect(delay).toHaveBeenCalledTimes(1);
    });

    test.each(ACTIVITIES)('%s: epic adds the partial reveal', async activity => {
        const { interaction, titles } = recorder();
        await stagedLootReveal(interaction, 'epic', FINAL, activity);

        expect(titles()).toEqual([REVEAL_COPY[activity].fogTitle, REVEAL_COPY[activity].mid[4], FINAL]);
        expect(delay).toHaveBeenCalledTimes(2);
    });

    test.each(ACTIVITIES)('%s: legendary adds the fanfare on top', async activity => {
        const { interaction, titles } = recorder();
        await stagedLootReveal(interaction, 'legendary', FINAL, activity);

        expect(titles()).toEqual([
            REVEAL_COPY[activity].fogTitle,
            REVEAL_COPY[activity].mid[5],
            REVEAL_COPY[activity].fanfare.legendary.title,
            FINAL,
        ]);
        expect(delay).toHaveBeenCalledTimes(3);
    });

    test.each(ACTIVITIES)('%s: event tier is legendary’s shape with its own copy', async activity => {
        const { interaction, titles } = recorder();
        await stagedLootReveal(interaction, 'event', FINAL, activity);

        expect(titles()).toEqual([
            REVEAL_COPY[activity].fogTitle,
            REVEAL_COPY[activity].mid[6],
            REVEAL_COPY[activity].fanfare.event.title,
            FINAL,
        ]);
    });

    // `beforeEach` clears the mock, so this has to stage a reveal itself before
    // reading the calls — an assertion over an empty array is vacuously true and
    // would have passed for any beat at all.
    test('every stage waits the same beat', async () => {
        const { interaction } = recorder();
        await stagedLootReveal(interaction, 'legendary', FINAL, 'hunt');

        expect(delay).toHaveBeenCalledTimes(3);
        expect(STAGE_MS).toBe(1500);
        expect(delay.mock.calls.every(([ms]) => ms === STAGE_MS)).toBe(true);
    });
});

describe('the contract with the caller', () => {
    test.each(ACTIVITIES)('%s: every path ends on the caller’s embed', async activity => {
        for (const tier of [null, 'common', 'rare', 'epic', 'legendary', 'event']) {
            const { interaction, edits } = recorder();
            await stagedLootReveal(interaction, tier, FINAL, activity);
            expect(edits[edits.length - 1]).toEqual({ embeds: [FINAL] });
        }
    });

    test('an unknown activity throws rather than revealing nothing', () => {
        // The alternative is a reveal that silently skips itself, which would
        // look exactly like a common drop.
        const { interaction } = recorder();
        return expect(stagedLootReveal(interaction, 'legendary', FINAL, 'forage'))
            .rejects.toThrow(/no reveal copy for "forage"/);
    });

    test('rare is the floor, and it is the tier the ladder calls 3', () => {
        expect(REVEAL_FROM_TIER).toBe(3);
    });
});

describe('the copy tables', () => {
    test('all three grinds carry a full set', () => {
        expect(ACTIVITIES.sort()).toEqual(['fish', 'hunt', 'mine']);

        for (const [activity, copy] of Object.entries(REVEAL_COPY)) {
            expect([activity, Object.keys(copy.mid).sort()]).toEqual([activity, ['4', '5', '6']]);
            expect([activity, Object.keys(copy.fanfare).sort()]).toEqual([activity, ['event', 'legendary']]);
            for (const text of [copy.fogTitle, copy.fogText, ...Object.values(copy.mid)]) {
                expect([activity, typeof text, text.length > 0]).toEqual([activity, 'string', true]);
            }
        }
    });

    test('each grind’s flavour is its own, which is the only reason for a table', () => {
        // The legendary fanfare title is the one line all three share; every
        // other line differs, so a copy-paste that forgot to change one shows up
        // as a duplicate here.
        const fogs = ACTIVITIES.map(a => REVEAL_COPY[a].fogTitle);
        const events = ACTIVITIES.map(a => REVEAL_COPY[a].fanfare.event.title);

        expect(new Set(fogs).size).toBe(ACTIVITIES.length);
        expect(new Set(events).size).toBe(ACTIVITIES.length);
    });
});
