'use strict';

// Three of the five synergies shipped as decoration: synergyService defined and
// exported a getter for each advertised bonus, and nothing on the other side
// ever called it. Deep Prospector granted no stamina in either system, Artificer
// granted neither its stamina nor its ore yield, and Merchant paid nothing on
// /work or /crime. The same held for the 100,000-coin "Permanent Stamina +1"
// shop item. These tests hold every one of those promises to the code.

const fs = require('fs');
const path = require('path');

const { SYNERGIES, SYNERGY_LIST, MAX_STAMINA_UPGRADES } = require('../src/data/crossSystemData');
const huntService = require('../src/services/huntService');
const fishService = require('../src/services/fishService');
const mineService = require('../src/services/mineService');

// A user whose grind levels are high enough to hold every synergy at once.
function makeUser(overrides = {}) {
    return {
        hunt:    { level: 60, prestige: 0 },
        fishing: { level: 60, prestige: 0 },
        mining:  { level: 60, prestige: 0 },
        inventory: [],
        pets: [],
        ...overrides,
    };
}

// A user below every synergy requirement.
function makeNovice(overrides = {}) {
    return {
        hunt:    { level: 1, prestige: 0 },
        fishing: { level: 1, prestige: 0 },
        mining:  { level: 1, prestige: 0 },
        inventory: [],
        pets: [],
        ...overrides,
    };
}

describe('every synergy bonus is read by something', () => {
    const srcRoot = path.join(__dirname, '..', 'src');

    function sourceFiles(dir) {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return sourceFiles(full);
            return entry.name.endsWith('.js') ? [full] : [];
        });
    }

    test('no synergy getter is exported and then never called', () => {
        const service = fs.readFileSync(path.join(srcRoot, 'services', 'synergyService.js'), 'utf8');
        const getters = [...service.matchAll(/^function (get\w+|has\w+)\(/gm)]
            .map(m => m[1])
            .filter(name => name !== 'getActiveSynergies' && name !== 'hasSynergy');
        expect(getters.length).toBeGreaterThan(0);

        const others = sourceFiles(srcRoot)
            .filter(f => !f.endsWith(path.join('services', 'synergyService.js')))
            .map(f => fs.readFileSync(f, 'utf8'))
            .join('\n');

        const unused = getters.filter(name => !others.includes(name));
        expect(unused).toEqual([]);
    });

    test('every synergy in the table has service support at all', () => {
        // Boolean synergies are exposed as a checker that names the synergy
        // rather than the bonus key (hasIronWill), so match on the id.
        const service = fs.readFileSync(path.join(srcRoot, 'services', 'synergyService.js'), 'utf8');
        const unsupported = SYNERGY_LIST.filter(s => !service.includes(`'${s.id}'`));
        expect(unsupported.map(s => s.id)).toEqual([]);
    });
});

describe('stamina synergies actually raise max stamina', () => {
    test('Outdoorsman lifts hunting and fishing', () => {
        const novice = makeNovice();
        const user = makeNovice({ hunt: { level: 30, prestige: 0 }, fishing: { level: 30, prestige: 0 } });
        const lift = SYNERGIES.outdoorsman.bonuses.huntStamina;
        expect(huntService.getMaxStamina(user)).toBe(huntService.getMaxStamina(novice) + lift);
        expect(fishService.getMaxStamina(user)).toBe(fishService.getMaxStamina(novice) + lift);
    });

    test('Deep Prospector lifts fishing and mining', () => {
        const novice = makeNovice();
        const user = makeNovice({ fishing: { level: 30, prestige: 0 }, mining: { level: 30, prestige: 0 } });
        expect(fishService.getMaxStamina(user))
            .toBe(fishService.getMaxStamina(novice) + SYNERGIES.deep_prospector.bonuses.fishingStamina);
        expect(mineService.getMaxStamina(user))
            .toBe(mineService.getMaxStamina(novice) + SYNERGIES.deep_prospector.bonuses.miningStamina);
    });

    test('Artificer lifts mining on its own', () => {
        const novice = makeNovice();
        const user = makeNovice({ mining: { level: 50, prestige: 0 } });
        expect(mineService.getMaxStamina(user))
            .toBe(mineService.getMaxStamina(novice) + SYNERGIES.artificer.bonuses.miningStamina);
    });

    test('Deep Prospector and Artificer stack on mining', () => {
        const novice = makeNovice();
        const user = makeUser();
        const expected = SYNERGIES.deep_prospector.bonuses.miningStamina
                       + SYNERGIES.artificer.bonuses.miningStamina;
        expect(mineService.getMaxStamina(user)).toBe(mineService.getMaxStamina(novice) + expected);
    });
});

