'use strict';

// Branch coverage for src/commands/economy/mine/embeds.js (#998).
//
// The mine's companion to tests/fishEmbeds.test.js, and pure for the same
// reason: the file takes its result, its user and its pickaxe as arguments and
// reads nothing else. `src/commands/economy/mine` measured 2.13% of 705
// branches, 157 of which are here.
//
// The one clock-dependent path is `msUntilDailyReset`, which derives from
// `user.mining.dailyWindowStart` — so it is steered by the fixture rather than
// mocked: an absent window start is the "no reset note" case.

const {
    buildActiveConsumablesLine,
    buildDailyProgressLine,
    buildFailureTitle,
    buildMineEmbed,
    buildProgressBar,
    buildStaminaLine,
    buildThrottleField,
    buildXpBar,
    buildXpLine,
    nextDigLine,
    prestigeBonusLines,
} = require('../src/commands/economy/mine/embeds');

const { DEPTHS, LIMITS, MINER_LEVELS, ORES, TIER_COLORS } = require('../src/data/mineData');
const { TIER_NUM, TIER_STARS } = require('../src/data/materialRarity');
const { FEATURED_PAYOUT_BONUS } = require('../src/data/featuredRotation');

const quarry = DEPTHS.surface_quarry;

/** The fields of an embed, keyed by name, for asserting without index arithmetic. */
function fieldsOf(embed) {
    return Object.fromEntries((embed.data.fields ?? []).map(f => [f.name, f.value]));
}

/**
 * A miner mid-ladder with no buff running and no daily window open, so
 * `msUntilDailyReset` reads null and the reset note is a decision each test
 * makes by seeding `dailyWindowStart` rather than one the fixture makes for it.
 */
function makeUser(mining = {}) {
    return {
        balance: 98_765,
        mining: {
            level: 5,
            xp: 640,
            prestige: 2,
            stamina: 7,
            dailyCoins: 0,
            dailyMines: 0,
            consecutiveFails: 0,
            activeMagnet: null,
            activeLamp: null,
            activeInstinct: false,
            activeXpScroll: false,
            ...mining,
        },
    };
}

/** A pickaxe at 60/80 — healthy, and above the 20% mark the low-durability warning fires at. */
function makePickaxe(over = {}) {
    return { name: 'Wooden Pickaxe', status: 'good', currentDurability: 60, maxDurability: 80, ...over };
}

/** A plain common strike: no multiplier, no cap, no drop, so a test turns on only what it asserts. */
function digResult(over = {}) {
    return {
        success: true,
        ore: ORES.stone,
        tier: 'common',
        finalPayout: 150,
        xpEarned: 10,
        isCrit: false,
        critMultiplier: 1,
        specialDrop: null,
        levelUp: null,
        cappedByHard: false,
        ...over,
    };
}

/** The mildest failure — no injury, no collapse — for the same reason: nothing on by default. */
function failureResult(over = {}) {
    return {
        success: false,
        failure: { severity: { id: 'clean_miss', injuryMs: 0 }, message: 'The vein ran dry.' },
        xpEarned: 0,
        levelUp: null,
        ...over,
    };
}

const dig = (result, user = makeUser(), pickaxe = makePickaxe()) =>
    buildMineEmbed(result, user, quarry, pickaxe, '🪙', null);

