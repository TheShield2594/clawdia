'use strict';

// #607: startup requires all 98 command files, and the deploy at ready used to
// walk `src/commands` and require every one of them a second time. The duplicate
// walk cost ~800 ms of startup and, worse, meant the registered set was built
// from a different read of disk than the set the process actually runs. These
// tests hold both halves: the deploy uses the collection it is handed, and the
// standalone `npm run deploy` — which has no client — still loads for itself.

const mockPut = jest.fn().mockResolvedValue(undefined);
jest.mock('discord.js', () => ({
    REST: jest.fn().mockImplementation(() => ({
        setToken() { return this; },
        put: (...args) => mockPut(...args),
    })),
    Routes: { applicationCommands: id => `/applications/${id}/commands` },
}));

const commandLoader = require('../src/utils/commandLoader');
const { deployCommands } = require('../src/utils/commandDeployer');

const fakeCommand = name => ({
    data: { name, toJSON: () => ({ name, description: `${name} description` }) },
    execute: async () => {},
});

beforeEach(() => {
    mockPut.mockClear();
    jest.restoreAllMocks();
});

describe('deployCommands source of truth', () => {
    test('publishes the commands it is handed without re-walking src/commands', async () => {
        const walk = jest.spyOn(commandLoader, 'loadCommandModules');

        const count = await deployCommands('client-id', 'token', [
            fakeCommand('fish'),
            fakeCommand('hunt'),
        ]);

        expect(count).toBe(2);
        expect(walk).not.toHaveBeenCalled();
        expect(mockPut).toHaveBeenCalledWith('/applications/client-id/commands', {
            body: [
                { name: 'fish', description: 'fish description' },
                { name: 'hunt', description: 'hunt description' },
            ],
        });
    });

    // A discord.js Collection is what startup actually passes (via .values()),
    // so anything iterable has to work — not just an array.
    test('accepts any iterable of commands, not just an array', async () => {
        const collection = new Map([['fish', fakeCommand('fish')]]);

        const count = await deployCommands('client-id', 'token', collection.values());

        expect(count).toBe(1);
        expect(mockPut.mock.calls[0][1].body).toEqual([{ name: 'fish', description: 'fish description' }]);
    });

    // The abort is the point: Discord rejects the whole PUT rather than taking
    // the valid subset, so publishing a partial set unregisters every command
    // that did not make it in.
    test('refuses to publish when a handed command cannot be serialized', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(
            deployCommands('client-id', 'token', [fakeCommand('fish'), { data: { name: 'broken' } }])
        ).rejects.toThrow(/failed to load/);
        expect(mockPut).not.toHaveBeenCalled();
    });

    // `npm run deploy` runs without a gateway connection, so there is no
    // client.commands to reuse and the walk still has to happen.
    test('falls back to loading from disk when no collection is supplied', async () => {
        await jest.isolateModulesAsync(async () => {
            jest.doMock('../src/utils/commandLoader', () => ({
                loadCommandModules: () => ({
                    commands: [{ entry: { rel: 'economy/fish/index.js' }, command: fakeCommand('fish') }],
                    failures: [],
                }),
                listCommandFiles: () => [{ rel: 'economy/fish/index.js' }],
            }));
            const { deployCommands: freshDeploy } = require('../src/utils/commandDeployer');

            const count = await freshDeploy('client-id', 'token');

            expect(count).toBe(1);
            expect(mockPut.mock.calls[0][1].body).toEqual([{ name: 'fish', description: 'fish description' }]);
        });
    });
});