describe('the Permanent Stamina +1 shop item does something', () => {
    test('each upgrade raises max stamina in all three systems', () => {
        const base = makeNovice();
        for (let n = 1; n <= MAX_STAMINA_UPGRADES; n++) {
            const user = makeNovice({ staminaUpgrades: n });
            expect(huntService.getMaxStamina(user)).toBe(huntService.getMaxStamina(base) + n);
            expect(fishService.getMaxStamina(user)).toBe(fishService.getMaxStamina(base) + n);
            expect(mineService.getMaxStamina(user)).toBe(mineService.getMaxStamina(base) + n);
        }
    });

    test('a count beyond the cap is clamped rather than trusted', () => {
        const capped = makeNovice({ staminaUpgrades: MAX_STAMINA_UPGRADES });
        const absurd = makeNovice({ staminaUpgrades: 99 });
        expect(huntService.getMaxStamina(absurd)).toBe(huntService.getMaxStamina(capped));
        expect(fishService.getMaxStamina(absurd)).toBe(fishService.getMaxStamina(capped));
        expect(mineService.getMaxStamina(absurd)).toBe(mineService.getMaxStamina(capped));
    });

    test('a negative count cannot drain stamina', () => {
        const base = makeNovice();
        const drained = makeNovice({ staminaUpgrades: -5 });
        expect(huntService.getMaxStamina(drained)).toBe(huntService.getMaxStamina(base));
        expect(fishService.getMaxStamina(drained)).toBe(fishService.getMaxStamina(base));
        expect(mineService.getMaxStamina(drained)).toBe(mineService.getMaxStamina(base));
    });

    test('the shop entry tells players how to apply it', () => {
        const { DEFAULT_SHOP_ITEMS } = require('../src/data/defaultShopItems');
        const item = DEFAULT_SHOP_ITEMS.find(i => i.itemId === 'permanent_stamina');
        expect(item).toBeDefined();
        expect(item.description).toMatch(/\/use/);
    });
});

describe('Merchant pays only while you are carrying something', () => {
    const { getMerchantCoinBonus } = require('../src/services/synergyService');
    const srcRoot = path.join(__dirname, '..', 'src');

    test('an empty bag earns nothing from it', () => {
        expect(getMerchantCoinBonus(makeUser({ inventory: [] }))).toBe(0);
    });

    test('a full bag earns the advertised rate', () => {
        const user = makeUser({ inventory: [{ itemId: 'anything', quantity: 1 }] });
        expect(getMerchantCoinBonus(user)).toBe(SYNERGIES.merchant.bonuses.workCrimeCoinPct);
    });

    test('someone below the requirements earns nothing either way', () => {
        const user = makeNovice({ inventory: [{ itemId: 'anything', quantity: 1 }] });
        expect(getMerchantCoinBonus(user)).toBe(0);
    });

    test('the bonus is shown wherever it is paid', () => {
        // /work and /crime both break their payout down into a stack bar. A
        // multiplier folded into the credited coins but left out of that bar
        // makes the breakdown add up to a different number than the one above
        // it — which is how this bonus shipped in both commands.
        for (const file of ['work.js', 'crime.js']) {
            const src = fs.readFileSync(path.join(srcRoot, 'commands', 'economy', file), 'utf8');
            expect(src).toContain('merchantMult');
            // It has to appear in the entries the bar renders. The combined
            // value it is checked against already carries it in both commands —
            // what was missing, in both, was the entry naming it.
            const listed = src.split('\n').some(l =>
                /merchantMult/.test(l) && /[Ee]ntries\.push/.test(l));
            expect(listed).toBe(true);
        }
    });

    test('the commands that pay it load the levels it is judged on', () => {
        // hunt/fishing/mining live in GrindProfile, not on the User document, so
        // a command that reads a bare User sees level 0 everywhere and quietly
        // decides no synergy is active. Paying the bonus requires attaching them.
        for (const file of ['work.js', 'crime.js']) {
            const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'economy', file), 'utf8');
            expect(src).toContain('getMerchantCoinBonus');
            const attachAt = src.indexOf('attachGrind(');
            const useAt    = src.indexOf('getMerchantCoinBonus(user)');
            expect(attachAt).toBeGreaterThan(-1);
            expect(useAt).toBeGreaterThan(attachAt);
        }
    });
});