describe('buildMineEmbed — headline tiers', () => {
    test('an event strike outranks a critical for both colour and headline', () => {
        const embed = dig(digResult({ tier: 'event', isCrit: true, critMultiplier: 2 }));
        expect(embed.data.color).toBe(parseInt(TIER_COLORS.event.slice(1), 16));
        expect(embed.data.title).toBe('☄️🌋 PRIMORDIAL STRIKE 🌋☄️');
        expect(embed.data.description).toContain('should not be down there');
    });

    test('a legendary strike gets the legendary headline and lede', () => {
        const embed = dig(digResult({ tier: 'legendary' }));
        expect(embed.data.title).toBe('⛏️✨ LEGENDARY STRIKE ✨⛏️');
        expect(embed.data.description).toContain('You struck something impossible in the deep.');
    });

    test('a critical below legendary is gold and says CRITICAL', () => {
        const embed = dig(digResult({ tier: 'rare', isCrit: true, critMultiplier: 2.5 }));
        expect(embed.data.color).toBe(0xFFD700);
        expect(embed.data.title).toContain('✨ CRITICAL!');
        expect(fieldsOf(embed).XP).toMatch(/^\+10 XP \(crit bonus\)\n/);
    });

    test('an ordinary strike is just the ore and its flavour', () => {
        const embed = dig(digResult());
        expect(embed.data.title).toBe(`${ORES.stone.emoji} ${ORES.stone.name} `);
        expect(fieldsOf(embed).Reward).toContain(`Common · ${quarry.emoji} ${quarry.name}`);
        expect(embed.data.description).toContain(ORES.stone.flavor);
    });

    // `TIER_NUM[tier] ?? 1` reads as a fallback for a tier the rarity table has
    // not heard of, but it cannot fire: the colour lookup above it is an
    // unguarded `TIER_COLORS[tier]` and setColor throws on the undefined it
    // would get. The invariant that actually holds is the tables agreeing.
    test('every tier an ore can roll is in all three rarity tables', () => {
        for (const tier of [...new Set(Object.values(ORES).map(o => o.tier))]) {
            expect([tier, TIER_COLORS[tier] !== undefined]).toEqual([tier, true]);
            expect([tier, TIER_NUM[tier] !== undefined]).toEqual([tier, true]);
            expect([tier, TIER_STARS[TIER_NUM[tier]] !== undefined]).toEqual([tier, true]);
        }
    });
});

describe('buildMineEmbed — payout display', () => {
    test('an uncapped haul prints the payout it actually paid', () => {
        expect(fieldsOf(dig(digResult({ finalPayout: 1234 }))).Reward.split('\n')[0]).toBe('**🪙1,234**');
    });

    // The strikethrough used to be drawn over finalPayout, which is already 0 at
    // the hard cap — it struck out the wrong number and never said what the cap
    // cost. It is drawn over the forfeited amount instead.
    test('a capped haul strikes through what the cap took, not the zero it left', () => {
        expect(fieldsOf(dig(digResult({ cappedByHard: true, finalPayout: 0, forfeited: 900 }))).Reward.split('\n')[0])
            .toBe('~~🪙900~~ → **🪙0**');
    });

    test('a capped haul with no recorded forfeit reads as zero rather than undefined', () => {
        expect(fieldsOf(dig(digResult({ cappedByHard: true, finalPayout: 0 }))).Reward.split('\n')[0])
            .toBe('~~🪙0~~ → **🪙0**');
    });
});

