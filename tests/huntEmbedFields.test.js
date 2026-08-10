'use strict';

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));

const { __test__ } = require('../src/commands/economy/hunt');
const { buildHuntEmbed, buildBonusLines } = __test__;
const { ZONES, ANIMALS, TROPHY_QUALITIES, LIMITS } = require('../src/data/huntData');

// Discord's hard limits.
const MAX_FIELDS      = 25;
const MAX_FIELD_VALUE = 1024;
const MAX_FIELD_NAME  = 256;

// executeStart appends at most two further fields after buildHuntEmbed returns:
// the consolidated "Bonuses" field and the rare-companion drop.
const FIELDS_ADDED_BY_CALLER = 2;

function maximalUser() {
    return {
        balance: 12_345_678,
        hunt: {
            level: 25, xp: 13_000, prestige: 3, stamina: 7,
            consecutiveFails: 0, sinceRare: 49,
            trophies: [], activeBait: 'premium_bait', activeBaitHuntsLeft: 1,
            activeCharm: 'luck_charm', activeCharmHuntsLeft: 1,
            activeFocus: true, activeXpScroll: true,
        },
    };
}

/** A hunt where every optional field fires at once. */
function maximalSuccessResult() {
    const animal = ANIMALS.alpha_bear; // aggressive + giant + enraged, has a special drop
    return {
        success: true,
        animal,
        tier: 'epic',
        traits: animal.traits,
        traitEffects: [
            { trait: 'aggressive', msg: 'It lashed out while falling, injuring you.' },
            { trait: 'giant',      msg: 'The sheer mass of the beast wore your weapon harder.' },
            { trait: 'enraged',    msg: 'Its fury drove the prize higher (+25% payout).' },
        ],
        finalPayout: 4321,
        isCrit: true,
        critMultiplier: 2.4,
        trophyQuality: TROPHY_QUALITIES.find(q => q.id === 'mythic'),
        specialDrop: animal.specialDrop,
        xpEarned: 260,
        levelUp: { oldLevel: 24, newLevel: 25 },
        cappedByHard: false,
        streakMult: 1.5,
        expiredBait: 'premium_bait',
        expiredCharm: 'luck_charm',
        gatheringYield: { effect: 'silvered_talisman', label: 'Silvered Talisman', emoji: '🪙', chargesLeft: 3 },
        petYieldBonus: 432,
        petXpBonus: 39,
        featuredZoneBonus: 1080,
        wildernessBonus: 432,
    };
}

const brokenWeapon = {
    name: 'Steel Rifle', tier: 4,
    currentDurability: 0, maxDurability: 170, baseDurability: 170,
    repairCount: 0, upgrade: null, status: 'broken',
};

const discordUser = { id: '1', username: 'tester', displayAvatarURL: () => 'https://example.invalid/a.png' };

function fieldsOf(embed) {
    return embed.data.fields ?? [];
}

describe('hunt success embed field budget', () => {
    let embed;

    beforeAll(() => {
        embed = buildHuntEmbed(
            maximalSuccessResult(), maximalUser(), ZONES.legendary_peaks, brokenWeapon, '💰', discordUser
        );
    });

    test('leaves room for the fields executeStart appends', () => {
        expect(fieldsOf(embed).length).toBeLessThanOrEqual(MAX_FIELDS - FIELDS_ADDED_BY_CALLER);
    });

    test('the maximal case is comfortably under the cap, not just barely', () => {
        // Guards against creeping back to 24/25. Fail loudly if headroom shrinks
        // below five so there is warning before an embed starts throwing.
        expect(fieldsOf(embed).length).toBeLessThanOrEqual(MAX_FIELDS - 5);
    });

    test('the maximal case really did populate the optional fields', () => {
        const names = fieldsOf(embed).map(f => f.name).join(' | ');
        for (const expected of ['Multipliers', 'Traits', 'Trait Effects', 'Special Drop', 'Level Up', 'Buffs Expired', 'Weapon Broke', 'Rare Pity']) {
            expect(names).toContain(expected);
        }
    });

    test('bait and charm expiry share one field', () => {
        const expired = fieldsOf(embed).filter(f => f.name.includes('Expired'));
        expect(expired).toHaveLength(1);
        expect(expired[0].value).toContain('worn off');
        expect(expired[0].value.split('\n')).toHaveLength(2);
    });

    test('every field respects Discord name/value limits', () => {
        for (const field of fieldsOf(embed)) {
            expect(field.name.length).toBeGreaterThan(0);
            expect(field.name.length).toBeLessThanOrEqual(MAX_FIELD_NAME);
            expect(field.value.length).toBeGreaterThan(0);
            expect(field.value.length).toBeLessThanOrEqual(MAX_FIELD_VALUE);
        }
    });
});

describe('buildBonusLines', () => {
    test('collapses every bonus into a single field worth of lines', () => {
        const lines = buildBonusLines(maximalSuccessResult(), 10, 15);
        expect(lines).toHaveLength(5);
        expect(lines.join('\n').length).toBeLessThanOrEqual(MAX_FIELD_VALUE);
    });

    test('emits nothing when no bonus applied', () => {
        expect(buildBonusLines({ success: true }, 0, 0)).toEqual([]);
    });

    test('names the last charge instead of showing a zero count', () => {
        const result = { gatheringYield: { label: 'Voidsteel Cache', emoji: '🌌', chargesLeft: 0 } };
        expect(buildBonusLines(result, 0, 0)[0]).toContain('last charge');
        expect(buildBonusLines(result, 0, 0)[0]).not.toContain('0 charge');
    });

    test('pluralises charges correctly', () => {
        const one  = { gatheringYield: { label: 'X', emoji: '🪙', chargesLeft: 1 } };
        const many = { gatheringYield: { label: 'X', emoji: '🪙', chargesLeft: 2 } };
        expect(buildBonusLines(one, 0, 0)[0]).toContain('1 charge left');
        expect(buildBonusLines(many, 0, 0)[0]).toContain('2 charges left');
    });
});

describe('hunt failure embed field budget', () => {
    test('stays well under the cap with every optional field firing', () => {
        const user = maximalUser();
        user.hunt.consecutiveFails = 5;

        const embed = buildHuntEmbed({
            success: false,
            animal: ANIMALS.wolf,
            traits: ANIMALS.wolf.traits,
            traitEffects: [{ trait: 'pack_hunter', msg: 'The pack descended on you.' }],
            failure: { severity: { id: 'injured', injuryMs: LIMITS.INJURY_PENALTY_MS }, message: 'You twisted your ankle.' },
            xpEarned: 0,
            levelUp: { oldLevel: 24, newLevel: 25 },
            deathEvent: { saved: false, weaponName: 'Steel Rifle' },
            staminaSpared: false,
        }, user, ZONES.murky_swamp, brokenWeapon, '💰', discordUser);

        expect(fieldsOf(embed).length).toBeLessThanOrEqual(MAX_FIELDS - 5);
        for (const field of fieldsOf(embed)) {
            expect(field.value.length).toBeLessThanOrEqual(MAX_FIELD_VALUE);
        }
    });
});
