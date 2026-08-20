'use strict';

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));

const { __test__ } = require('../src/commands/economy/hunt');
const { buildHuntEmbed, buildBonusLines } = __test__;
const { ZONES, ANIMALS, TROPHY_QUALITIES, LIMITS, WEAPON_TIERS, WEAPON_UPGRADES } = require('../src/data/huntData');

// Discord's hard limits.
const MAX_FIELDS      = 25;
const MAX_FIELD_VALUE = 1024;
const MAX_FIELD_NAME  = 256;
const MAX_DESCRIPTION = 4096;

// executeStart appends at most two further fields after buildHuntEmbed returns:
// the consolidated "Bonuses" field and the rare-companion drop.
const FIELDS_ADDED_BY_CALLER = 2;

function maximalUser() {
    return {
        balance: 12_345_678,
        hunt: {
            level: 25, xp: 13_000, prestige: 3, stamina: 7,
            consecutiveFails: 0, sinceRare: 49,
            dailyHunts: 140, dailyCoins: 149_000,
            dailyWindowStart: new Date(Date.now() - 3600_000),
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
        // Every daily penalty biting at once, so the budget test counts the
        // "Daily Limits" field too.
        dailyReport: {
            grossPayout: 15_000,
            dimReturns:  { multiplier: 0.55, threshold: 120, nextAt: null, nextMultiplier: null },
            softCapped:  true,
            headroomClamped: true,
            lostToDaily: 10_679,
        },
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

describe('trophy case', () => {
    const { buildTrophyField } = __test__;
    const QUALITIES = TROPHY_QUALITIES.filter(q => q.id !== 'poor' && q.id !== 'normal');

    /** Every trophy string the game can ever store, in discovery order. */
    function everyTrophy() {
        const all = [];
        for (const animal of Object.values(ANIMALS)) {
            for (const q of QUALITIES) all.push(`${q.emoji} ${q.label} ${animal.name}`);
        }
        return all;
    }

    it('keeps the field inside Discord limits for a full collection', () => {
        const field = buildTrophyField(everyTrophy());
        expect(field.value.length).toBeLessThanOrEqual(MAX_FIELD_VALUE);
        expect(field.name.length).toBeLessThanOrEqual(MAX_FIELD_NAME);
    });

    it('reports the full count even when the list is trimmed', () => {
        const all   = everyTrophy();
        const field = buildTrophyField(all);
        expect(field.name).toContain(String(all.length));
        expect(field.value).toMatch(/\+\d+ more$/);
    });

    it('shows the best trophies first', () => {
        const mythic   = `🟣 Mythic ${ANIMALS.rabbit.name}`;
        const field    = buildTrophyField([...everyTrophy(), mythic].reverse());
        expect(field.value.startsWith('🟣')).toBe(true);
    });

    it('lists a small collection in full with no tail', () => {
        const few = ['🟢 Good Rabbit', '🔷 Pristine Wolf'];
        const field = buildTrophyField(few);
        expect(field.value).toBe('🔷 Pristine Wolf, 🟢 Good Rabbit');
        expect(field.name).toBe('🏆 Trophies (2)');
    });
});

describe('weapon inventory pages', () => {
    const { buildWeaponPages, WEAPON_SEPARATOR } = __test__;

    /**
     * The longest entry the renderer can ever produce for a tier: the longest
     * weapon name, the longest upgrade label, and the widest durability and
     * repair-count numbers a real weapon reaches.
     */
    function weapon(tier, overrides = {}) {
        const def = WEAPON_TIERS.find(w => w.tier === tier);
        const longestUpgrade = Object.keys(WEAPON_UPGRADES)
            .sort((a, b) => b.length - a.length)[0];
        return {
            tier,
            name: def.name,
            status: 'condemned',
            currentDurability: def.baseDurability,
            maxDurability: def.baseDurability,
            baseDurability: def.baseDurability,
            repairCount: 99,
            upgrade: longestUpgrade,
            ...overrides,
        };
    }

    /**
     * The worst inventory the game can produce. `/hunt inv discard` only accepts
     * broken or condemned weapons and `/hunt shop weapon` caps nothing, so a
     * player who replaces working weapons accumulates them permanently — there
     * is no upper bound to test against, only "far past where it used to break".
     */
    function hoarder(count) {
        return {
            equippedWeaponIndex: count - 1,
            weapons: Array.from({ length: count }, (_, i) =>
                weapon(WEAPON_TIERS[i % WEAPON_TIERS.length].tier)),
        };
    }

    it('keeps every page inside the description limit for a hoarded inventory', () => {
        // 200 is an order of magnitude past the ~22 that used to fail the API
        // call outright and take the whole command down with it.
        for (const page of buildWeaponPages(hoarder(200))) {
            expect(page.join(WEAPON_SEPARATOR).length).toBeLessThanOrEqual(MAX_DESCRIPTION);
        }
    });

    it('loses no weapon to paging — every number is still reachable', () => {
        const h = hoarder(200);
        const shown = buildWeaponPages(h).flat()
            .map(line => Number(line.match(/^\*\*#(\d+) /)[1]));

        expect(shown.slice().sort((a, b) => a - b))
            .toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    });

    it('numbers each weapon by its index in the inventory, not its position on the page', () => {
        // /hunt inv equip and /hunt inv discard address weapons by that index,
        // so a display order that renumbered them would equip the wrong rifle.
        const h = hoarder(30);
        const equipped = buildWeaponPages(h)[0][0];
        expect(equipped).toContain(`#${h.equippedWeaponIndex + 1} `);
        expect(equipped).toContain('[EQUIPPED]');
    });

    it('puts the equipped weapon first and the rest by tier descending', () => {
        const h = {
            equippedWeaponIndex: 2,
            weapons: [weapon(12), weapon(1), weapon(5)],
        };
        const tiers = buildWeaponPages(h).flat()
            .map(line => Number(line.match(/^\*\*#(\d+) /)[1]));

        expect(tiers).toEqual([3, 1, 2]); // equipped (#3), then T12 (#1), then T1 (#2)
    });

    it('fits a normal inventory on one page', () => {
        expect(buildWeaponPages(hoarder(8))).toHaveLength(1);
        expect(buildWeaponPages(hoarder(9))).toHaveLength(2);
    });
});

describe('aim phase grading', () => {
    const { gradeShot, AIM_WINDOW_MS, AIM_LATE_MS } = __test__;
    const OPEN_AT = 1500; // the randomised moment the window opens

    it('pays the top bonus for a shot inside the window', () => {
        expect(gradeShot(OPEN_AT, OPEN_AT).bonus).toBe(0.18);
        expect(gradeShot(OPEN_AT + AIM_WINDOW_MS, OPEN_AT).bonus).toBe(0.18);
    });

    it('pays less for a shot after the window has closed', () => {
        expect(gradeShot(OPEN_AT + AIM_WINDOW_MS + 1, OPEN_AT).grade).toBe('late');
        expect(gradeShot(OPEN_AT + AIM_LATE_MS, OPEN_AT).bonus).toBe(0.08);
    });

    it('charges for a shot fired before the window opened', () => {
        // The mechanic the footer has always described. It used to be
        // unreachable — the button did not exist yet — so mashing the trigger
        // the instant it appeared was the *optimal* play and paid at least +8%.
        expect(gradeShot(OPEN_AT - 1, OPEN_AT).grade).toBe('early');
        expect(gradeShot(0, OPEN_AT).bonus).toBeLessThan(0);
    });

    it('pays nothing at all for never firing', () => {
        expect(gradeShot(null, OPEN_AT).bonus).toBe(0);
    });

    it('grades on when the shot came, not how fast the wire is', () => {
        // The old rule: under 800ms of round trip → +18%, otherwise +8%. The
        // same play from a player 400ms further from Discord scored worse for
        // no reason a hunter could act on. These two fire at the same moment
        // relative to the call, 300ms apart in absolute terms, and grade the
        // same.
        const quick = gradeShot(OPEN_AT + 120, OPEN_AT);
        const laggy = gradeShot(OPEN_AT + 420, OPEN_AT);

        expect(quick.grade).toBe('perfect');
        expect(laggy.grade).toBe('perfect');
    });

    it('leaves the window wide enough that a slow connection can still clear it', () => {
        // Half a second of usable window at 400ms of round trip is twice a
        // human reaction time; anything tighter grades the connection again.
        expect(AIM_WINDOW_MS).toBeGreaterThanOrEqual(2 * 400);
    });
});
