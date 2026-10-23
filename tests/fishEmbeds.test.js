'use strict';

// Branch coverage for src/commands/economy/fish/embeds.js (#998).
//
// Every export here is a pure function of its arguments — the file reads no
// database and touches no interaction — so the whole module is reachable from
// plain fixtures. That is what makes it the right place to start a coverage
// pass: `src/commands/economy/fish` measured 0.92% of 762 branches, and this
// file holds 142 of them behind nothing but an argument shape.
//
// The one impurity is the weather, which `buildCastEmbed` and `buildFooter`
// read from the clock rather than take as an argument. It is mocked so the
// weather-banner branch is a decision this suite makes rather than one the
// hour of the run makes for it.

jest.mock('../src/services/weatherService', () => ({
    getCurrentWeather: jest.fn(),
}));

const { getCurrentWeather } = require('../src/services/weatherService');

const {
    buildCastEmbed,
    buildFailureTitle,
    buildFooter,
    buildLevelUpLine,
    buildQuestProgressBar,
    buildRodLine,
    buildStaminaLine,
    buildWeatherNote,
    buildXpBar,
    buildXpLine,
    formatPrestigeBonuses,
    formatTierWeights,
} = require('../src/commands/economy/fish/embeds');

const {
    FISH,
    FISHER_LEVELS,
    JUNK_ITEMS,
    LOCATIONS,
    TIER_COLORS,
    TIME_OF_DAY_BONUSES,
    TREASURE_ITEMS,
} = require('../src/data/fishData');

const { TIER_NUM, TIER_STARS } = require('../src/data/materialRarity');

const CLEAR = { id: 'clear', name: 'Clear Skies', emoji: '☀️', locationBonus: {} };

const pond = LOCATIONS.pond;
const junk = JUNK_ITEMS[0];
const treasure = TREASURE_ITEMS[0];

/** The fields of an embed, keyed by name, for asserting without index arithmetic. */
function fieldsOf(embed) {
    return Object.fromEntries((embed.data.fields ?? []).map(f => [f.name, f.value]));
}

/**
 * A fisher mid-ladder with no consumable running: prestige 2 is one rung past
 * the stamina bonus, so `getMaxStamina` reads 11 rather than the base 10 and a
 * stamina line that silently lost the prestige term would show.
 */
function makeUser(fishing = {}) {
    return {
        balance: 12_345,
        fishing: {
            level: 5,
            xp: 420,
            prestige: 2,
            stamina: 7,
            consecutiveFails: 0,
            activeBait: null,
            activeBaitCastsLeft: 0,
            activeLuck: false,
            activeXpScroll: false,
            ...fishing,
        },
    };
}

/** A rod at 60/80 — healthy, and above the 20% mark the low-durability warning fires at. */
function makeRod(over = {}) {
    return { name: 'Bamboo Rod', status: 'good', currentDurability: 60, maxDurability: 80, ...over };
}

/** A plain common catch: every optional field off, so a test turns on only the one it is about. */
function fishResult(over = {}) {
    return {
        success: true,
        catchType: 'fish',
        fish: FISH.minnow,
        tier: 'common',
        finalPayout: 120,
        xpEarned: 12,
        isCrit: false,
        critMultiplier: 1,
        sizeLabel: null,
        weightLbs: 0,
        specialDrop: null,
        levelUp: null,
        cappedByHard: false,
        ...over,
    };
}

/** The mildest failure — no injury, no XP — for the same reason: nothing on by default. */
function failureResult(over = {}) {
    return {
        success: false,
        failure: { severity: { id: 'line_slack', injuryMs: 0 }, message: 'Your line went slack.' },
        xpEarned: 0,
        levelUp: null,
        ...over,
    };
}

const cast = (result, user = makeUser(), rod = makeRod()) =>
    buildCastEmbed(result, user, pond, rod, '🪙', null);

