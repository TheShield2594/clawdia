'use strict';

// Branch coverage for src/commands/economy/hunt/embeds.js (#998's follow-on).
//
// The /hunt counterpart to tests/fishEmbeds.test.js and tests/mineEmbeds.test.js,
// and it starts from a different place than either. `fish` and `mine` had their
// embed modules at 0 branches; this one was already at 58%, because the suites
// around `hunt/index.js` reach parts of it through that file's `__test__`
// export. What they reach is the success path: tests/huntEmbedFields.test.js
// drives buildHuntEmbed over a maximal kill and asserts the field budget.
//
// So this suite deliberately takes what those leave — the failure embed and its
// death events, the pity field's four heat bands, the ammo helpers, and the
// four small formatters (buildXpBar, formatBonuses, buildProgressBar,
// formatExpiry) that no test had called at all.
//
// `randomFrom` is mocked because the clean-miss description picks a line at
// random, and a suite that asserts on it would fail one run in N otherwise.

jest.mock('../src/utils/copyLines', () => {
    const actual = jest.requireActual('../src/utils/copyLines');
    return { ...actual, randomFrom: jest.fn(list => list[0]) };
});

const { randomFrom } = require('../src/utils/copyLines');

const {
    AMMO_LOW_THRESHOLD,
    PITY_HOT_FRACTION,
    PITY_WARM_FRACTION,
    ammoContext,
    buildActiveConsumablesLine,
    buildAmmoField,
    buildBrokenWeaponNote,
    buildFailureTitle,
    buildHuntEmbed,
    buildLowAmmoField,
    buildPityField,
    buildProgressBar,
    buildStaminaLine,
    buildXpBar,
    buildXpLine,
    formatBonuses,
    formatExpiry,
} = require('../src/commands/economy/hunt/embeds');

const {
    AMMO_PACKS,
    ANIMALS,
    ANIMAL_TRAITS,
    HUNTER_LEVELS,
    TIER_COLORS,
    TROPHY_QUALITIES,
    WEAPON_BY_TIER,
    ZONES,
} = require('../src/data/huntData');
const { HUNT_EMPTY_LINES } = require('../src/utils/copyLines');

const forest = ZONES.beginner_forest;

/** The fields of an embed, keyed by name, for asserting without index arithmetic. */
function fieldsOf(embed) {
    return Object.fromEntries((embed.data.fields ?? []).map(f => [f.name, f.value]));
}

/**
 * A hunter mid-ladder with nothing running. Prestige 2 is one rung past the
 * stamina bonus, so getMaxStamina reads 11 rather than the base 10; sinceRare 0
 * keeps the pity field off until a test asks for it (it appears from 5 up).
 */
function makeUser(hunt = {}) {
    return {
        balance: 54_321,
        hunt: {
            level: 5,
            xp: 640,
            prestige: 2,
            stamina: 7,
            sinceRare: 0,
            consecutiveFails: 0,
            ammo: {},
            activeBait: null,
            activeCharm: null,
            activeFocus: false,
            activeXpScroll: false,
            ...hunt,
        },
    };
}

/**
 * A tier-1 rifle, which takes no ammo — so the ammo fields stay off unless a
 * test asks for a tier that needs it. 60/80 is clear of the 20% mark the
 * low-durability warning fires at, and maxDurability equal to baseDurability
 * keeps it out of `isCondemned`.
 */
function makeWeapon(over = {}) {
    return {
        name: 'Wooden Rifle',
        tier: 1,
        status: 'good',
        currentDurability: 60,
        maxDurability: 80,
        baseDurability: 80,
        ...over,
    };
}

function failureResult(over = {}) {
    return {
        success: false,
        failure: { severity: { id: 'spooked', injuryMs: 0 }, message: 'It bolted before you could line up.' },
        xpEarned: 0,
        levelUp: null,
        ...over,
    };
}

const hunt = (result, user = makeUser(), weapon = makeWeapon()) =>
    buildHuntEmbed(result, user, forest, weapon, '🪙', null);

beforeEach(() => {
    randomFrom.mockClear();
});

