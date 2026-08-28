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

const mockFindOneAndUpdate = jest.fn();
const mockUpdateOne = jest.fn().mockResolvedValue({});
jest.mock('../src/models/CommandDeployment', () => ({
    findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
    updateOne: (...args) => mockUpdateOne(...args),
}));

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

beforeEach(() => {
    mockPut.mockClear().mockResolvedValue(undefined);
    mockFindOneAndUpdate.mockReset().mockResolvedValue({});
    mockUpdateOne.mockClear().mockResolvedValue({});
    delete process.env.DEPLOY_COMMANDS;
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
        expect(filter).toEqual({ _id: DEPLOYMENT_KEY });
        expect(update.$set.hash).toBe(commandSetHash('client-id', COMMANDS.map(c => c.data.toJSON())));
        expect(update.$set.pending).toBe(false);
        expect(update.$set.commandCount).toBe(2);
    });

    test('makes no Discord call when the set is unchanged', async () => {
        mockFindOneAndUpdate.mockRejectedValue(duplicateKey());

        const result = await deployCommandsIfChanged('client-id', 'token', COMMANDS);

        expect(result).toEqual({ deployed: false, count: 2, reason: 'command set unchanged' });
        expect(mockPut).not.toHaveBeenCalled();
    });

    test('claims a hash that a previous boot left pending', async () => {
        // The crash case: a process killed mid-PUT leaves `pending: true` with
        // the new hash already written. Matching only on `hash: { $ne }` would
        // skip that deploy forever.
        await deployCommandsIfChanged('client-id', 'token', COMMANDS);

        const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
        expect(filter._id).toBe(DEPLOYMENT_KEY);
        expect(filter.$or).toContainEqual({ pending: true });
        expect(update.$set.pending).toBe(true);
    });

    test('releases the claim when Discord rejects the payload', async () => {
        mockPut.mockRejectedValue(new Error('rate limited'));

        await expect(deployCommandsIfChanged('client-id', 'token', COMMANDS))
            .rejects.toThrow('rate limited');

        // Without this the failed hash stays recorded and every later boot
        // skips a deploy that never actually happened.
        const [, update] = mockUpdateOne.mock.calls.at(-1);
        expect(update.$set).toEqual({ hash: null, pending: true });
    });

    test('propagates a database error rather than silently not deploying', async () => {
        mockFindOneAndUpdate.mockRejectedValue(new Error('connection lost'));

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