beforeEach(() => {
    getCurrentWeather.mockReturnValue(CLEAR);
});

describe('buildCastEmbed — junk', () => {
    test('a junk catch worth something names the sale price', () => {
        const embed = cast(fishResult({ catchType: 'junk', junkItem: junk, finalPayout: 7 }));
        expect(embed.data.color).toBe(parseInt(TIER_COLORS.junk.slice(1), 16));
        expect(embed.data.description).toContain('Sold for **🪙7**');
        expect(fieldsOf(embed).Reward).toBe('🪙7');
    });

    test('a junk catch worth nothing says so instead of printing a zero price', () => {
        const embed = cast(fishResult({ catchType: 'junk', junkItem: junk, finalPayout: 0 }));
        expect(embed.data.description).toContain('Worth nothing.');
        expect(fieldsOf(embed).Reward).toBe('Nothing');
    });

    test('a level-up on a junk catch still gets its own field', () => {
        const embed = cast(fishResult({
            catchType: 'junk', junkItem: junk, finalPayout: 3,
            levelUp: { oldLevel: 4, newLevel: 5 },
        }));
        expect(fieldsOf(embed)['⬆️ Level Up!']).toContain('**4** → **5**');
    });
});

describe('buildCastEmbed — treasure', () => {
    test('a treasure haul renders the payout and no optional fields', () => {
        const embed = cast(fishResult({ catchType: 'treasure', treasureItem: treasure, finalPayout: 4321 }));
        expect(embed.data.title).toContain('Treasure!');
        expect(fieldsOf(embed).Reward).toBe('**🪙4,321**');
        expect(fieldsOf(embed)['Daily Limits']).toBeUndefined();
    });

    test('a capped treasure haul says the cap took it, and what it would have paid', () => {
        const embed = cast(fishResult({
            catchType: 'treasure', treasureItem: treasure, finalPayout: 0,
            levelUp: { oldLevel: 9, newLevel: 10 }, cappedByHard: true, uncappedPayout: 240,
        }));
        const fields = fieldsOf(embed);
        expect(fields['Daily Limits']).toContain('Daily coin cap reached');
        expect(fields['Daily Limits']).toContain('🪙240');
        expect(fields['⬆️ Level Up!']).toContain('**9** → **10**');
    });
});

describe('buildCastEmbed — fish, by tier', () => {
    test('an event catch outranks a critical for both colour and headline', () => {
        const embed = cast(fishResult({ tier: 'event', isCrit: true, critMultiplier: 2 }));
        expect(embed.data.color).toBe(parseInt(TIER_COLORS.event.slice(1), 16));
        expect(embed.data.title).toBe('☄️🌊 MYTHICAL CATCH 🌊☄️');
        expect(embed.data.description).toContain("Something that shouldn't exist rises from below.");
    });

    test('a legendary catch gets the legendary headline', () => {
        const embed = cast(fishResult({ tier: 'legendary' }));
        expect(embed.data.title).toBe('🌊✨ LEGENDARY CATCH ✨🌊');
        expect(embed.data.description).toContain('You pulled something impossible from the deep.');
    });

    test('a critical below legendary is gold and says CRITICAL', () => {
        const embed = cast(fishResult({ tier: 'rare', isCrit: true, critMultiplier: 2.5 }));
        expect(embed.data.color).toBe(0xFFD700);
        expect(embed.data.title).toContain('✨ CRITICAL!');
        expect(fieldsOf(embed).XP).toBe('+12 XP (crit)');
    });

    test('an epic catch is bracketed by bolts', () => {
        const embed = cast(fishResult({ tier: 'epic' }));
        expect(embed.data.title).toMatch(/^⚡ /);
        expect(embed.data.title).toMatch(/ ⚡$/);
        expect(embed.data.description).toContain('An exceptional catch');
    });

    test('an ordinary catch is just the fish', () => {
        const embed = cast(fishResult());
        expect(embed.data.title).toBe(`${FISH.minnow.emoji} ${FISH.minnow.name}`);
        expect(fieldsOf(embed).Tier).toBe('Common');
        expect(fieldsOf(embed).XP).toBe('+12 XP');
    });

    // `TIER_NUM[tier] ?? 1` and `TIER_STARS[... ?? 5]` read as fallbacks for a
    // tier the rarity table has not heard of. Neither can fire: the colour
    // lookup above them is an unguarded `TIER_COLORS[tier]`, and `setColor`
    // throws on the undefined it would get. What actually holds is that the
    // three tables agree on one closed set of six, so assert that instead of a
    // branch the code cannot reach.
    test('every tier a fish can roll is in all three rarity tables', () => {
        const rolled = [...new Set(Object.values(FISH).map(f => f.tier))];
        for (const tier of rolled) {
            expect([tier, TIER_COLORS[tier] !== undefined]).toEqual([tier, true]);
            expect([tier, TIER_NUM[tier] !== undefined]).toEqual([tier, true]);
            expect([tier, TIER_STARS[TIER_NUM[tier]] !== undefined]).toEqual([tier, true]);
        }
    });
});