describe('buildHuntEmbed — the failure embed', () => {
    test('a plain miss reports no reward and no XP', () => {
        const embed = hunt(failureResult());
        expect(embed.data.author.name).toBe(`${forest.emoji} ${forest.name}`);
        expect(embed.data.description).toContain('💨 No reward  ·  No XP');
        expect(fieldsOf(embed)['🎒 Kit']).toContain('7/11 stamina');
    });

    test('a failure that still paid XP prints the amount', () => {
        expect(hunt(failureResult({ xpEarned: 6 })).data.description).toContain('✨ +6 XP');
    });

    test('an encountered animal is named ahead of the failure message', () => {
        const embed = hunt(failureResult({ animal: ANIMALS.rabbit }));
        expect(embed.data.description).toContain(`Encountered: ${ANIMALS.rabbit.emoji} **${ANIMALS.rabbit.name}**`);
        expect(embed.data.description).toContain('It bolted before you could line up.');
    });

    // A clean miss met nothing at all, so there is no message worth printing —
    // it draws from a pool of flavour lines instead.
    test('a clean miss with no animal draws a flavour line rather than the message', () => {
        const embed = hunt(failureResult({
            failure: { severity: { id: 'clean_miss', injuryMs: 0 }, message: 'unused' },
        }));
        expect(randomFrom).toHaveBeenCalledWith(HUNT_EMPTY_LINES);
        expect(embed.data.description.split('\n')[0]).toBe(`*${HUNT_EMPTY_LINES[0]}*`);
    });

    test('a non-clean miss with no animal keeps its own message', () => {
        expect(hunt(failureResult()).data.description.split('\n')[0]).toBe('*It bolted before you could line up.*');
        expect(randomFrom).not.toHaveBeenCalled();
    });

    test('a spared hunt says so beside the outcome instead of spending stamina', () => {
        expect(hunt(failureResult({ staminaSpared: true })).data.description)
            .toContain('clean miss — no stamina spent');
    });

    test('a fail streak adds the pity streak field', () => {
        const before = hunt(failureResult()).data.fields.length;
        const after = hunt(failureResult(), makeUser({ consecutiveFails: 3 })).data.fields.length;
        expect(after).toBeGreaterThan(before);
    });

    test('a missing fail counter is read as no streak', () => {
        // Nothing but the Kit: no streak field for a counter that was never set.
        expect(hunt(failureResult(), makeUser({ consecutiveFails: undefined })).data.fields.map(f => f.name))
            .toEqual(['🎒 Kit']);
    });

    test('known traits render their name and unknown ones render bare', () => {
        const fields = fieldsOf(hunt(failureResult({ traits: ['aggressive', 'not_a_trait'] })));
        expect(fields['🧬 Traits']).toContain(ANIMAL_TRAITS.aggressive.name);
        expect(fields['🧬 Traits']).toContain('not_a_trait');
    });

    test('trait effects ride the traits field, and an empty list adds none', () => {
        expect(fieldsOf(hunt(failureResult({ traitEffects: [{ msg: 'It gored you on the way past.' }] })))['🧬 Traits'])
            .toContain('• It gored you on the way past.');
        expect(fieldsOf(hunt(failureResult({ traits: [], traitEffects: [] })))['🧬 Traits'])
            .toBeUndefined();
    });

    test('an injury names the extra cooldown', () => {
        expect(fieldsOf(hunt(failureResult({
            failure: { severity: { id: 'injured', injuryMs: 900_000 }, message: 'Mauled.' },
        })))['🤕 Injured']).toContain('15m');
    });

    test('a level-up on a failed hunt still gets its own field', () => {
        expect(fieldsOf(hunt(failureResult({ levelUp: { oldLevel: 4, newLevel: 5 } })))['⬆️ Level Up!'])
            .toContain(`**4** → **5** (${HUNTER_LEVELS[4].title})`);
    });
});

