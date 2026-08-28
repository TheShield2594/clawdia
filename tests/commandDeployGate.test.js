'use strict';

/**
 * #643. Slash-command registration is not a deploy step anyone runs: the image
 * is `CMD ["node", "src/index.js"]` and neither stack file overrides it, so the
 * only registration that ever happens is the one the bot does for itself at
 * `clientReady`. That has to stay true — and it has to stop re-publishing an
 * unchanged set of ~98 commands on every restart, once per shard.
 */

const mockPut = jest.fn().mockResolvedValue(undefined);
jest.mock('discord.js', () => ({
    REST: jest.fn().mockImplementation(() => ({
        setToken() { return this; },
        put: (...args) => mockPut(...args),
    })),
    Routes: { applicationCommands: id => `/applications/${id}/commands` },
}));

const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockUpdateOne = jest.fn().mockResolvedValue({});
jest.mock('../src/models/CommandDeployment', () => ({
    findOne: (...args) => ({ lean: () => mockFindOne(...args) }),
    findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
    updateOne: (...args) => mockUpdateOne(...args),
}));

/**
 * A single-document stand-in for the collection, with Mongo's matching rules
 * for the two things the claim depends on: `null` also matches a missing field,
 * and a filter that does not match updates nothing. Stubbing findOneAndUpdate
 * with a fixed answer would assert the mock, not the compare-and-swap.
 */
function fakeCollection(initial = null) {
    let doc = initial ? { ...initial } : null;
    const matches = filter => {
        if (!doc) return false;
        return Object.entries(filter).every(([key, want]) => {
            if (key === '_id') return true;
            const have = doc[key] ?? null;
            return (want ?? null) === have;
        });
    };
    mockFindOne.mockImplementation(async () => (doc ? { ...doc } : null));
    mockFindOneAndUpdate.mockImplementation(async (filter, update, options = {}) => {
        if (matches(filter)) {
            doc = { ...doc, ...update.$set };
            return { ...doc };
        }
        if (options.upsert && !doc) {
            doc = { _id: DEPLOYMENT_KEY, ...update.$set };
            return { ...doc };
        }
        if (options.upsert && doc) throw duplicateKey();
        return null;
    });
    mockUpdateOne.mockImplementation(async (filter, update, options = {}) => {
        if (matches(filter)) doc = { ...doc, ...update.$set };
        else if (options.upsert && !doc) doc = { _id: DEPLOYMENT_KEY, ...update.$set };
        return {};
    });
    return { current: () => doc };
}

const {
    deployCommandsIfChanged,
    commandSetHash,
    DEPLOYMENT_KEY,
} = require('../src/utils/commandDeployer');

const fakeCommand = name => ({
    data: { name, toJSON: () => ({ name, description: `${name} description` }) },
});

// What Mongo raises when an upsert whose filter did not match tries to insert a
// second document against the fixed _id — i.e. "the recorded hash is already
// this one".
const duplicateKey = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

const COMMANDS = [fakeCommand('fish'), fakeCommand('hunt')];
const HASH = commandSetHash('client-id', COMMANDS.map(c => c.data.toJSON()));

beforeEach(() => {
    mockPut.mockClear().mockResolvedValue(undefined);
    mockFindOne.mockReset();
    mockFindOneAndUpdate.mockReset();
    mockUpdateOne.mockReset().mockResolvedValue({});
    delete process.env.DEPLOY_COMMANDS;
    // Empty collection: a fresh install.
    fakeCollection(null);
});

afterAll(() => {
    delete process.env.DEPLOY_COMMANDS;
});