describe('buildMineEmbed — the multiplier stack', () => {
    test('a flat dig with nothing stacked shows no multiplier field', () => {
        expect(fieldsOf(dig(digResult()))['📈 Multipliers']).toBeUndefined();
    });

    test('a factor within half a percent of 1x is not worth a row', () => {
        const embed = dig(digResult({ streakMult: 1.002, artificerRate: 0.001 }));
        expect(fieldsOf(embed)['📈 Multipliers']).toBeUndefined();
    });

    test('every multiplicative factor the dig carried gets a row', () => {
        const embed = dig(digResult({
            finalPayout: 5000,
            streakMult: 1.5,
            isCrit: true,
            critMultiplier: 2,
            intensityLevel: { name: 'Reckless', emoji: '🔥', multiplier: 3 },
            featuredDepthBonus: 100,
            petYieldBonus: 50,
            petYieldPct: 20,
            wildernessBonus: 30,
            artificerRate: 0.15,
            gatheringYield: { label: 'Rich Vein', emoji: '✨', chargesLeft: 2 },
        }));
        const stack = fieldsOf(embed)['📈 Multipliers'];
        expect(stack).toContain('1.50x');
        expect(stack).toContain('2.00x crit');
        expect(stack).toContain('3.00x reckless');
        expect(stack).toContain(`${(1 + FEATURED_PAYOUT_BONUS).toFixed(2)}x featured`);
        expect(stack).toContain('1.20x pet');
        expect(stack).toContain('1.10x district');
        expect(stack).toContain('1.15x artificer');
        expect(stack).toContain('2.00x yield');
    });

    // An unpaid cave-in keeps the intensity multiplier off the stack: the dig did
    // not get the intensity payout, so printing its factor would not reconcile.
    test('an unpaid cave-in drops the intensity multiplier from the stack', () => {
        const embed = dig(digResult({
            finalPayout: 400, streakMult: 1.5,
            intensityLevel: { name: 'Reckless', emoji: '🔥', multiplier: 3 },
            caveIn: true, caveInBonusPaid: false,
        }));
        expect(fieldsOf(embed)['📈 Multipliers']).not.toContain('x reckless');
    });

    test('a cave-in that still paid its bonus keeps the intensity multiplier', () => {
        const embed = dig(digResult({
            finalPayout: 400,
            intensityLevel: { name: 'Reckless', emoji: '🔥', multiplier: 3 },
            caveIn: true, caveInBonusPaid: true,
        }));
        expect(fieldsOf(embed)['📈 Multipliers']).toContain('3.00x reckless');
    });

    // The pet's percentage and its coin bonus are recorded separately, so a
    // bonus with no percentage beside it would render "1.00x pet" — a row that
    // says the pet did nothing. The factor collapses to 1 and the row is
    // dropped instead.
    test('a pet bonus with no recorded percentage contributes no row', () => {
        const embed = dig(digResult({ finalPayout: 400, streakMult: 1.5, petYieldBonus: 50 }));
        const stack = fieldsOf(embed)['📈 Multipliers'];
        expect(stack).toContain('1.50x');
        expect(stack).not.toContain('x pet');
    });

    test('an intensity level with no multiplier falls back to a flat roll', () => {
        const embed = dig(digResult({ finalPayout: 400, intensityLevel: {}, streakMult: 1.4 }));
        const stack = fieldsOf(embed)['📈 Multipliers'];
        expect(stack).toContain('1.40x');
        expect(stack).not.toContain('x push');
    });

    test('a stack on a haul that paid nothing is not rendered', () => {
        const embed = dig(digResult({ finalPayout: 0, streakMult: 2 }));
        expect(fieldsOf(embed)['📈 Multipliers']).toBeUndefined();
    });
});

describe('buildMineEmbed — optional fields', () => {
    test('a gathering charge counts down and pluralises', () => {
        expect(fieldsOf(dig(digResult({ gatheringYield: { label: 'Rich Vein', emoji: '✨', chargesLeft: 3 } })))['✨ Rich Vein'])
            .toContain('3 charges left');
        expect(fieldsOf(dig(digResult({ gatheringYield: { label: 'Rich Vein', emoji: '✨', chargesLeft: 1 } })))['✨ Rich Vein'])
            .toContain('1 charge left');
    });

    test('the last gathering charge says so instead of counting zero', () => {
        expect(fieldsOf(dig(digResult({ gatheringYield: { label: 'Rich Vein', emoji: '✨', chargesLeft: 0 } })))['✨ Rich Vein'])
            .toContain('**last charge**');
    });

    test('every remaining optional field fires at once', () => {
        const embed = dig(digResult({
            specialDrop: { name: 'Rock Fragment' },
            levelUp: { oldLevel: 5, newLevel: 6 },
            expiredMagnet: 'premium_magnet',
            expiredLamp: true,
        }), makeUser(), makePickaxe({ currentDurability: 8 }));
        const fields = fieldsOf(embed);
        expect(fields['🪨 Material Drop!']).toContain('Rock Fragment');
        expect(fields['⬆️ Level Up!']).toContain('**5** → **6**');
        expect(fields['⌛ Buff Ended']).toContain('premium magnet');
        expect(fields['⌛ Buff Ended']).toContain('lamp has flickered out');
        expect(fields['⚠️ Low Durability']).toContain('8/80');
        expect(fields.Reward).toContain('Balance 🪙98,765');
    });

    test('a broken pickaxe outranks the low-durability warning', () => {
        const fields = fieldsOf(dig(digResult(), makeUser(), makePickaxe({ status: 'broken', currentDurability: 0 })));
        expect(fields['⚠️ Pickaxe Broke!']).toContain('/mine shop repair');
        expect(fields['⚠️ Low Durability']).toBeUndefined();
    });

    test('a healthy pickaxe raises neither warning', () => {
        const fields = fieldsOf(dig(digResult()));
        expect(fields['⚠️ Pickaxe Broke!']).toBeUndefined();
        expect(fields['⚠️ Low Durability']).toBeUndefined();
    });

    test('a throttled dig carries the throttle field into the success embed', () => {
        const embed = dig(digResult({ softCapped: true }), makeUser({ dailyCoins: 90_000 }));
        expect(fieldsOf(embed)['⏳ Daily Throttle']).toContain('payouts are halved');
        expect(embed.data.footer.text).toContain('Today:');
        expect(embed.data.footer.text).not.toContain('Cooldown');
    });
});

