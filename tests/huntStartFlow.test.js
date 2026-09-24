'use strict';

// /hunt start end to end: the approach prompt, the shot, the result card and
// the apex duel, driven through fake Discord objects against the real hunt
// service. Everything with I/O — the database, quests, achievements, the
// weekly race — is stubbed at the module edge, so what is under test is the
// orchestration in start.js and apex.js: the order things are said in, what is
// acknowledged when, and which numbers reach the roll.
//
// Every bug the review of this flow found was in that seam, and none of it had
// a test: a final apex click that was never acknowledged, a duel that kept
// asking after it was lost, a timeout that beat losing, the apex priced in the
// wrong zone, a correct read that was penalised, an animal swapped after the
// hint named it, collectors that could hang, and quest pop-ups under the fog.

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/utils/delay', () => ({ delay: () => Promise.resolve() }));
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async u => u), persistGrindIfNew: jest.fn() }));
jest.mock('../src/utils/balanceDelta', () => ({ saveWithBalanceDelta: jest.fn().mockResolvedValue({ credited: true }) }));
jest.mock('../src/utils/itemImageHelper', () => ({ attachResultThumbnail: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/utils/bigWinLogger', () => ({ logBigWin: jest.fn() }));
jest.mock('../src/utils/weeklyChampion', () => ({
    addWeeklyChampionProgress: jest.fn().mockResolvedValue(null),
    getWeeklyChampionLeader: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/services/questService', () => ({
    ensureQuests: jest.fn().mockResolvedValue(),
    onHunt: jest.fn().mockResolvedValue({ completed: [], nearComplete: [] }),
    onEconomyEarn: jest.fn().mockResolvedValue({ completed: [], nearComplete: [] }),
    notifyQuestComplete: jest.fn().mockResolvedValue(),
    notifyQuestNearComplete: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/services/seasonMissionService', () => ({ recordMissionProgress: jest.fn() }));
jest.mock('../src/services/achievementService', () => ({
    checkAndAward: jest.fn().mockResolvedValue([]),
    announceAchievements: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/services/petService', () => ({
    ...jest.requireActual('../src/services/petService'),
    tryGrantRarePet: jest.fn(() => null),
}));
jest.mock('../src/commands/economy/hunt/actions', () => ({
    ...jest.requireActual('../src/commands/economy/hunt/actions'),
    attachResultActions: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/services/huntService', () => {
    const actual = jest.requireActual('../src/services/huntService');
    return {
        ...actual,
        prepareHuntUser: jest.fn(async (user, { quickHunt }) => {
            actual.ensureHuntData(user);
            return quickHunt ?? user.hunt.quickHunt ?? false;
        }),
        claimHuntCooldown: jest.fn(async user => {
            user.hunt.lastHunt = new Date();
            return { claimed: true, release: jest.fn() };
        }),
        commitHunt: jest.fn().mockResolvedValue({ payoutOwed: 0 }),
        rollApexType: jest.fn(actual.rollApexType),
        applyPayoutModifiers: jest.fn(actual.applyPayoutModifiers),
    };
});

const User = require('../src/models/User');
const huntService = require('../src/services/huntService');
const questService = require('../src/services/questService');
const { attachResultActions } = require('../src/commands/economy/hunt/actions');
const { __setRandomSourceForTests } = require('../src/utils/secureRandom');
const { ANIMALS, ANIMALS_BY_TIER, APEX_TYPES, ZONES, WEAPON_TIERS } = require('../src/data/huntData');
const { executeStart, runApproach } = require('../src/commands/economy/hunt/start');
const { runApexDuel, APEX_PHASE_MS } = require('../src/commands/economy/hunt/apex');
const { APPROACH_PROFILES } = require('../src/commands/economy/hunt/aim');
const { EmbedBuilder } = require('discord.js');

const USER_ID = 'u1';

// ── Fakes ────────────────────────────────────────────────────────────────────

/** A component collector that keeps its own deadline and honours `filter` and `max`. */
function fakeCollector(opts) {
    const c = {
        opts, handlers: {}, ended: false, timer: null, collected: 0,
        on(ev, fn) { c.handlers[ev] = fn; return c; },
        arm(ms) { clearTimeout(c.timer); if (ms) c.timer = setTimeout(() => c.finish('time'), ms); },
        resetTimer({ time }) { c.arm(time); },
        stop(reason = 'user') { c.finish(reason); },
        finish(reason) {
            if (c.ended) return;
            c.ended = true;
            clearTimeout(c.timer);
            c.handlers.end?.(new Map(), reason);
        },
        press(customId, { userId = USER_ID, deferUpdate = () => Promise.resolve() } = {}) {
            const btn = { customId, user: { id: userId }, deferUpdate: jest.fn(deferUpdate), reply: jest.fn().mockResolvedValue() };
            if (c.ended) return btn;
            if (c.opts.filter && !c.opts.filter(btn)) return btn;
            c.collected += 1;
            c.handlers.collect?.(btn);
            if (c.opts.max && c.collected >= c.opts.max) c.finish('limit');
            return btn;
        },
    };
    c.arm(opts.time);
    return c;
}

function fakeInteraction(options = {}) {
    const collectors = [];
    const message = {
        createMessageComponentCollector: opts => {
            const col = fakeCollector(opts);
            collectors.push(col);
            return col;
        },
    };
    const renders = [];
    const interaction = {
        id: 'int-1',
        user: { id: USER_ID, username: 'hunter', displayAvatarURL: () => null },
        guild: { id: 'g1', channels: { cache: new Map() } },
        channelId: 'c1',
        channel: { send: jest.fn().mockResolvedValue() },
        member: {},
        client: {},
        options: {
            getBoolean: n => options[n] ?? null,
            getString:  n => options[n] ?? null,
        },
        renders,
        collectors,
        reply:       jest.fn(async p => { renders.push({ kind: 'reply', ...p }); }),
        deferReply:  jest.fn(async () => { renders.push({ kind: 'defer' }); }),
        editReply:   jest.fn(async p => { renders.push({ kind: 'edit', ...p }); }),
        fetchReply:  jest.fn(async () => message),
    };
    return interaction;
}

const lastCollector = i => i.collectors.at(-1);
const titles = i => i.renders.map(r => r.embeds?.map(e => e.data.title).join(' | ') ?? r.content ?? '');

function makeUser(hunt = {}) {
    const rifle = WEAPON_TIERS[0];
    const user = {
        userId: USER_ID, guildId: 'g1', balance: 1000, pets: [], quests: [],
        streak: { current: 0 },
        markModified() {},
        hunt: {
            level: 5, stamina: 10,
            weapons: [{ name: rifle.name, tier: rifle.tier, currentDurability: rifle.baseDurability, maxDurability: rifle.baseDurability, baseDurability: rifle.baseDurability, status: 'good', repairCount: 0 }],
            equippedWeaponIndex: 0,
            ...hunt,
        },
    };
    huntService.ensureHuntData(user);
    return user;
}

/** Feeds secureRandom from a list, then repeats its last value. */
function randomSequence(values) {
    let n = 0;
    __setRandomSourceForTests(() => values[Math.min(n++, values.length - 1)]);
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
    __setRandomSourceForTests(null);
    jest.useRealTimers();
    jest.restoreAllMocks();
});

// ── The approach ─────────────────────────────────────────────────────────────

describe('the approach', () => {
    const zone = ZONES.beginner_forest;
    const scene = e => e;
    const rabbit = { tier: 'common', animal: ANIMALS.rabbit };
    const lurker = ANIMALS_BY_TIER.uncommon.find(a => !(a.traits ?? []).length) ?? ANIMALS_BY_TIER.uncommon[0];
    // Math.random is stubbed to 0, so trait-less prey reads as "grazing".
    const profile = APPROACH_PROFILES.grazing;

    async function approach({ pick, lurk = null, random = [0.99], deferUpdate } = {}) {
        randomSequence(random);
        const user = makeUser();
        const interaction = fakeInteraction();
        const run = runApproach(interaction, { user, weapon: user.hunt.weapons[0], zone, encounter: rabbit, lurker: lurk, scene });
        await jest.advanceTimersByTimeAsync(0);
        if (pick) lastCollector(interaction).press(`stealth_${pick}`, { deferUpdate });
        else await jest.advanceTimersByTimeAsync(15_001);
        await jest.advanceTimersByTimeAsync(2_000);
        return { out: await run, interaction };
    }

    test('names the lurker in the hint, before anything is chosen', async () => {
        const { interaction } = await approach({ pick: profile.correctId, lurk: lurker });
        const prompt = interaction.renders[0].embeds[0].data.description;
        expect(prompt).toContain(`**${ANIMALS.rabbit.name}**`);
        expect(prompt).toContain(`**${lurker.name}**`);
        expect(prompt).toMatch(/Shot odds right now: \*\*\d+%\*\*/);
        expect(prompt).toMatch(/Decide <t:\d+:R>/);
    });

    test('a correct read is perfect and shows the odds moving', async () => {
        const { out, interaction } = await approach({ pick: profile.correctId });
        expect(out.stealth).toMatchObject({ outcome: 'perfect', bonus: 0.25 });
        expect(out.flushed).toBe(false);
        const result = interaction.renders.at(-1).embeds[0].data;
        expect(result.title).toBe('🤫 Perfect approach!');
        expect(result.description).toMatch(/Shot odds: \*\*\d+%\*\* → \*\*\d+%\*\*/);
    });

    test('a perfect read can flush out the lurker — the animal the hint named, not a stranger', async () => {
        const { out, interaction } = await approach({ pick: profile.correctId, lurk: lurker, random: [0] });
        expect(out.flushed).toBe(true);
        expect(out.encounter).toEqual({ tier: 'uncommon', animal: lurker });
        expect(interaction.renders.at(-1).embeds[0].data.description).toContain(`the **${lurker.name}** breaks cover`);
    });

    test('only a perfect read flushes anything', async () => {
        const decent = profile.options.find(o => o.stealthBonus === 0.05).id;
        const { out } = await approach({ pick: decent, lurk: lurker, random: [0] });
        expect(out.stealth.outcome).toBe('decent');
        expect(out.flushed).toBe(false);
        expect(out.encounter).toBe(rabbit);
    });

    test('silence is a timeout worth nothing', async () => {
        const { out, interaction } = await approach({});
        expect(out.stealth).toMatchObject({ outcome: 'timeout', bonus: 0 });
        expect(interaction.renders.at(-1).embeds[0].data.title).toBe('⏰ Hesitated too long…');
    });

    test('an acknowledgement that fails does not strand the hunt', async () => {
        const { out } = await approach({ pick: profile.correctId, deferUpdate: () => Promise.reject(new Error('Unknown interaction')) });
        expect(out.stealth.outcome).toBe('perfect');
    });
});

// ── The whole hunt ───────────────────────────────────────────────────────────

describe('executeStart', () => {
    function hunter(hunt) {
        const user = makeUser(hunt);
        User.findOneAndUpdate.mockResolvedValue(user);
        return user;
    }

    test('a quick hunt goes straight to the card, with its buttons, and says it was quick', async () => {
        // Low rolls: common prey (so no apex), and a hit.
        randomSequence([0.01]);
        hunter();
        const interaction = fakeInteraction({ quick: true });

        const run = executeStart(interaction);
        await jest.advanceTimersByTimeAsync(0);
        expect(await run).toEqual({ started: true });

        expect(interaction.deferReply).toHaveBeenCalled();
        const card = interaction.renders.at(-1);
        expect(card.components?.[0]?.components.map(b => b.data.label)).toContain('🏹 Hunt again');
        expect(card.embeds[0].data.description).toContain('⚡ Quick hunt');
        expect(attachResultActions).toHaveBeenCalledWith(interaction, 0);
    });

    test('the channel hears about quests only after the card has landed', async () => {
        randomSequence([0.01]);
        hunter();
        const interaction = fakeInteraction({ quick: true });

        await executeStart(interaction);

        const cardAt = interaction.editReply.mock.invocationCallOrder.at(-1);
        expect(questService.notifyQuestComplete.mock.invocationCallOrder[0]).toBeGreaterThan(cardAt);
    });

    test('an interactive hunt runs approach, shot and card, and the card records both', async () => {
        // Encounter roll, lurker roll, then high values so nothing flushes and the hunt lands.
        randomSequence([0.99]);
        hunter();
        const interaction = fakeInteraction();

        const run = executeStart(interaction);
        await jest.advanceTimersByTimeAsync(0);

        // Whatever the prey, press the correct read for its profile.
        const prompt = interaction.renders[0];
        const ids = prompt.components[0].components.map(b => b.data.custom_id.replace('stealth_', ''));
        const profile = Object.values(APPROACH_PROFILES).find(p => p.options.every(o => ids.includes(o.id)));
        lastCollector(interaction).press(`stealth_${profile.correctId}`);
        await jest.advanceTimersByTimeAsync(1_200);

        const armored = interaction.renders.at(-1).embeds[0].data.description.includes('Its hide turns');
        if (!armored) {
            await jest.advanceTimersByTimeAsync(1_000);               // the wait before the call
            const fire = lastCollector(interaction);
            await jest.advanceTimersByTimeAsync(200);
            fire.press(fire.opts.filter ? `hunt_fire_${interaction.id}` : '');
            await jest.advanceTimersByTimeAsync(600);
        }
        await jest.advanceTimersByTimeAsync(10_000);
        expect(await run).toEqual({ started: true });

        const card = interaction.renders.at(-1).embeds[0].data;
        expect(card.description).toContain('🤫 Perfect approach');
        if (!armored) expect(card.description).toContain('🎯 Perfect shot');
        // One header across every beat of the encounter.
        for (const r of interaction.renders.filter(r => r.embeds?.length)) {
            expect(r.embeds[0].data.author?.name).toBe(`${ZONES.beginner_forest.emoji} ${ZONES.beginner_forest.name}`);
        }
    });

    test('a save that fails hands the cooldown back and says so', async () => {
        randomSequence([0.99]);
        hunter();
        huntService.commitHunt.mockRejectedValueOnce(new Error('db down'));
        const release = jest.fn();
        huntService.claimHuntCooldown.mockResolvedValueOnce({ claimed: true, release });
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const interaction = fakeInteraction({ quick: true });

        await executeStart(interaction);

        expect(release).toHaveBeenCalled();
        expect(interaction.renders.at(-1).content).toMatch(/went wrong saving your hunt/);
    });

    test('a refused preflight is not a started hunt', async () => {
        hunter({ weapons: [], equippedWeaponIndex: -1 });
        const interaction = fakeInteraction({ quick: true });
        expect(await executeStart(interaction)).toBeUndefined();
        expect(interaction.reply.mock.calls[0][0].content).toMatch(/don't have a weapon equipped/);
    });
});

// ── The apex duel ────────────────────────────────────────────────────────────

describe('the apex duel', () => {
    // Every phase's correct read is 'match', so the tests can say what they mean.
    const APEX = {
        id: 'dire_alpha', name: 'Dire Alpha', emoji: '🐺',
        phases: [0, 1, 2].map(n => ({
            hint: `Phase ${n} — **the tell**.`,
            correct: 'match',
            choices: { match: { label: 'Match' }, hold: { label: 'Hold' }, safe: { label: 'Back off' } },
        })),
    };
    const zone = ZONES.legendary_peaks;
    const prey = ANIMALS.wolf;

    async function duel({ presses, level = 5 }) {
        huntService.rollApexType.mockReturnValue(APEX);
        const user = makeUser({ level });
        const fresh = makeUser({ level });
        fresh.hunt.activeZone = 'beginner_forest';           // not where the hunt was
        User.findOne.mockResolvedValue(fresh);
        const before = fresh.hunt.weapons[0].currentDurability;

        const interaction = fakeInteraction();
        const card = new EmbedBuilder().setTitle('card').setDescription('kill');
        const run = runApexDuel(interaction, {
            embed: card, catchFiles: [], zone, zoneId: 'legendary_peaks', weaponIndex: 0, currency: '🪙', guildSettings: {},
            result: { apexEncounter: { animal: prey, tier: 'rare', killPayout: 1000 }, gatheringYield: null },
            user,
        });
        await jest.advanceTimersByTimeAsync(0);

        const acks = [];
        for (const [phase, key] of presses) {
            if (key === 'wait') { await jest.advanceTimersByTimeAsync(APEX_PHASE_MS + 1); continue; }
            acks.push(lastCollector(interaction).press(`apex_${key}_${phase}`));
            await jest.advanceTimersByTimeAsync(0);
        }
        await jest.advanceTimersByTimeAsync(0);
        await run;
        return { interaction, acks, fresh, lost: before - fresh.hunt.weapons[0].currentDurability };
    }

    test('every press is acknowledged the moment it lands — the last one included', async () => {
        const { acks, interaction } = await duel({ presses: [[0, 'match'], [1, 'match'], [2, 'match']] });
        for (const btn of acks) expect(btn.deferUpdate).toHaveBeenCalled();
        const final = interaction.renders.at(-1);
        expect(final.kind).toBe('edit');
        expect(final.embeds[1].data.title).toContain('PERFECT');
        expect(final.components[0].components[0].data.label).toBe('🏹 Hunt again');
    });

    test('the kill draws out the apex its traits call for, and it is introduced as a challenger', async () => {
        const { interaction } = await duel({ presses: [[0, 'match'], [1, 'match'], [2, 'match']] });
        expect(huntService.rollApexType).toHaveBeenCalledWith(prey);
        expect(interaction.renders[0].embeds[1].data.description)
            .toContain(`a **Dire Alpha** steps out to claim your ${prey.emoji} **${prey.name}**`);
    });

    test('two misreads end the duel there, without asking for a third', async () => {
        const { interaction } = await duel({ presses: [[0, 'hold'], [1, 'hold']] });
        const phaseTitles = titles(interaction).filter(t => /Phase \d\/3/.test(t));
        expect(phaseTitles.some(t => t.includes('Phase 3/3'))).toBe(false);
        const final = interaction.renders.at(-1).embeds[1].data;
        expect(final.title).toContain('Escaped');
        expect(final.description).toContain('Your nerve broke after 2 of 3 phases.');
    });

    test('a misread is felt: the next phase says what it cost', async () => {
        const { interaction } = await duel({ presses: [[0, 'hold'], [1, 'match'], [2, 'match']] });
        const phase2 = interaction.renders.find(r => r.embeds?.[1]?.data.title.includes('Phase 2/3'));
        expect(phase2.embeds[1].data.description).toContain('Misread — it catches you. −2 ❤️');
    });

    test('walking away costs what losing costs', async () => {
        const walked = await duel({ presses: [[0, 'match'], [1, 'wait']] });
        const beaten = await duel({ presses: [[0, 'hold'], [1, 'hold']] });
        expect(walked.interaction.renders.at(-1).embeds[1].data.title).toContain('Escaped');
        expect(walked.lost).toBe(beaten.lost);
        expect(walked.lost).toBeGreaterThan(0);
    });

    test('the bonus is priced in the zone the hunt was in, not the active one', async () => {
        await duel({ presses: [[0, 'match'], [1, 'match'], [2, 'match']] });
        expect(huntService.applyPayoutModifiers).toHaveBeenCalledWith(expect.anything(), expect.any(Number), zone, expect.anything());
    });

    test('a press on an earlier phase\'s buttons does not answer the current one', async () => {
        const { interaction } = await duel({ presses: [[0, 'match'], [0, 'hold'], [1, 'match'], [2, 'match']] });
        expect(interaction.renders.at(-1).embeds[1].data.title).toContain('PERFECT');
    });

    test('seasoned hunters read the tell without the bold', async () => {
        const rookie  = await duel({ presses: [[0, 'match'], [1, 'match'], [2, 'match']], level: 5 });
        const veteran = await duel({ presses: [[0, 'match'], [1, 'match'], [2, 'match']], level: 30 });
        expect(rookie.interaction.renders[0].embeds[1].data.description).toContain('**the tell**');
        expect(veteran.interaction.renders[0].embeds[1].data.description).toContain('Phase 0 — the tell.');
    });
});