describe('the boot deploy', () => {
    test('publishes when the recorded hash does not match', async () => {
        const result = await deployCommandsIfChanged('client-id', 'token', COMMANDS);

        expect(result).toEqual({ deployed: true, count: 2, reason: 'command set changed' });
        expect(mockPut).toHaveBeenCalledWith('/applications/client-id/commands', {
            body: [
                { name: 'fish', description: 'fish description' },
                { name: 'hunt', description: 'hunt description' },
            ],
        });
    });

    test('records the hash it published, so the next boot can skip', async () => {
        await deployCommandsIfChanged('client-id', 'token', COMMANDS);

        const [filter, update] = mockUpdateOne.mock.calls.at(-1);
        expect(filter._id).toBe(DEPLOYMENT_KEY);
        // Scoped to this deploy's own claim, so a slow shard cannot mark
        // someone else's in-flight claim finished.
        expect(filter.claimToken).toEqual(expect.any(String));
        expect(update.$set.hash).toBe(HASH);
        expect(update.$set.pending).toBe(false);
        expect(update.$set.commandCount).toBe(2);
    });

    test('makes no Discord call when the set is unchanged', async () => {
        fakeCollection({ _id: DEPLOYMENT_KEY, hash: HASH, pending: false, claimToken: 'tok-1' });

        const result = await deployCommandsIfChanged('client-id', 'token', COMMANDS);

        expect(result).toEqual({ deployed: false, count: 2, reason: 'command set unchanged' });
        expect(mockPut).not.toHaveBeenCalled();
        // Not even a write: the common restart is one indexed read.
        expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });

    test('publishes when the recorded hash is an older set', async () => {
        fakeCollection({ _id: DEPLOYMENT_KEY, hash: 'an-older-hash', pending: false, claimToken: 'tok-1' });

        const result = await deployCommandsIfChanged('client-id', 'token', COMMANDS);

        expect(result.deployed).toBe(true);
        expect(mockPut).toHaveBeenCalledTimes(1);
    });

    test('claims a hash that a previous boot left pending', async () => {
        // The crash case: a process killed mid-PUT leaves `pending: true` with
        // the new hash already written. Treating that as "already published"
        // would skip the deploy forever.
        fakeCollection({ _id: DEPLOYMENT_KEY, hash: HASH, pending: true, claimToken: 'tok-1' });

        const result = await deployCommandsIfChanged('client-id', 'token', COMMANDS);

        expect(result.deployed).toBe(true);
        expect(mockPut).toHaveBeenCalledTimes(1);
    });

    test('releases the claim when Discord rejects the payload', async () => {
        const store = fakeCollection(null);
        mockPut.mockRejectedValue(new Error('rate limited'));

        await expect(deployCommandsIfChanged('client-id', 'token', COMMANDS))
            .rejects.toThrow('rate limited');

        // Without this the failed hash stays recorded and every later boot
        // skips a deploy that never actually happened.
        expect(store.current()).toMatchObject({ hash: null, pending: true });
    });

    test('only the claim holder may release it', async () => {
        // A shard whose PUT failed must not clear a claim that a later boot has
        // since taken, or both would publish.
        const store = fakeCollection(null);
        mockPut.mockRejectedValue(new Error('rate limited'));
        const deploy = deployCommandsIfChanged('client-id', 'token', COMMANDS);
        await expect(deploy).rejects.toThrow('rate limited');

        const released = store.current();
        expect(mockUpdateOne.mock.calls.at(-1)[0].claimToken).toBe(released.claimToken);
    });

    test('propagates a database error rather than silently not deploying', async () => {
        mockFindOne.mockRejectedValue(new Error('connection lost'));

        await expect(deployCommandsIfChanged('client-id', 'token', COMMANDS))
            .rejects.toThrow('connection lost');
        expect(mockPut).not.toHaveBeenCalled();
    });
});

describe('DEPLOY_COMMANDS', () => {
    test('never: no Discord call and no database read', async () => {
        process.env.DEPLOY_COMMANDS = 'never';

        const result = await deployCommandsIfChanged('client-id', 'token', COMMANDS);

        expect(result.deployed).toBe(false);
        expect(mockPut).not.toHaveBeenCalled();
        expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });

    test('always: publishes without consulting the recorded hash', async () => {
        process.env.DEPLOY_COMMANDS = 'always';

        const result = await deployCommandsIfChanged('client-id', 'token', COMMANDS);

        expect(result.deployed).toBe(true);
        expect(mockPut).toHaveBeenCalled();
        expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
        // Still recorded, so switching back to `auto` does not cost one more
        // deploy of a set that is already registered.
        expect(mockUpdateOne.mock.calls.at(-1)[1].$set.pending).toBe(false);
    });

    test('an unrecognised value falls back to auto rather than disabling the deploy', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        process.env.DEPLOY_COMMANDS = 'yes please';

        const result = await deployCommandsIfChanged('client-id', 'token', COMMANDS);

        expect(result.deployed).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('DEPLOY_COMMANDS'));
        warn.mockRestore();
    });
});

describe('commandSetHash', () => {
    const payload = COMMANDS.map(c => c.data.toJSON());

    test('does not depend on the order the commands are iterated in', () => {
        expect(commandSetHash('client-id', [...payload].reverse()))
            .toBe(commandSetHash('client-id', payload));
    });

    test('changes when a command does', () => {
        const edited = [{ ...payload[0], description: 'now with bait' }, payload[1]];
        expect(commandSetHash('client-id', edited)).not.toBe(commandSetHash('client-id', payload));
    });

    test('changes when the application does', () => {
        // Same payload under a different CLIENT_ID is a registration that has
        // never been made.
        expect(commandSetHash('other-id', payload)).not.toBe(commandSetHash('client-id', payload));
    });
});