describe('buildHuntEmbed — death events', () => {
    test('a lifesaver absorbs the hit and recolours the embed', () => {
        const embed = hunt(failureResult({ deathEvent: { saved: true, weaponName: 'Iron Rifle' } }));
        expect(embed.data.color).toBe(0xe67e22);
        expect(fieldsOf(embed)['🛟 Lifesaver Activated!']).toContain('Iron Rifle');
    });

    test('an unsaved death wrecks the weapon and points at the repair command', () => {
        const embed = hunt(failureResult({ deathEvent: { saved: false, weaponName: 'Iron Rifle' } }));
        expect(embed.data.color).toBe(0x8B0000);
        expect(fieldsOf(embed)['💀 Catastrophe!']).toContain('/hunt shop repair');
    });

    // A condemned weapon cannot be repaired at all, so pointing the player at
    // the repair command would be advice that costs them a trip.
    test('an unsaved death on a condemned weapon sends the player to buy a new one', () => {
        const embed = hunt(
            failureResult({ deathEvent: { saved: false, weaponName: 'Iron Rifle' } }),
            makeUser(),
            makeWeapon({ currentDurability: 4, maxDurability: 10, baseDurability: 80 }),
        );
        const note = fieldsOf(embed)['💀 Catastrophe!'];
        expect(note).toContain('condemned');
        expect(note).toContain('/hunt shop weapon');
        expect(note).not.toContain('/hunt shop repair');
    });

    // The death event already explains the destroyed weapon, so the generic
    // "Weapon Broke!" is suppressed rather than printed beside it.
    test('a death event suppresses the plain weapon-broke field', () => {
        const fields = fieldsOf(hunt(
            failureResult({ deathEvent: { saved: false, weaponName: 'Iron Rifle' } }),
            makeUser(),
            makeWeapon({ status: 'broken' }),
        ));
        expect(fields['⚠️ Heads Up']).toBeUndefined();
    });

    test('a broken weapon without a death event gets the plain broke field', () => {
        const embed = hunt(failureResult(), makeUser(), makeWeapon({ status: 'broken' }));
        expect(fieldsOf(embed)['⚠️ Heads Up']).toContain('/hunt shop repair');
        expect(embed.data.footer.text).toContain('Tip:');
    });
});