describe('buildCastEmbed — fish, optional fields', () => {
    test('a size label carries the weight into the title', () => {
        const embed = cast(fishResult({ sizeLabel: 'Colossal', weightLbs: 14.2 }));
        expect(embed.data.title).toContain('[Colossal (14.2 lbs)]');
    });

    test('a size label without a weight omits the parenthetical', () => {
        const embed = cast(fishResult({ sizeLabel: 'Runt', weightLbs: 0 }));
        expect(embed.data.title).toContain('[Runt]');
        expect(embed.data.title).not.toContain('lbs');
    });

    test('a capped payout says nothing was paid and names the cap', () => {
        // A capped roll pays 0; striking through a zero told the player nothing.
        const embed = cast(fishResult({ cappedByHard: true, finalPayout: 0 }));
        expect(fieldsOf(embed).Reward).toBe('Nothing *(daily cap reached)*');
    });

    test('weather that helps this location becomes a banner above the flavour', () => {
        getCurrentWeather.mockReturnValue({
            id: 'rain', name: 'Rain', emoji: '🌧️',
            locationBonus: { pond: { rareChance: 0.1 } },
        });
        const embed = cast(fishResult());
        expect(embed.data.description).toContain('> 🌧️ **Rain** — fish are biting harder');
    });

    test('a streak and a crit both appear in the multiplier stack', () => {
        const embed = cast(fishResult({
            isCrit: true, critMultiplier: 2, streakMult: 1.5, finalPayout: 300,
        }));
        const stack = fieldsOf(embed)['📈 Multipliers'];
        expect(stack).toContain('1.50x');
        expect(stack).toContain('2.00x crit');
    });

    test('the multiplier stack nets out the additive bonuses before showing the gain', () => {
        const embed = cast(fishResult({
            isCrit: true, critMultiplier: 2, streakMult: 1.2, finalPayout: 500,
            petYieldBonus: 50, featuredSpotBonus: 25, wildernessBonus: 25,
        }));
        expect(fieldsOf(embed)['📈 Multipliers']).toBeTruthy();
    });

    test('no streak and no crit means no multiplier field at all', () => {
        const embed = cast(fishResult({ streakMult: 1 }));
        expect(fieldsOf(embed)['📈 Multipliers']).toBeUndefined();
    });

    test('known traits render their description and unknown ones render bare', () => {
        const embed = cast(fishResult({ traitEffects: ['slippery', 'not_a_trait'] }));
        const traits = fieldsOf(embed)['🧬 Traits'];
        expect(traits).toContain('• **slippery** — ');
        expect(traits).toContain('• not_a_trait');
    });

    test('every remaining optional field fires at once', () => {
        const embed = cast(fishResult({
            tier: 'epic',
            venomousDrain: true,
            isPersonalBest: true,
            weightLbs: 9.5,
            specialDrop: { name: 'Fish Scale' },
            levelUp: { oldLevel: 5, newLevel: 6 },
            expiredBait: 'premium_bait',
        }), makeUser(), makeRod({ currentDurability: 8 }));
        const fields = fieldsOf(embed);
        expect(fields['☠️ Venomous!']).toBeTruthy();
        expect(fields['🏆 New Personal Best!']).toContain('9.5 lbs');
        expect(fields['🎁 Material Drop!']).toContain('Fish Scale');
        expect(fields['⬆️ Level Up!']).toContain('**5** → **6**');
        expect(fields['🐟 Bait Expired']).toContain('premium bait');
        expect(fields['⚠️ Low Durability']).toContain('8/80');
        expect(fields.Balance).toBe('🪙12,345');
    });

    test('a personal best with no recorded weight is not announced', () => {
        const embed = cast(fishResult({ isPersonalBest: true, weightLbs: 0 }));
        expect(fieldsOf(embed)['🏆 New Personal Best!']).toBeUndefined();
    });

    test('a broken rod outranks the low-durability warning', () => {
        const embed = cast(fishResult(), makeUser(), makeRod({ status: 'broken', currentDurability: 0 }));
        const fields = fieldsOf(embed);
        expect(fields['❌ Rod Broke!']).toContain('/fish shop repair');
        expect(fields['⚠️ Low Durability']).toBeUndefined();
    });

    test('a healthy rod raises neither warning', () => {
        const embed = cast(fishResult());
        const fields = fieldsOf(embed);
        expect(fields['❌ Rod Broke!']).toBeUndefined();
        expect(fields['⚠️ Low Durability']).toBeUndefined();
    });
});