describe('the CommandDeployment record', () => {
    // The real model, not the mock the tests above install: what is asserted
    // here is the shape the gate depends on.
    const CommandDeployment = jest.requireActual('../src/models/CommandDeployment');
    const paths = CommandDeployment.schema.paths;

    test('is keyed by a name the gate supplies, so the claim can be an upsert', () => {
        // An auto-generated ObjectId would make every boot insert a new
        // document and never match the previous one.
        expect(paths._id.instance).toBe('String');
        expect(new CommandDeployment({})._id).toBeUndefined();
    });

    test('carries the hash, the crash marker and what was published', () => {
        expect(Object.keys(paths)).toEqual(
            expect.arrayContaining(['hash', 'pending', 'clientId', 'commandCount', 'deployedAt'])
        );
    });

    test('starts unpending with no hash, so a fresh install deploys', () => {
        const fresh = new CommandDeployment({ _id: DEPLOYMENT_KEY });
        expect(fresh.hash).toBeNull();
        expect(fresh.pending).toBe(false);
    });
});

describe('a deploy that published but could not record itself', () => {
    test('is still reported as deployed', async () => {
        // Discord already has the new set. Calling that a failure would put a
        // scary line in the log for a state that self-corrects on the next boot.
        mockUpdateOne.mockRejectedValue(new Error('connection lost'));
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

        const result = await deployCommandsIfChanged('client-id', 'token', COMMANDS);

        expect(result.deployed).toBe(true);
        expect(errors).toHaveBeenCalledWith(expect.stringContaining('could not record'), expect.anything());
        errors.mockRestore();
    });
});

describe('concurrent startups', () => {
    // #854 review: the original claim matched on `hash: { $ne }`, which every
    // shard's filter satisfies when the stored document holds an older hash —
    // so N shards all claimed and all published the same set. These hold the
    // compare-and-swap that replaced it.

    /**
     * Holds every PUT open until released, so the callers genuinely overlap —
     * a winner parked mid-publish is exactly the window in which a second
     * claimant must not also reach Discord. A PUT that arrives after the
     * release resolves at once, so the test never depends on how many ticks the
     * claim takes.
     */
    function pendingPuts() {
        let released = false;
        const resolvers = [];
        mockPut.mockImplementation(() => (released
            ? Promise.resolve()
            : new Promise(resolve => resolvers.push(resolve))));
        return {
            release() {
                released = true;
                for (const resolve of resolvers) resolve();
            },
        };
    }

    /** Lets every caller run to its first real suspension point. */
    const settle = () => new Promise(resolve => setImmediate(resolve));

    test('only one of four shards publishes, from an empty collection', async () => {
        fakeCollection(null);
        const puts = pendingPuts();

        const results = Promise.all(
            [0, 1, 2, 3].map(() => deployCommandsIfChanged('client-id', 'token', COMMANDS))
        );
        await settle();
        puts.release();

        const settled = await results;
        expect(mockPut).toHaveBeenCalledTimes(1);
        expect(settled.filter(r => r.deployed)).toHaveLength(1);
    });

    test('only one of four shards publishes when an older set is recorded', async () => {
        // The case the duplicate-key guard never covered: the document exists,
        // so nothing inserts and every filter used to match.
        fakeCollection({ _id: DEPLOYMENT_KEY, hash: 'an-older-hash', pending: false, claimToken: 'tok-1' });
        const puts = pendingPuts();

        const results = Promise.all(
            [0, 1, 2, 3].map(() => deployCommandsIfChanged('client-id', 'token', COMMANDS))
        );
        await settle();
        puts.release();

        const settled = await results;
        expect(mockPut).toHaveBeenCalledTimes(1);
        expect(settled.filter(r => r.deployed)).toHaveLength(1);
        for (const loser of settled.filter(r => !r.deployed)) {
            expect(loser.reason).toBe('another process is publishing this set');
        }
    });

    test('only one of four shards takes over a claim left pending by a crash', async () => {
        fakeCollection({ _id: DEPLOYMENT_KEY, hash: HASH, pending: true, claimToken: 'tok-1' });
        const puts = pendingPuts();

        const results = Promise.all(
            [0, 1, 2, 3].map(() => deployCommandsIfChanged('client-id', 'token', COMMANDS))
        );
        await settle();
        puts.release();

        await results;
        expect(mockPut).toHaveBeenCalledTimes(1);
    });

    test('the winner leaves the record settled on the hash it published', async () => {
        const store = fakeCollection({ _id: DEPLOYMENT_KEY, hash: 'older', pending: false, claimToken: 'tok-1' });

        await Promise.all([0, 1].map(() => deployCommandsIfChanged('client-id', 'token', COMMANDS)));

        expect(store.current()).toMatchObject({ hash: HASH, pending: false, commandCount: 2 });
    });
});
