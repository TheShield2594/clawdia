'use strict';

// Hunger warning DMs (#1181): one when a pet's passive switches off, one when
// it runs out of food — each once per crossing, so a pet left alone produces
// at most two before it runs away.

jest.mock('../src/models/User', () => ({ find: jest.fn(), updateOne: jest.fn() }));

const User = require('../src/models/User');
const { hungerWarningFor, sendPetHungerWarnings, warningMessage } = require('../src/services/petWarningService');
const { STARVING_THRESHOLD, HUNGER_DECAY_PER_DAY, MS_PER_DAY, applyHungerDecay } = require('../src/services/petService');

const DAY = MS_PER_DAY;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function pet(overrides = {}) {
    return {
        _id: 'p1', petId: 'wolf', name: 'Rex', hunger: 100,
        lastDecayAt: new Date(NOW), lastFed: new Date(NOW), adoptedAt: new Date(NOW),
        hungerWarnedLow: false, hungerWarnedEmpty: false,
        ...overrides,
    };
}

describe('crossing detection', () => {
    test('nothing is due while the pet is fed', () => {
        expect(hungerWarningFor(pet({ hunger: 50 }), NOW)).toEqual({ due: null, clear: [] });
    });

    test('below the threshold the low warning is due, once', () => {
        expect(hungerWarningFor(pet({ hunger: STARVING_THRESHOLD - 1 }), NOW).due).toBe('low');
        expect(hungerWarningFor(pet({ hunger: STARVING_THRESHOLD - 1, hungerWarnedLow: true }), NOW).due).toBeNull();
    });

    test('at zero the empty warning is due, once', () => {
        expect(hungerWarningFor(pet({ hunger: 0 }), NOW).due).toBe('empty');
        expect(hungerWarningFor(pet({ hunger: 0, hungerWarnedLow: true, hungerWarnedEmpty: true }), NOW).due).toBeNull();
    });

    test('reads decay-aware hunger, not the stored value', () => {
        // Stored at 100 but last brought up to date eight days ago: 20% now.
        const stale = pet({ lastDecayAt: new Date(NOW - 8 * DAY) });
        expect(hungerWarningFor(stale, NOW).due).toBe('low');
    });

    test('a pet back above a line has that flag cleared', () => {
        const fed = pet({ hunger: 80, hungerWarnedLow: true, hungerWarnedEmpty: true });
        expect(hungerWarningFor(fed, NOW).clear).toEqual(['hungerWarnedLow', 'hungerWarnedEmpty']);
        const halfway = pet({ hunger: 10, hungerWarnedLow: true, hungerWarnedEmpty: true });
        expect(hungerWarningFor(halfway, NOW)).toEqual({ due: null, clear: ['hungerWarnedEmpty'] });
    });

    test('a pet on vacation is never warned', () => {
        const away = pet({ hunger: 0, vacationFrom: new Date(NOW - DAY), vacationUntil: new Date(NOW + DAY) });
        expect(hungerWarningFor(away, NOW).due).toBeNull();
    });

    test('a pet left alone gets exactly two warnings before it runs away', () => {
        let p = pet();
        const due = [];
        // Hourly checks from full to the runaway point, with the flags the job sets.
        for (let t = NOW; t <= NOW + (100 / HUNGER_DECAY_PER_DAY + 3) * DAY; t += 3_600_000) {
            const { due: d } = hungerWarningFor(p, t);
            if (d === 'low') p = { ...p, hungerWarnedLow: true };
            if (d === 'empty') p = { ...p, hungerWarnedLow: true, hungerWarnedEmpty: true };
            if (d) due.push(d);
            // A /pet command in between writes decay back; it must not re-arm anything.
            if (t % (DAY * 2) === 0) p = { ...applyHungerDecay([p], t)[0] };
        }
        expect(due).toEqual(['low', 'empty']);
    });
});

describe('sendPetHungerWarnings', () => {
    let docs;
    let flags;
    let dms;

    function client() {
        dms = [];
        return {
            guilds: { cache: new Map([['g1', { name: 'Paw Club' }]]) },
            users: { fetch: jest.fn(async id => ({ send: jest.fn(async msg => { dms.push({ id, msg }); }) })) },
        };
    }

    beforeEach(() => {
        jest.clearAllMocks();
        flags = new Set();
        User.find.mockImplementation(() => ({
            lean: () => ({ cursor: () => (async function* gen() { yield* docs; })() }),
        }));
        // The claim is conditional on the flag not being set yet.
        User.updateOne.mockImplementation(async (filter, update) => {
            const set = update.$set ?? {};
            const key = Object.keys(set)[0];
            const flag = key.split('.').pop();
            const id = `${filter.userId}:${update && filter.pets?.$elemMatch?._id}:${flag}`;
            if (set[key] === true) {
                if (flags.has(id)) return { modifiedCount: 0 };
                flags.add(id);
            }
            return { modifiedCount: 1 };
        });
    });

    test('one DM per player, naming every pet that crossed, and never twice', async () => {
        docs = [{ userId: 'u1', guildId: 'g1', pets: [pet({ hunger: 20 }), pet({ _id: 'p2', name: 'Bo', hunger: 0 })] }];
        const c = client();

        expect(await sendPetHungerWarnings(c, NOW)).toEqual({ warned: 2, dms: 1 });
        expect(dms).toHaveLength(1);
        expect(dms[0].msg.content).toContain('Paw Club');
        expect(dms[0].msg.content).toContain('**Rex**');
        expect(dms[0].msg.content).toMatch(/\*\*Bo\*\* has run out of food/);

        // Same pets on the next run (the flags are now set in the store).
        expect(await sendPetHungerWarnings(c, NOW)).toEqual({ warned: 0, dms: 0 });
    });

    test('an empty pet takes both flags, so it is not warned about the passive afterwards', async () => {
        docs = [{ userId: 'u1', guildId: 'g1', pets: [pet({ hunger: 0 })] }];
        await sendPetHungerWarnings(client(), NOW);
        const setFlags = User.updateOne.mock.calls.map(([, u]) => Object.keys(u.$set)[0]);
        expect(setFlags).toEqual(['pets.$[p].hungerWarnedEmpty', 'pets.$[p].hungerWarnedLow']);
    });

    test('players who opted out are not queried', async () => {
        docs = [];
        await sendPetHungerWarnings(client(), NOW);
        expect(User.find.mock.calls[0][0]).toMatchObject({ 'notifications.pets.hunger': { $ne: false } });
    });

    test("each shard reads only its own guilds' pet owners", async () => {
        docs = [];
        await sendPetHungerWarnings(client(), NOW);
        expect(User.find.mock.calls[0][0]).toMatchObject({ guildId: { $in: ['g1'] } });
    });

    test('with no guild cache it falls back to the unscoped query', async () => {
        docs = [];
        await sendPetHungerWarnings({ users: { fetch: jest.fn() } }, NOW);
        expect(User.find.mock.calls[0][0]).not.toHaveProperty('guildId');
    });

    test('the DM says how to feed, pause and opt out', () => {
        const msg = warningMessage('Paw Club', ['line']);
        expect(msg).toContain('/pet feed');
        expect(msg).toContain('/pet vacation');
        expect(msg).toContain('/notifications pets');
    });
});