// The success path is the half tests/huntEmbedFields.test.js already drives, so
// this covers only the two branches it leaves: the weapon warnings, which that
// suite's maximal kill never reaches because its weapon is healthy.
describe('buildHuntEmbed — the weapon warnings on a kill', () => {
    const killResult = (over = {}) => ({
        success: true,
        animal: ANIMALS.rabbit,
        tier: 'common',
        traits: [],
        traitEffects: [],
        finalPayout: 120,
        isCrit: false,
        critMultiplier: 1,
        trophyQuality: null,
        specialDrop: null,
        xpEarned: 10,
        levelUp: null,
        cappedByHard: false,
        ...over,
    });

    test('a broken weapon outranks the low-durability warning', () => {
        const headsUp = fieldsOf(hunt(killResult(), makeUser(), makeWeapon({ status: 'broken', currentDurability: 0 })))['⚠️ Heads Up'];
        expect(headsUp).toContain('/hunt shop repair');
        expect(headsUp).not.toContain('nearly worn out');
    });

    test('a worn weapon warns before it breaks', () => {
        const headsUp = fieldsOf(hunt(killResult(), makeUser(), makeWeapon({ currentDurability: 8 })))['⚠️ Heads Up'];
        expect(headsUp).toContain('nearly worn out (8/80)');
        expect(headsUp).not.toContain('has broken');
    });

    test('a healthy weapon raises neither warning', () => {
        const fields = fieldsOf(hunt(killResult()));
        expect(fields['⚠️ Heads Up']).toBeUndefined();
        expect(fields['🎒 Kit']).toContain('🪙54,321');
    });

    test('an event find outranks a critical for both colour and headline', () => {
        const embed = hunt(killResult({ tier: 'event', isCrit: true, critMultiplier: 2 }));
        expect(embed.data.color).toBe(parseInt(TIER_COLORS.event.slice(1), 16));
        expect(embed.data.title).toBe(`☄️ MYTHICAL — ${ANIMALS.rabbit.emoji} CRITICAL! ${ANIMALS.rabbit.name}`);
        expect(embed.data.description).toContain('no business existing');
    });

    test('a legendary find gets the legendary headline and lede', () => {
        const embed = hunt(killResult({ tier: 'legendary' }));
        // The headline keeps the animal: it is the trophy.
        expect(embed.data.title).toBe(`🌟 LEGENDARY — ${ANIMALS.rabbit.emoji} ${ANIMALS.rabbit.name}`);
        expect(embed.data.description).toContain('You found something impossible in the wild.');
    });

    test('a critical below legendary is gold and says CRITICAL', () => {
        const embed = hunt(killResult({ tier: 'rare', isCrit: true, critMultiplier: 2.5 }));
        expect(embed.data.color).toBe(0xFFD700);
        expect(embed.data.title).toContain('✨ CRITICAL!');
        expect(embed.data.description).toContain('**+10 XP** (crit bonus)');
    });

    test('an ordinary find is the animal, with the trophy grade in the title', () => {
        const quality = TROPHY_QUALITIES.find(q => q.multiplier > 1);
        const embed = hunt(killResult({ trophyQuality: quality }));
        expect(embed.data.title).toContain(quality.label);
        expect(embed.data.description).toContain(`${quality.label} trophy`);
    });

    test('no trophy grade leaves the reward line without one rather than printing undefined', () => {
        const desc = hunt(killResult()).data.description;
        expect(desc).toContain('**+🪙120**  ·  ✨ **+10 XP**');
        expect(desc).not.toContain('undefined');
        expect(desc).not.toContain('trophy');
    });

    // At the hard cap finalPayout is already 0, so the strikethrough is drawn
    // over what the cap took rather than over the zero it left.
    test('a capped kill strikes through the forfeited amount and says when it lifts', () => {
        const reward = hunt(
            killResult({ cappedByHard: true, finalPayout: 0, forfeitedPayout: 900 }),
            makeUser({ dailyWindowStart: new Date() }),
        ).data.description;
        expect(reward).toContain('~~🪙900~~');
        expect(reward).toContain('Daily cap reached');
    });

    test('a capped kill with no recorded forfeit reads as zero', () => {
        expect(hunt(killResult({ cappedByHard: true, finalPayout: 0 })).data.description)
            .toContain('~~🪙0~~');
    });

    test('streak, crit and trophy all appear in the multiplier stack', () => {
        const quality = TROPHY_QUALITIES.find(q => q.multiplier > 1);
        const desc = hunt(killResult({
            streakMult: 1.5, isCrit: true, critMultiplier: 2, trophyQuality: quality, finalPayout: 900,
        })).data.description;
        const stack = desc.split('\n').find(l => l.startsWith('📈'));
        expect(stack).toContain('1.50x');
        expect(stack).toContain('2.00x crit');
        expect(stack).toContain(`${quality.multiplier.toFixed(2)}x`);
        expect(stack).toContain(`**${(1.5 * 2 * quality.multiplier).toFixed(2)}x**`);
    });

    test('a flat kill shows no multiplier line', () => {
        expect(hunt(killResult({ streakMult: 1 })).data.description).not.toContain('📈');
    });

    test('a trophy grade at or below 1x is not a multiplier worth listing', () => {
        const poor = TROPHY_QUALITIES.find(q => q.multiplier <= 1);
        expect(hunt(killResult({ trophyQuality: poor })).data.description).not.toContain('📈');
    });

    test('every remaining optional field fires at once', () => {
        const fields = fieldsOf(hunt(killResult({
            traits: ['aggressive', 'not_a_trait'],
            traitEffects: [{ msg: 'It gored you on the way down.' }],
            specialDrop: { name: "Rabbit's Foot" },
            levelUp: { oldLevel: 5, newLevel: 6 },
            expiredBait: 'premium_bait',
            expiredCharm: true,
        })));
        expect(fields['🧬 Traits']).toContain(ANIMAL_TRAITS.aggressive.name);
        expect(fields['🧬 Traits']).toContain('not_a_trait');
        expect(fields['🧬 Traits']).toContain('It gored you on the way down.');
        expect(fields['🎁 Special Drop!']).toContain("Rabbit's Foot");
        expect(fields['⬆️ Level Up!']).toContain('**5** → **6**');
        expect(fields['⚠️ Heads Up']).toContain('premium bait');
        expect(fields['⚠️ Heads Up']).toContain('luck charm');
    });
});