describe('buildMineEmbed — failure', () => {
    test('a plain failure reports no reward and no XP', () => {
        const embed  = dig(failureResult());
        const fields = fieldsOf(embed);
        expect(embed.data.description).toContain('nothing came up');
        expect(fields.XP).toBe('None');
        expect(fields.Gear.split('\n').pop()).toBe('7/11 ⚡');
    });

    test('a failure that still paid XP prints the amount', () => {
        expect(fieldsOf(dig(failureResult({ xpEarned: 5 }))).XP).toBe('+5 XP');
    });

    test('an empty vein annotates the stamina line instead of spending it', () => {
        expect(fieldsOf(dig(failureResult({ staminaSpared: true }))).Gear)
            .toContain('Empty vein — no stamina spent');
    });

    test('a fail streak adds the pity field', () => {
        expect(dig(failureResult(), makeUser({ consecutiveFails: 3 })).data.fields.length)
            .toBeGreaterThan(2);
    });

    test('a missing fail counter is read as no streak', () => {
        expect(dig(failureResult(), makeUser({ consecutiveFails: undefined })).data.fields)
            .toHaveLength(2);
    });

    test('an injury and a level-up both annotate the same failure', () => {
        const fields = fieldsOf(dig(failureResult({
            failure: { severity: { id: 'cave_in', injuryMs: 900_000 }, message: 'The roof came down.' },
            levelUp: { oldLevel: 2, newLevel: 3 },
        })));
        expect(fields['🤕 Pinned']).toContain('15m');
        expect(fields['⬆️ Level Up!']).toContain('**2** → **3**');
    });

    // A collapse already explains the destroyed pickaxe in its own field, so the
    // generic "Pickaxe Broke!" is suppressed rather than printed beside it.
    test('a catastrophic collapse recolours the embed and suppresses the broke field', () => {
        const embed = dig(
            failureResult({ collapseEvent: { weaponName: 'Iron Pickaxe' } }),
            makeUser(),
            makePickaxe({ status: 'broken' }),
        );
        expect(embed.data.color).toBe(0x8B0000);
        expect(fieldsOf(embed)['💀 Catastrophic Collapse!']).toContain('Iron Pickaxe');
        expect(fieldsOf(embed)['❌ Pickaxe Broke!']).toBeUndefined();
    });

    test('a broken pickaxe without a collapse gets the plain broke field', () => {
        const embed = dig(failureResult(), makeUser(), makePickaxe({ status: 'broken' }));
        expect(fieldsOf(embed)['❌ Pickaxe Broke!']).toContain('/mine shop repair');
        expect(embed.data.footer.text).toContain('Tip:');
    });
});