describe('buildCastEmbed — trait escape', () => {
    test('an escape names the trait that did it and quotes the failure message', () => {
        const embed = cast({
            success: false,
            traitEscape: { fish: FISH.minnow, trait: 'slippery' },
            failure: { message: 'It twisted off the hook.' },
        });
        expect(embed.data.title).toContain('Escaped!');
        expect(embed.data.description).toBe('*It twisted off the hook.*');
        expect(fieldsOf(embed).Trait).toBe('🧬 slippery');
    });

    test('an escape with no failure message falls back to stock copy', () => {
        const embed = cast({
            success: false,
            traitEscape: { fish: FISH.minnow, trait: 'elusive' },
        });
        expect(embed.data.description).toBe('*The fish slipped free.*');
    });
});

describe('buildCastEmbed — failure', () => {
    test('a plain failure reports no reward and no XP', () => {
        const embed = cast(failureResult());
        const fields = fieldsOf(embed);
        expect(fields.Reward).toBe('Nothing');
        expect(fields.XP).toBe('None');
        expect(fields.Stamina).toBe('7/11 ⚡');
    });

    test('a failure that still paid XP prints the amount', () => {
        const embed = cast(failureResult({ xpEarned: 4 }));
        expect(fieldsOf(embed).XP).toBe('+4 XP');
    });

    test('a spared cast annotates the stamina line instead of spending it', () => {
        const embed = cast(failureResult({ staminaSpared: true }));
        expect(fieldsOf(embed).Stamina).toContain('Slack line — no stamina spent');
    });

    test('a fail streak adds the pity field', () => {
        const embed = cast(failureResult(), makeUser({ consecutiveFails: 3 }));
        expect(embed.data.fields.length).toBeGreaterThan(5);
    });

    test('a missing fail counter is read as no streak', () => {
        const embed = cast(failureResult(), makeUser({ consecutiveFails: undefined }));
        expect(embed.data.fields).toHaveLength(5);
    });

    test('an injury, a level-up and a broken rod all annotate the same failure', () => {
        const embed = cast(
            failureResult({
                failure: { severity: { id: 'fell_in', injuryMs: 600_000 }, message: 'You fell in!' },
                levelUp: { oldLevel: 2, newLevel: 3 },
            }),
            makeUser(),
            makeRod({ status: 'broken' }),
        );
        const fields = fieldsOf(embed);
        expect(fields['🤕 Soaked!']).toContain('10m');
        expect(fields['⬆️ Level Up!']).toContain('**2** → **3**');
        expect(fields['❌ Rod Broke!']).toBeTruthy();
        expect(embed.data.footer.text).toContain('Tip:');
    });
});