describe('buildPityField', () => {
    const at = sinceRare => buildPityField(makeUser({ sinceRare }), forest);
    const threshold = forest.rarePity;

    test('at or past the threshold the next hunt is guaranteed', () => {
        expect(at(threshold).value).toContain('GUARANTEED NEXT HUNT');
        expect(at(threshold + 99).name).toContain(`${threshold + 99}/${threshold}`);
    });

    test('past the hot fraction it is getting hot', () => {
        const field = at(Math.ceil(threshold * PITY_HOT_FRACTION));
        expect(field.name).toContain('🔥');
        expect(field.value).toContain('Getting hot');
    });

    test('past the warm fraction it is warming up', () => {
        const field = at(Math.ceil(threshold * PITY_WARM_FRACTION));
        expect(field.name).toContain('🌡️');
        expect(field.value).toContain('Warming up');
    });

    test('below the warm fraction it is cold, and counts down to the guarantee', () => {
        const field = at(1);
        expect(field.name).toContain('❄️');
        expect(field.value).toContain(`~${threshold - 1} more for guaranteed Rare+`);
    });

    test('a missing counter is read as zero', () => {
        expect(buildPityField(makeUser({ sinceRare: undefined }), forest).name)
            .toContain(`0/${threshold}`);
    });

    // Each zone sets its own threshold; the bands are fractions of it rather
    // than the flat 50 they were once hardcoded against.
    test('the threshold comes from the zone, and falls back without one', () => {
        expect(buildPityField(makeUser({ sinceRare: 0 }), ZONES.legendary_peaks).name)
            .toContain(`0/${ZONES.legendary_peaks.rarePity}`);
        expect(buildPityField(makeUser({ sinceRare: 0 }), undefined).name).toMatch(/0\/\d+/);
    });

    test('the bar never overfills past the threshold', () => {
        expect(at(threshold * 4).value).toContain('█'.repeat(16));
    });

    // Both the kill and the miss read the counter through the same `?? 0`, so a
    // player who has never had one recorded gets no field rather than a NaN bar.
    test('a player with no counter at all gets no pity field on either path', () => {
        const killResult = {
            success: true, animal: ANIMALS.rabbit, tier: 'common', traits: [], traitEffects: [],
            finalPayout: 10, isCrit: false, critMultiplier: 1, trophyQuality: null,
            specialDrop: null, xpEarned: 1, levelUp: null, cappedByHard: false,
        };
        for (const result of [killResult, failureResult()]) {
            const names = Object.keys(fieldsOf(hunt(result, makeUser({ sinceRare: undefined }))));
            expect(names.some(n => n.includes('Rare Pity'))).toBe(false);
        }
    });

    test('the field appears on a hunt once the counter reaches five', () => {
        // It is a line of the Kit now rather than a field of its own.
        expect(fieldsOf(hunt(failureResult(), makeUser({ sinceRare: 4 })))['🎒 Kit']).not.toContain('Rare pity');
        expect(fieldsOf(hunt(failureResult(), makeUser({ sinceRare: 5 })))['🎒 Kit']).toContain(`Rare pity 5/${threshold}`);
    });
});