describe('buildThrottleField', () => {
    const withWindow = () => makeUser({ dailyWindowStart: new Date() });

    test('a dig under every limit needs no field', () => {
        expect(buildThrottleField(makeUser(), digResult(), '🪙')).toBeNull();
    });

    test('the hard cap explains what still counts, and when it lifts', () => {
        const field = buildThrottleField(withWindow(), digResult({ cappedByHard: true }), '🪙');
        expect(field.name).toBe('🛑 Daily Cap Reached');
        expect(field.value).toContain(LIMITS.DAILY_HARD_CAP.toLocaleString());
        expect(field.value).toContain('Resets in');
        expect(field.value).toContain('quest progress still count');
    });

    test('the hard cap with no window open omits the reset note', () => {
        const field = buildThrottleField(makeUser(), digResult({ cappedByHard: true }), '🪙');
        expect(field.value).not.toContain('Resets in');
    });

    test('the soft cap says payouts are halved', () => {
        const field = buildThrottleField(makeUser(), digResult({ softCapped: true }), '🪙');
        expect(field.name).toBe('⏳ Daily Throttle');
        expect(field.value).toContain(LIMITS.DAILY_SOFT_CAP.toLocaleString());
    });

    test('fatigue names the dig count and the surviving percentage', () => {
        const field = buildThrottleField(makeUser({ dailyMines: 95 }), digResult({ fatigueMult: 0.6 }), '🪙');
        expect(field.value).toContain('**95** digs today');
        expect(field.value).toContain('**60%**');
    });

    test('a full fatigue multiplier is not a throttle', () => {
        expect(buildThrottleField(makeUser(), digResult({ fatigueMult: 1 }), '🪙')).toBeNull();
    });

    test('a throttled dig that forfeited coins names the amount', () => {
        const field = buildThrottleField(withWindow(), digResult({ softCapped: true, forfeited: 250 }), '🪙');
        expect(field.value).toContain('gave up 🪙250');
        expect(field.value).toContain('Resets in');
    });

    test('a throttled dig that forfeited nothing still says when the window resets', () => {
        const field = buildThrottleField(withWindow(), digResult({ softCapped: true, forfeited: 0 }), '🪙');
        expect(field.value).not.toContain('gave up');
        expect(field.value).toContain('Resets in');
    });

    test('a throttled dig with no window open says neither', () => {
        const field = buildThrottleField(makeUser(), digResult({ softCapped: true, forfeited: 0 }), '🪙');
        expect(field.value).not.toContain('gave up');
        expect(field.value).not.toContain('Resets in');
    });
});

describe('buildFailureTitle', () => {
    test.each([
        ['clean_miss', '💨 Empty Vein!'],
        ['rockfall',   '🪨 Rockfall!'],
        ['stuck',      '🔧 Pickaxe Stuck!'],
        ['cave_in',    '🤕 Pinned!'],
    ])('%s renders its own title', (id, expected) => {
        expect(buildFailureTitle(id)).toBe(expected);
    });

    test('an unknown severity falls back rather than rendering undefined', () => {
        expect(buildFailureTitle('who_knows')).toBe('❌ Failed Mine');
    });
});

