'use strict';

// Crafting spends mining materials, and a grind profile is persisted by replacing
// its whole `data` document. So the economy lock has to cover the *read* as
// well as the write: holding it only around user.save() left the window that
// matters open — a /mine raid landing between attachGrind and the save was simply
// overwritten by the snapshot the craft had already loaded, and the raider kept
// their credit while the defender kept their materials.

jest.mock('../src/utils/activeGameLock', () => ({
    tryAcquire:     jest.fn(),
    holderActivity: jest.fn().mockResolvedValue('mine'),
    release:        jest.fn().mockResolvedValue(true),
    DEFAULT_TTL_MS: 120_000,
}));

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOneAndUpdate: jest.fn() }));

const lock  = require('../src/utils/activeGameLock');
const Guild = require('../src/models/Guild');
const craft = require('../src/commands/economy/craft');

/** Records the order of lock and data operations so their nesting can be asserted. */
let trace;

function interaction(sub) {
    return {
        guild: { id: 'g1' },
        user:  { id: 'u1' },
        options: { getSubcommand: () => sub, getString: () => null, getInteger: () => 1 },
        reply: jest.fn(async () => { trace.push('reply'); }),
    };
}

beforeEach(() => {
    trace = [];
    lock.tryAcquire.mockReset().mockImplementation(async () => { trace.push('acquire'); return 'tok'; });
    lock.release.mockReset().mockImplementation(async () => { trace.push('release'); return true; });
    // Economy disabled makes the inner handler return before any profile is read,
    // which is enough to observe the wrapper without standing up a database.
    Guild.findOne.mockReset().mockResolvedValue({ economy: { enabled: false } });
});

describe('/craft make runs under the economy lock', () => {
    test('takes the lock before the handler runs and releases it after', async () => {
        await craft.execute(interaction('make'));
        expect(trace).toEqual(['acquire', 'reply', 'release']);
    });

    test('uses the shared per-user key, so every economy command serialises against it', async () => {
        await craft.execute(interaction('make'));
        expect(lock.tryAcquire).toHaveBeenCalledWith('economy:g1:u1', expect.any(Number), 'craft');
    });

    test('a busy player is turned away without touching their data, and told what is holding them up', async () => {
        lock.tryAcquire.mockImplementation(async () => { trace.push('acquire'); return null; });
        // The lease is held by a /mine dig, so the message names mining rather
        // than the command the player just ran.
        lock.holderActivity.mockResolvedValue('mine');
        const i = interaction('make');

        await craft.execute(i);

        expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('mining action in progress'),
        }));
        expect(Guild.findOne).not.toHaveBeenCalled();   // never read anything
        expect(lock.release).not.toHaveBeenCalled();    // nothing to release
    });

    test('the lock is released even when the handler throws', async () => {
        Guild.findOne.mockRejectedValue(new Error('db down'));
        await expect(craft.execute(interaction('make'))).rejects.toThrow('db down');
        expect(trace).toEqual(['acquire', 'release']);
    });
});

describe('/craft list is read-only and never blocks a raid', () => {
    test('browsing recipes takes no lock at all', async () => {
        await craft.execute(interaction('list'));
        expect(lock.tryAcquire).not.toHaveBeenCalled();
        expect(lock.release).not.toHaveBeenCalled();
    });
});