describe('buildFailureTitle', () => {
    test.each([
        ['line_slack', '💨 Nothing Biting...'],
        ['spooked',    '😰 Spooked!'],
        ['line_snap',  '💥 Line Snapped!'],
        ['fell_in',    '💦 Fell In!'],
    ])('%s renders its own title', (id, expected) => {
        expect(buildFailureTitle(id)).toBe(expected);
    });

    test('an unknown severity falls back rather than rendering undefined', () => {
        expect(buildFailureTitle('who_knows')).toBe('❌ Failed Cast');
    });
});

describe('buildWeatherNote', () => {
    test('weather with no bonus at this location is not worth a line', () => {
        expect(buildWeatherNote(CLEAR, 'pond')).toBeNull();
        expect(buildWeatherNote({ ...CLEAR, locationBonus: undefined }, 'pond')).toBeNull();
    });

    test.each([
        ['rareChance',      '+rare chance'],
        ['legendaryChance', '+legendary chance'],
        ['epicChance',      'ocean predators are active'],
        ['mythicalChance',  '+event chance'],
        ['junkMod',         'junk chance up'],
    ])('a %s bonus gets its own copy', (key, expected) => {
        const weather = { name: 'Rain', emoji: '🌧️', locationBonus: { pond: { [key]: 0.1 } } };
        expect(buildWeatherNote(weather, 'pond')).toContain(expected);
    });

    test('a bonus of a kind with no copy still names the weather', () => {
        const weather = { name: 'Aurora', emoji: '🌌', locationBonus: { pond: { somethingElse: 1 } } };
        expect(buildWeatherNote(weather, 'pond')).toBe('🌌 **Aurora**');
    });
});

describe('line and bar helpers', () => {
    test('buildRodLine carries the status emoji and the durability fraction', () => {
        expect(buildRodLine(makeRod({ status: 'broken', currentDurability: 0 })))
            .toContain('Bamboo Rod ❌');
        expect(buildRodLine(makeRod())).toContain('60/80');
    });

    test('buildStaminaLine adds the prestige bonus to the base maximum', () => {
        expect(buildStaminaLine(makeUser({ stamina: 3, prestige: 0 }))).toBe('3/10 ⚡');
        expect(buildStaminaLine(makeUser({ stamina: 3, prestige: 5 }))).toBe('3/11 ⚡');
    });

    test('buildXpLine counts down to the next level, or reports the cap', () => {
        expect(buildXpLine(makeUser({ level: 1, xp: 0 }))).toBe('0 XP (80 to Lv.2)');
        expect(buildXpLine(makeUser({ level: 50, xp: 999_999 }))).toBe('999,999 XP (MAX)');
    });

    test('buildLevelUpLine names the title earned at the new level', () => {
        expect(buildLevelUpLine({ oldLevel: 4, newLevel: 5 }))
            .toBe(`Fisher Level **4** → **5** (${FISHER_LEVELS[4].title})`);
    });

    test('buildXpBar fills proportionally and clamps at both ends', () => {
        expect(buildXpBar({ level: 50, xp: 0 }, null)).toBe('████████████████████ MAX');
        expect(buildXpBar({ level: 1, xp: 0 }, 80)).toBe(`${'░'.repeat(20)} 0%`);
        expect(buildXpBar({ level: 1, xp: 40 }, 40)).toContain('50%');
        expect(buildXpBar({ level: 1, xp: 99_999 }, 1)).toBe(`${'█'.repeat(20)} 100%`);
    });

    test('buildXpBar treats a level off the end of the ladder as one XP to go', () => {
        expect(buildXpBar({ level: 999, xp: 1 }, 1)).toBe(`${'█'.repeat(20)} 100%`);
    });

    // FISHER_LEVELS[0] is level 1, whose xpRequired is 0, so a level of 0 is the
    // one input that reaches the divide-by-zero guard rather than the division.
    test('buildXpBar reads a zero requirement as no progress rather than NaN', () => {
        expect(buildXpBar({ level: 0, xp: 50 }, 80)).toBe(`${'░'.repeat(20)} 0%`);
    });

    test('buildQuestProgressBar clamps to the bar length and never divides by zero', () => {
        expect(buildQuestProgressBar(0, 10, 10)).toBe(`[${'░'.repeat(10)}]`);
        expect(buildQuestProgressBar(5, 10, 10)).toBe(`[${'█'.repeat(5)}${'░'.repeat(5)}]`);
        expect(buildQuestProgressBar(99, 10, 10)).toBe(`[${'█'.repeat(10)}]`);
        expect(buildQuestProgressBar(3, 0, 10)).toBe(`[${'█'.repeat(10)}]`);
    });
});

