'use strict';

// The rules behind the /hunt start review fixes that live below the Discord
// layer: how an approach is graded, the odds the prompt shows, which apex a
// kill draws out and what walking away from one costs, the result card's
// readiness line, and the budget a message's embeds are held to.

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));

const { EmbedBuilder } = require('discord.js');
const {
    huntSuccessChance,
    calculateSuccessChance,
    rollApexType,
    apexTypeIdFor,
    buildApexEncounter,
    resolveApexEncounter,
    ensureHuntData,
} = require('../src/services/huntService');
const { APEX_TYPES, ANIMALS, ZONES, WEAPON_TIERS, LIMITS } = require('../src/data/huntData');
const { APPROACH_PROFILES, resolveStealth, shuffled } = require('../src/commands/economy/hunt/aim');
const {
    fitEmbeds, nextHuntReadiness, buildReadinessLine, buildMultiplierLine, buildKitField,
} = require('../src/commands/economy/hunt/embeds');

function makeUser(hunt = {}) {
    const rifle = WEAPON_TIERS[0];
    const user = {
        userId: 'u1', guildId: 'g1', balance: 500, markModified() {},
        hunt: {
            level: 1, stamina: 5,
            weapons: [{ name: rifle.name, tier: rifle.tier, currentDurability: rifle.baseDurability, maxDurability: rifle.baseDurability, baseDurability: rifle.baseDurability, status: 'good', repairCount: 0 }],
            equippedWeaponIndex: 0,
            ...hunt,
        },
    };
    ensureHuntData(user);
    return user;
}

describe('the approach is a read, and a correct read always pays', () => {
    const profile = APPROACH_PROFILES.grazing;
    const byBonus = b => profile.options.find(o => o.stealthBonus === b).id;

    test('the correct option is perfect and pays its full bonus, every time', () => {
        for (let n = 0; n < 50; n++) {
            expect(resolveStealth(profile, profile.correctId)).toMatchObject({ outcome: 'perfect', bonus: 0.25 });
        }
    });

    test('the safe option is decent, the wrong one spooks it', () => {
        expect(resolveStealth(profile, byBonus(0.05))).toMatchObject({ outcome: 'decent', bonus: 0.05 });
        expect(resolveStealth(profile, byBonus(-0.10))).toMatchObject({ outcome: 'spooked', bonus: -0.10 });
    });

    test('no answer, or one the profile does not know, is a timeout worth nothing', () => {
        expect(resolveStealth(profile, null)).toEqual({ outcome: 'timeout', bonus: 0, label: '' });
        expect(resolveStealth(profile, 'made_up')).toEqual({ outcome: 'timeout', bonus: 0, label: '' });
    });

    test('a correct read is never worth less than the safe one', () => {
        for (const p of Object.values(APPROACH_PROFILES)) {
            const best = resolveStealth(p, p.correctId).bonus;
            for (const o of p.options) expect(best).toBeGreaterThanOrEqual(resolveStealth(p, o.id).bonus);
        }
    });
});

describe('the option shuffle', () => {
    test('is a permutation — nothing lost, nothing doubled', () => {
        const items = ['a', 'b', 'c'];
        for (let n = 0; n < 20; n++) {
            expect([...shuffled(items)].sort()).toEqual(items);
        }
        expect(items).toEqual(['a', 'b', 'c']);
    });

    test('puts every option in every slot', () => {
        const seen = new Set();
        let r = 0;
        const source = () => { r = (r + 0.37) % 1; return r; };
        for (let n = 0; n < 60; n++) seen.add(shuffled(['a', 'b', 'c'], source)[0]);
        expect(seen).toEqual(new Set(['a', 'b', 'c']));
    });
});

describe('the odds the approach screen shows', () => {
    const zone = ZONES.beginner_forest;

    test('with no traits and no approach, they are the hunter\'s base chance', () => {
        const user = makeUser();
        const weapon = user.hunt.weapons[0];
        expect(huntSuccessChance(user, weapon, zone, [], 0)).toBeCloseTo(calculateSuccessChance(user, weapon, zone));
    });

    test('a perfect approach adds its bonus, and elusive prey takes some back', () => {
        const user = makeUser();
        const weapon = user.hunt.weapons[0];
        const base = huntSuccessChance(user, weapon, zone, [], 0);
        expect(huntSuccessChance(user, weapon, zone, [], 0.25)).toBeCloseTo(Math.min(0.95, base + 0.25));
        expect(huntSuccessChance(user, weapon, zone, ['elusive'], 0)).toBeCloseTo(Math.max(0.10, base - 0.10));
    });

    test('are clamped to the same 10–95% band the roll is', () => {
        const user = makeUser();
        const weapon = user.hunt.weapons[0];
        expect(huntSuccessChance(user, weapon, zone, [], 5)).toBe(0.95);
        expect(huntSuccessChance(user, weapon, zone, ['elusive'], -5)).toBe(0.10);
    });
});