describe('the ammo helpers', () => {
    const t4 = () => makeWeapon({ tier: 4, name: 'Steel Rifle' });

    test('a weapon that takes no ammo has no ammo context and no fields', () => {
        expect(ammoContext(makeUser(), makeWeapon())).toBeNull();
        expect(buildAmmoField(makeUser(), makeWeapon())).toBeNull();
        expect(buildLowAmmoField(makeUser(), makeWeapon())).toBeNull();
    });

    test('a weapon tier the table does not know is treated as taking no ammo', () => {
        expect(ammoContext(makeUser(), makeWeapon({ tier: 99 }))).toBeNull();
    });

    test('an ammo-fed weapon reports the round it takes and how many are left', () => {
        const ammo = ammoContext(makeUser({ ammo: { steel_shot: 12 } }), t4());
        expect(ammo).toEqual({
            remaining: 12,
            label: 'Steel Shot',
            emoji: '⚫',
            packName: 'Steel Shot (20)',
        });
        expect(buildAmmoField(makeUser({ ammo: { steel_shot: 12 } }), t4()).value)
            .toBe('⚫ Steel Shot ×12');
    });

    test('an empty bag reads as zero rather than undefined', () => {
        expect(ammoContext(makeUser({ ammo: {} }), t4()).remaining).toBe(0);
        expect(ammoContext(makeUser({ ammo: undefined }), t4()).remaining).toBe(0);
    });

    test('a healthy stock raises no low-ammo warning', () => {
        expect(buildLowAmmoField(makeUser({ ammo: { steel_shot: AMMO_LOW_THRESHOLD + 1 } }), t4()))
            .toBeNull();
    });

    test('a thin stock warns, and pluralises the count', () => {
        expect(buildLowAmmoField(makeUser({ ammo: { steel_shot: 3 } }), t4()).value)
            .toContain('**3** Steel Shot rounds left');
        expect(buildLowAmmoField(makeUser({ ammo: { steel_shot: 1 } }), t4()).value)
            .toContain('**1** Steel Shot round left');
    });

    test('an empty stock says it was the last round', () => {
        expect(buildLowAmmoField(makeUser({ ammo: { steel_shot: 0 } }), t4()).value)
            .toContain('That was your last **Steel Shot** round!');
    });

    test('the warning rides the failure embed when the bag runs thin', () => {
        const fields = fieldsOf(hunt(failureResult(), makeUser({ ammo: { steel_shot: 2 } }), t4()));
        expect(fields['🎒 Kit']).toContain('⚫ Steel Shot ×2');
        expect(fields['⚠️ Heads Up']).toContain('**2** Steel Shot rounds left');
    });
});