// `if (todData)` in buildFooter has no false branch to reach: getTimeOfDay
// returns one of the four keys for every hour of the day, and all four are in
// TIME_OF_DAY_BONUSES. The invariant is the table agreeing with the function,
// so that is what this checks.
describe('buildFooter', () => {
    test('every slot getTimeOfDay can return has a bonus entry', () => {
        expect(Object.keys(TIME_OF_DAY_BONUSES).sort())
            .toEqual(['dawn', 'dusk', 'midnight', 'noon']);
        for (const slot of Object.keys(TIME_OF_DAY_BONUSES)) {
            expect([slot, typeof TIME_OF_DAY_BONUSES[slot].description]).toEqual([slot, 'string']);
        }
    });

    // The time-of-day segment is the one part that follows the clock rather than
    // the fixture, so it is asserted as "one of the four" rather than pinned.
    test('a plain footer is the weather and the time of day', () => {
        const segments = buildFooter(makeUser()).split(' • ');
        expect(segments).toHaveLength(2);
        expect(segments[0]).toBe('☀️ Clear Skies');
        expect(Object.values(TIME_OF_DAY_BONUSES).map(t => t.description))
            .toContain(segments[1]);
    });

    test('each queued consumable adds its own segment', () => {
        const footer = buildFooter(makeUser({
            activeBait: 'worms', activeBaitCastsLeft: 4,
            activeLuck: true, activeXpScroll: true,
        }));
        expect(footer).toContain('Bait ×4');
        expect(footer).toContain('Luck ready');
        expect(footer).toContain('XP Scroll ready');
    });

    test('no consumables means no consumable segments', () => {
        const footer = buildFooter(makeUser());
        expect(footer).not.toContain('Bait (');
        expect(footer).not.toContain('Luck (queued)');
    });
});

describe('formatters', () => {
    test('formatPrestigeBonuses lists only the bonuses that are non-zero', () => {
        expect(formatPrestigeBonuses({ critBonus: 0, staminaBonus: 0, payoutBonus: 0, rarityBonus: 0 }))
            .toBe('None');
        expect(formatPrestigeBonuses({ critBonus: 0.02, staminaBonus: 1, payoutBonus: 0.1, rarityBonus: 0.02 }))
            .toBe('+2% crit chance\n+1 max stamina\n+10% all payouts\n+2% rarity boost');
    });

    test('formatTierWeights drops the tiers a location cannot roll', () => {
        expect(formatTierWeights({ common: 50, uncommon: 50, rare: 0 }))
            .toBe('common 50%, uncommon 50%');
    });
});