describe('which apex a kill draws out', () => {
    test('follows the kill\'s traits', () => {
        expect(apexTypeIdFor(ANIMALS.white_wolf)).toBe('phantom_stag');     // spectral first
        expect(apexTypeIdFor(ANIMALS.wolf)).toBe('dire_alpha');             // pack hunter
        expect(apexTypeIdFor(ANIMALS.musk_ox)).toBe('ironhide_boar');       // armored
        expect(apexTypeIdFor(ANIMALS.golden_fox)).toBe('phantom_stag');     // elusive
        expect(apexTypeIdFor(ANIMALS.moose)).toBe('ironhide_boar');         // giant
        expect(apexTypeIdFor(ANIMALS.saber_cat)).toBe('dire_alpha');        // aggressive
    });

    test('trait-less prey draws any of them', () => {
        expect(Object.keys(APEX_TYPES)).toContain(apexTypeIdFor(ANIMALS.snowy_owl));
        expect(Object.keys(APEX_TYPES)).toContain(apexTypeIdFor(null));
    });

    test('the rolled duel is the keyed apex, with its id attached', () => {
        const duel = rollApexType(ANIMALS.wolf);
        expect(duel.id).toBe('dire_alpha');
        expect(duel.name).toBe(APEX_TYPES.dire_alpha.name);
        for (const phase of duel.phases) expect(APEX_TYPES.dire_alpha.phasePool).toContain(phase);
    });
});

describe('walking away from an apex', () => {
    const APEX = buildApexEncounter(APEX_TYPES.dire_alpha);
    const ANIMAL = { payoutMin: 100, payoutMax: 100 };

    function duel(choices, options) {
        const user = makeUser();
        const before = user.hunt.weapons[0].currentDurability;
        const result = resolveApexEncounter(user, ANIMAL, 'legendary', choices, APEX, 0, options);
        return { result, lost: before - user.hunt.weapons[0].currentDurability };
    }

    test('costs what losing costs — no better to go quiet than to fight badly', () => {
        const quit  = duel([APEX.phases[0].correct], { forfeit: true });
        const beaten = duel(APEX.phases.map(p => (p.correct === 'match' ? 'hold' : 'match')));

        expect(quit.result.outcome).toBe('escaped');
        expect(beaten.result.outcome).toBe('escaped');
        expect(quit.result.bonusPayout).toBe(0);
        expect(quit.lost).toBe(beaten.lost);
        expect(quit.result.durabilityLost).toBe(4);
    });

    test('says the hunter hesitated rather than that their nerve broke', () => {
        expect(duel([], { forfeit: true }).result.message).toMatch(/hesitated/);
        expect(duel(APEX.phases.map(p => (p.correct === 'match' ? 'hold' : 'match'))).result.message).toMatch(/broke your nerve/);
    });

    test('a duel fought to the end is untouched by the option', () => {
        const all = APEX.phases.map(p => p.correct);
        expect(duel(all, { forfeit: false }).result.outcome).toBe('perfect');
    });
});

describe('the readiness line', () => {
    const NOW = Date.parse('2026-09-24T12:00:00Z');

    test('counts down the cooldown live', () => {
        const user = makeUser({ lastHunt: new Date(NOW - 10_000) });
        const next = nextHuntReadiness(user, NOW);
        expect(next).toMatchObject({ ready: false, reason: 'cooldown' });
        expect(next.at.getTime()).toBe(NOW - 10_000 + LIMITS.HUNT_COOLDOWN_MS);
        expect(buildReadinessLine(user, NOW)).toBe(`⏱️ Next hunt <t:${Math.floor(next.at.getTime() / 1000)}:R>`);
    });

    test('an injury outlasting the cooldown is what it counts down to', () => {
        const user = makeUser({ lastHunt: new Date(NOW), injuryUntil: new Date(NOW + LIMITS.INJURY_PENALTY_MS) });
        expect(nextHuntReadiness(user, NOW).reason).toBe('injury');
        expect(buildReadinessLine(user, NOW)).toMatch(/^🤕 Injured — back on your feet <t:\d+:R>$/);
    });

    test('an empty stamina bar says when the next point lands', () => {
        const user = makeUser({ stamina: 0, lastHunt: new Date(NOW - LIMITS.HUNT_COOLDOWN_MS * 2) });
        expect(nextHuntReadiness(user, NOW).reason).toBe('stamina');
        expect(buildReadinessLine(user, NOW)).toMatch(/^😮‍💨 Out of stamina/);
    });

    test('with everything clear it says so', () => {
        const user = makeUser({ lastHunt: new Date(NOW - LIMITS.HUNT_COOLDOWN_MS - 1) });
        expect(buildReadinessLine(user, NOW)).toBe('🏹 Ready to head back out');
    });

    test('rides the bottom of the Kit', () => {
        const user = makeUser({ lastHunt: new Date(NOW) });
        const kit = buildKitField(user, user.hunt.weapons[0], ZONES.beginner_forest, '🪙', NOW);
        expect(kit.value.split('\n').at(-1)).toMatch(/^⏱️ Next hunt/);
    });
});