describe('line and bar helpers', () => {
    test('buildStaminaLine adds the prestige bonus to the base maximum', () => {
        expect(buildStaminaLine(makeUser({ stamina: 3, prestige: 0 }))).toBe('3/10 ⚡');
        expect(buildStaminaLine(makeUser({ stamina: 3, prestige: 5 }))).toBe('3/11 ⚡');
    });

    test('buildXpLine counts down to the next level, or reports the cap', () => {
        expect(buildXpLine(makeUser({ level: 1, xp: 0 }))).toBe('0 XP (100 to Lv.2)');
        expect(buildXpLine(makeUser({ level: 50, xp: 999_999 }))).toBe('999,999 XP (MAX)');
    });

    test('buildDailyProgressLine compacts thousands and drops the decimal past ten', () => {
        expect(buildDailyProgressLine(makeUser({ dailyCoins: 750 }), '🪙')).toContain('🪙750/');
        expect(buildDailyProgressLine(makeUser({ dailyCoins: 1_500 }), '🪙')).toContain('🪙1.5k/');
        expect(buildDailyProgressLine(makeUser({ dailyCoins: 42_000 }), '🪙')).toContain('🪙42k/');
    });

    test('buildDailyProgressLine reads an absent daily total as zero', () => {
        expect(buildDailyProgressLine(makeUser({ dailyCoins: undefined }), '🪙')).toContain('🪙0/');
    });

    test('buildActiveConsumablesLine lists what is running, or says nothing is', () => {
        expect(buildActiveConsumablesLine(makeUser())).toBe('No active buffs');
        expect(buildActiveConsumablesLine(makeUser({
            activeMagnet: 'ore_magnet', activeMagnetMinesLeft: 4,
            activeLamp: true, activeLampMinesLeft: 2,
            activeInstinct: true, activeXpScroll: true,
        }))).toBe('Magnet (4 mines left) • Lamp (2 mines left) • Instinct (queued) • XP Scroll (queued)');
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
    // lookup misses and reads 0, and MINER_LEVELS[0] — level 1 — requires 0 too,
    // so the band has no width. Every real level band does, which is the
    // invariant that keeps the guard from firing in play.
    test('buildXpBar reads a zero-width level band as no progress rather than NaN', () => {
        expect(buildXpBar({ level: 0, xp: 0 }, 100)).toBe(`${'░'.repeat(20)} 0%`);
        for (let i = 1; i < MINER_LEVELS.length; i++) {
            expect([i, MINER_LEVELS[i].xpRequired > MINER_LEVELS[i - 1].xpRequired])
                .toEqual([i, true]);
        }
    });

    test('buildProgressBar defaults to ten cells and clamps to the target', () => {
        expect(buildProgressBar(0, 10)).toBe(`[${'░'.repeat(10)}]`);
        expect(buildProgressBar(5, 10)).toBe(`[${'█'.repeat(5)}${'░'.repeat(5)}]`);
        expect(buildProgressBar(99, 10)).toBe(`[${'█'.repeat(10)}]`);
        expect(buildProgressBar(2, 4, 20)).toBe(`[${'█'.repeat(10)}${'░'.repeat(10)}]`);
    });
});

describe('formatters', () => {
    test('prestigeBonusLines lists only the bonuses that are non-zero', () => {
        expect(prestigeBonusLines({ critBonus: 0, staminaBonus: 0, payoutBonus: 0, rarityBonus: 0 }))
            .toEqual([]);
        expect(prestigeBonusLines({ critBonus: 0.02, staminaBonus: 1, payoutBonus: 0.1, rarityBonus: 0.02 }))
            .toEqual([
                '+2% crit chance',
                '+1 max stamina',
                '+10% all payouts',
                '+2% rarity boost',
            ]);
    });
});

describe('the result card stays lean', () => {
    test('a plain strike carries three fields, not eight', () => {
        expect(dig(digResult()).data.fields.map(f => f.name)).toEqual(['Reward', 'XP', 'Gear']);
    });
});

describe('nextDigLine', () => {
    const now = 1_800_000_000_000;

    test('counts down to the end of the cooldown as a live timestamp', () => {
        const user = makeUser({ lastMine: new Date(now - 10_000) });
        expect(nextDigLine(user, now)).toBe(`⛏️ Next dig <t:${Math.ceil((now + 20_000) / 1000)}:R>`);
    });

    test('an injury that outlasts the cooldown is what it counts to', () => {
        const user = makeUser({ lastMine: new Date(now), injuryUntil: new Date(now + 900_000) });
        expect(nextDigLine(user, now)).toContain(`<t:${Math.ceil((now + 900_000) / 1000)}:R>`);
    });

    test('says so when nothing is in the way', () => {
        expect(nextDigLine(makeUser({ lastMine: new Date(now - 60_000) }), now)).toBe('⛏️ Ready to dig again');
    });

    test('an empty stamina bar is the thing to wait for', () => {
        expect(nextDigLine(makeUser({ stamina: 0 }), now)).toMatch(/^😮‍💨 Out of stamina/);
    });
});