describe('the small formatters', () => {
    test('buildFailureTitle covers each severity and falls back', () => {
        expect(buildFailureTitle('clean_miss')).toBe('💨 Miss!');
        expect(buildFailureTitle('spooked')).toBe('😰 Spooked!');
        expect(buildFailureTitle('jammed')).toBe('🔧 Jammed!');
        expect(buildFailureTitle('injured')).toBe('🤕 Injured!');
        expect(buildFailureTitle('who_knows')).toBe('❌ Failed Hunt');
    });

    test('buildBrokenWeaponNote points at repair, or at replacement when condemned', () => {
        expect(buildBrokenWeaponNote(makeWeapon())).toContain('/hunt shop repair');
        expect(buildBrokenWeaponNote(makeWeapon({ maxDurability: 10, baseDurability: 80 })))
            .toContain('/hunt shop weapon');
    });

    test('buildStaminaLine adds the prestige bonus to the base maximum', () => {
        expect(buildStaminaLine(makeUser({ stamina: 3, prestige: 0 }))).toBe('3/10 ⚡');
        expect(buildStaminaLine(makeUser({ stamina: 3, prestige: 5 }))).toBe('3/11 ⚡');
    });

    test('buildXpLine counts down to the next level, or reports the cap', () => {
        expect(buildXpLine(makeUser({ level: 1, xp: 0 }))).toBe('0 XP (100 to Lv.2)');
        expect(buildXpLine(makeUser({ level: 50, xp: 999_999 }))).toBe('999,999 XP (MAX)');
    });

    test('buildActiveConsumablesLine lists what is running, or says nothing is', () => {
        expect(buildActiveConsumablesLine(makeUser())).toBe('No active buffs');
        expect(buildActiveConsumablesLine(makeUser({
            activeBait: 'premium_bait', activeBaitHuntsLeft: 4,
            activeCharm: 'luck_charm', activeCharmHuntsLeft: 2,
            activeFocus: true, activeXpScroll: true,
        }))).toBe('Bait (4 hunts left) • Charm (2 hunts left) • Focus (queued) • XP Scroll (queued)');
    });

    test('buildXpBar fills from the current level floor and clamps at both ends', () => {
        expect(buildXpBar({ level: 50, xp: 0 }, null)).toBe('████████████████████ MAX');
        expect(buildXpBar({ level: 1, xp: 0 }, 100)).toBe(`${'░'.repeat(20)} 0%`);
        expect(buildXpBar({ level: 1, xp: 50 }, 50)).toContain('50%');
        expect(buildXpBar({ level: 1, xp: 999_999 }, 1)).toBe(`${'█'.repeat(20)} 100%`);
    });

    // Past the end of the ladder both lookups miss: the floor reads 0 and the
    // ceiling reads 1, which is the denominator guard rather than a real level.
    test('buildXpBar treats a level off the end of the ladder as one XP to go', () => {
        expect(buildXpBar({ level: 999, xp: 1 }, 1)).toBe(`${'█'.repeat(20)} 100%`);
    });

    // Level 0 is the one input that reaches the divide-by-zero guard: the floor
    // lookup misses and reads 0, and HUNTER_LEVELS[0] — level 1 — requires 0
    // too, so the band has no width. Every real band does.
    test('buildXpBar reads a zero-width level band as no progress rather than NaN', () => {
        expect(buildXpBar({ level: 0, xp: 0 }, 100)).toBe(`${'░'.repeat(20)} 0%`);
        for (let i = 1; i < HUNTER_LEVELS.length; i++) {
            expect([i, HUNTER_LEVELS[i].xpRequired > HUNTER_LEVELS[i - 1].xpRequired])
                .toEqual([i, true]);
        }
    });

    test('formatBonuses lists only the bonuses that are non-zero', () => {
        expect(formatBonuses({ critBonus: 0, staminaBonus: 0, payoutBonus: 0, rarityBonus: 0 }))
            .toBe('None');
        expect(formatBonuses({ critBonus: 0.02, staminaBonus: 1, payoutBonus: 0.1, rarityBonus: 0.02 }))
            .toBe('+2% crit chance\n+1 max stamina\n+10% all payouts\n+2% rarity boost');
    });

    test('buildProgressBar defaults to ten cells and clamps to the target', () => {
        expect(buildProgressBar(0, 10)).toBe(`[${'░'.repeat(10)}]`);
        expect(buildProgressBar(5, 10)).toBe(`[${'█'.repeat(5)}${'░'.repeat(5)}]`);
        expect(buildProgressBar(99, 10)).toBe(`[${'█'.repeat(10)}]`);
        expect(buildProgressBar(2, 4, 20)).toBe(`[${'█'.repeat(10)}${'░'.repeat(10)}]`);
    });

    test('formatExpiry reports hours and minutes, minutes alone, or expiry', () => {
        expect(formatExpiry(0)).toBe('expired');
        expect(formatExpiry(-1)).toBe('expired');
        expect(formatExpiry(90 * 60_000)).toBe('1h 30m');
        expect(formatExpiry(45 * 60_000)).toBe('45m');
    });

    // This is what makes `pack?.emoji ?? '🔶'` and `pack?.name ?? …` in
    // ammoContext unreachable, so it has to assert the pack lookup itself.
    // Asserting on the returned `label` would not: that is derived from
    // `weaponData.ammoType` rather than from the pack, so it stays defined for
    // an ammo type AMMO_PACKS has never heard of.
    test('every ammo type the weapon table names has a pack to buy', () => {
        const fed = Object.values(WEAPON_BY_TIER).filter(w => w.requiresAmmo);
        expect(fed.length).toBeGreaterThan(0);
        for (const tier of fed) {
            expect([tier.ammoType, AMMO_PACKS.some(pack => pack.ammoType === tier.ammoType)])
                .toEqual([tier.ammoType, true]);
        }
    });
});