describe('the multiplier line', () => {
    test('multiplies out what it lists', () => {
        expect(buildMultiplierLine({ streakMult: 1.5, isCrit: true, critMultiplier: 2, trophyQuality: null }))
            .toBe('📈 🔥 1.50x × ⚡ 2.00x crit = **3.00x**');
    });

    test('ignores a crit multiplier on a hit that was not a crit', () => {
        expect(buildMultiplierLine({ streakMult: 1.2, isCrit: false, critMultiplier: 1, trophyQuality: null }))
            .toBe('📈 🔥 1.20x = **1.20x**');
    });
});

describe('fitEmbeds — what Discord will accept in one message', () => {
    const big = n => 'x'.repeat(n);
    const withFields = (names, size) => {
        // Straight onto the data: the builder itself refuses a 26th field,
        // and the point here is what happens when one gets there anyway.
        const e = new EmbedBuilder().setTitle('t').setDescription('d');
        e.data.fields = names.map(name => ({ name, value: big(size) }));
        return e;
    };
    const total = embeds => embeds.reduce((n, e) => n + e.data.title.length + e.data.description.length
        + (e.data.fields ?? []).reduce((m, f) => m + f.name.length + f.value.length, 0), 0);

    test('leaves a message under the limits alone', () => {
        const e = withFields(['🧬 Traits', '🎒 Kit'], 100);
        fitEmbeds([e]);
        expect(e.data.fields).toHaveLength(2);
    });

    test('holds a pair of embeds to 6,000 characters between them, trimming the least important first', () => {
        const card = withFields(['🌟 A Rare Companion Appears!', '🧬 Traits', '⚖️ Daily Limits', '🎒 Kit'], 1300);
        const duel = withFields(['⚠️ Payout Not Yet Credited'], 1000);
        fitEmbeds([card, duel]);

        expect(total([card, duel])).toBeLessThanOrEqual(6000);
        const names = card.data.fields.map(f => f.name);
        expect(names).not.toContain('🧬 Traits');
        expect(names).toContain('🌟 A Rare Companion Appears!');
        expect(duel.data.fields).toHaveLength(1);
    });

    test('never lets an embed past 25 fields', () => {
        const e = withFields(Array.from({ length: 30 }, (_, i) => `f${i}`), 1);
        fitEmbeds([e]);
        expect(e.data.fields).toHaveLength(25);
    });
});

describe('the server record the kill card measures against', () => {
    const GrindProfile = require('../src/models/GrindProfile');
    const { serverBestPayout } = require('../src/services/huntService');

    function chain(result) {
        const q = { sort: jest.fn(() => q), maxTimeMS: jest.fn(() => q), lean: jest.fn(() => result) };
        return q;
    }

    afterEach(() => { delete GrindProfile.findOne; });

    test('is everyone else\'s best, read highest-first and bounded', async () => {
        const q = chain(Promise.resolve({ data: { bestPayout: 3900 } }));
        GrindProfile.findOne = jest.fn(() => q);

        expect(await serverBestPayout('g1', 'u1')).toBe(3900);
        const [filter] = GrindProfile.findOne.mock.calls[0];
        expect(filter).toMatchObject({ guildId: 'g1', system: 'hunt', userId: { $ne: 'u1' } });
        expect(q.sort).toHaveBeenCalledWith({ 'data.bestPayout': -1 });
        expect(q.maxTimeMS).toHaveBeenCalled();
    });

    test('is zero on a server nobody else has hunted', async () => {
        GrindProfile.findOne = jest.fn(() => chain(Promise.resolve(null)));
        expect(await serverBestPayout('g1', 'u1')).toBe(0);
    });

    test('is unknown, not zero, when the read fails', async () => {
        GrindProfile.findOne = jest.fn(() => chain(Promise.reject(new Error('timeout'))));
        expect(await serverBestPayout('g1', 'u1')).toBeNull();
    });
});
