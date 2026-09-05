'use strict';

/**
 * The logic the entrypoints used to hide (#951).
 *
 * src/index.js, src/shard.js and src/deploy-commands.js are all on the
 * `neverExecuted` list in coverage-floors.json, and they are there legitimately:
 * requiring one starts a bot. What was not legitimate is how much *decision*
 * had accumulated inside them — the shard count a deployment spawns, the order
 * a shutdown closes things in, and whether `npm run deploy` runs at all.
 *
 * CI's image job boots the container, so a totally broken entrypoint was always
 * caught. None of these three are that: each is a branch or an ordering that
 * boots perfectly and does the wrong thing, which is exactly the class of bug a
 * smoke test cannot see. They now live in importable functions, and this is
 * what runs them.
 */

const { resolveTotalShards } = require('../src/utils/sharding');
const { runShutdown } = require('../src/utils/shutdown');
const { runDeployCli } = require('../src/utils/commandDeployer');

describe('#951 — shard-count selection', () => {
    test('a pinned positive integer is used as given', () => {
        expect(resolveTotalShards({ SHARD_COUNT: '4' })).toBe(4);
        expect(resolveTotalShards({ SHARD_COUNT: '1' })).toBe(1);
        // Read as a number, not passed through as the string it arrived as.
        expect(resolveTotalShards({ SHARD_COUNT: '12' })).toBe(12);
    });

    test('an unset SHARD_COUNT asks the gateway', () => {
        expect(resolveTotalShards({})).toBe('auto');
        expect(resolveTotalShards({ SHARD_COUNT: '' })).toBe('auto');
    });

    // The whole point of the branch. discord.js reads `totalShards` as a
    // number, so anything that survives to it unparsed spawns NaN shards —
    // which is not an error, it is a manager that spawns nothing and reports
    // success.
    test.each([
        ['a typo',        'auto-detect'],
        ['a word',        'auto'],
        ['zero',          '0'],
        ['a negative',    '-2'],
        ['a float',       '2.5'],
        ['whitespace',    '   '],
        ['a stray unit',  '4 shards'],
    ])('%s falls back to auto rather than reaching the manager', (_label, value) => {
        expect(resolveTotalShards({ SHARD_COUNT: value })).toBe('auto');
    });

    test('the fallback is the string discord.js understands, not null', () => {
        // `null` and `undefined` are both falsy and both wrong here: the
        // ShardingManager option is documented as a number or 'auto'.
        expect(resolveTotalShards({ SHARD_COUNT: 'nonsense' })).toBe('auto');
    });
});

describe('#951 — graceful shutdown ordering', () => {
    /** A shutdown whose every collaborator records the order it was called in. */
    function harness(overrides = {}) {
        const calls = [];
        const record = (name, result) => (...args) => {
            calls.push(name);
            if (typeof result === 'function') return result(...args);
            return result;
        };
        const deps = {
            calls,
            client: { destroy: record('client.destroy', Promise.resolve()) },
            connection: { close: record('connection.close', Promise.resolve()) },
            stopScheduler: record('stopScheduler'),
            stopCommandMetrics: record('stopCommandMetrics', Promise.resolve()),
            exit: record('exit'),
            log: () => {},
            logError: () => {},
            ...overrides,
        };
        return deps;
    }

    test('closes everything in the order the steps depend on', async () => {
        const deps = harness();
        await runShutdown('SIGTERM', deps);

        expect(deps.calls).toEqual([
            // No new cron job may start while the rest runs.
            'stopScheduler',
            // Gateway first, so the metrics drain is not racing new commands.
            'client.destroy',
            // Buffered counts written while Mongo is still open (#895).
            'stopCommandMetrics',
            'connection.close',
            'exit',
        ]);
    });

    test('drains the command metrics after the gateway and before the database', async () => {
        const deps = harness();
        await runShutdown('SIGINT', deps);

        const at = name => deps.calls.indexOf(name);
        // Stated as the two orderings that matter rather than as the whole
        // list, so the reason survives a step being added between them.
        expect(at('stopCommandMetrics')).toBeGreaterThan(at('client.destroy'));
        expect(at('stopCommandMetrics')).toBeLessThan(at('connection.close'));
    });

    test('exits 0', async () => {
        const exit = jest.fn();
        await runShutdown('SIGTERM', harness({ exit }));
        expect(exit).toHaveBeenCalledWith(0);
    });

    test('names the signal in the log', async () => {
        const log = jest.fn();
        await runShutdown('SIGTERM', harness({ log }));
        expect(log.mock.calls.flat().join(' ')).toMatch(/SIGTERM/);
    });

    // The four failure paths. The container is going away either way: the
    // signal has been sent, and a process that answers it by throwing is not
    // saved, it waits out Docker's grace period and is killed. So every one of
    // these still has to reach the exit.
    test('a throwing scheduler still closes the gateway and the database', async () => {
        const logError = jest.fn();
        const deps = harness({ logError });
        deps.stopScheduler = () => {
            deps.calls.push('stopScheduler');
            throw new Error('scheduler stuck');
        };

        await runShutdown('SIGTERM', deps);

        // This is the regression the extraction fixed: in the entrypoint
        // `stopScheduler` sat outside the try, so a throw from it propagated out
        // of the signal handler and the gateway, the buffered metrics and the
        // database connection were all left open.
        expect(deps.calls).toContain('client.destroy');
        expect(deps.calls).toContain('stopCommandMetrics');
        expect(deps.calls).toContain('connection.close');
        expect(deps.calls).toContain('exit');
        expect(logError).toHaveBeenCalled();
    });

    test('a caller that forgets stopScheduler is logged, not left running', async () => {
        // It has no default because `services` sits above `utils` in the layer
        // order, so utils/shutdown.js may not require the scheduler even
        // lazily — the entrypoint injects it. This is what happens if a future
        // caller does not.
        const exit = jest.fn();
        const logError = jest.fn();
        const deps = harness({ exit, logError });
        delete deps.stopScheduler;

        await runShutdown('SIGTERM', deps);

        expect(logError).toHaveBeenCalled();
        expect(deps.calls).toContain('client.destroy');
        expect(exit).toHaveBeenCalledWith(0);
    });

    // A failing step must not cancel the ones after it. The three shared a try
    // until review caught that a gateway rejecting `destroy()` took the metrics
    // drain and the connection close down with it — losing the buffered counts
    // to a failure that had nothing to do with them.
    test('a rejecting client.destroy still drains metrics and closes the database', async () => {
        const exit = jest.fn();
        const logError = jest.fn();
        const deps = harness({ exit, logError });
        deps.client = {
            destroy: () => {
                deps.calls.push('client.destroy');
                return Promise.reject(new Error('gateway hung'));
            },
        };

        await runShutdown('SIGTERM', deps);

        expect(deps.calls).toEqual([
            'stopScheduler', 'client.destroy', 'stopCommandMetrics', 'connection.close',
        ]);
        expect(logError).toHaveBeenCalled();
        expect(exit).toHaveBeenCalledWith(0);
    });

    test('a rejecting metrics drain still closes the database', async () => {
        const exit = jest.fn();
        const logError = jest.fn();
        const deps = harness({ exit, logError });
        deps.stopCommandMetrics = () => {
            deps.calls.push('stopCommandMetrics');
            return Promise.reject(new Error('mongo gone'));
        };

        await runShutdown('SIGTERM', deps);

        expect(deps.calls).toContain('connection.close');
        expect(deps.calls.indexOf('connection.close'))
            .toBeGreaterThan(deps.calls.indexOf('stopCommandMetrics'));
        expect(logError).toHaveBeenCalled();
        expect(exit).toHaveBeenCalledWith(0);
    });

    test('a rejecting connection.close still exits', async () => {
        const exit = jest.fn();
        const deps = harness({ exit });
        deps.connection = { close: () => Promise.reject(new Error('already closed')) };

        await runShutdown('SIGTERM', deps);

        expect(exit).toHaveBeenCalledWith(0);
    });

    test('every step is attempted even when all of them reject', async () => {
        const exit = jest.fn();
        const logError = jest.fn();
        const deps = harness({ exit, logError });
        const boom = name => () => {
            deps.calls.push(name);
            return Promise.reject(new Error(name));
        };
        deps.client = { destroy: boom('client.destroy') };
        deps.stopCommandMetrics = boom('stopCommandMetrics');
        deps.connection = { close: boom('connection.close') };

        await runShutdown('SIGTERM', deps);

        expect(deps.calls).toEqual([
            'stopScheduler', 'client.destroy', 'stopCommandMetrics', 'connection.close',
        ]);
        // One line per failure, so the log says which steps went wrong rather
        // than only that something did.
        expect(logError).toHaveBeenCalledTimes(3);
        expect(exit).toHaveBeenCalledWith(0);
    });

    test('does not claim a clean exit when a step failed', async () => {
        const log = jest.fn();
        const deps = harness({ log, logError: () => {} });
        deps.connection = { close: () => Promise.reject(new Error('already closed')) };

        await runShutdown('SIGTERM', deps);

        expect(log.mock.calls.flat().join(' ')).not.toMatch(/Clean exit/);
    });

    // The defaults themselves, which are part of the wiring: a default that
    // reaches for the wrong module is a shutdown that throws on the one path
    // nothing else runs.
    test('drains the real metrics buffer when none is injected', async () => {
        const buffer = require('../src/utils/commandMetricsBuffer');
        const spy = jest.spyOn(buffer, 'stopCommandMetrics').mockResolvedValue(0);
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        const logError = jest.spyOn(console, 'error').mockImplementation(() => {});
        const exit = jest.fn();

        try {
            await runShutdown('SIGTERM', {
                client: { destroy: () => Promise.resolve() },
                connection: { close: () => Promise.resolve() },
                stopScheduler: () => {},
                exit,
            });

            expect(spy).toHaveBeenCalled();
            // Defaulted through to the console rather than swallowed.
            expect(log).toHaveBeenCalled();
            expect(exit).toHaveBeenCalledWith(0);
        } finally {
            spy.mockRestore();
            log.mockRestore();
            logError.mockRestore();
        }
    });
});

describe('#951 — the deploy guard', () => {
    const silent = { log: () => {}, logError: () => {} };

    test('refuses without CLIENT_ID', async () => {
        const deploy = jest.fn();
        const code = await runDeployCli({ ...silent, env: { DISCORD_TOKEN: 't' }, deploy });

        expect(code).toBe(1);
        // The point of the guard: nothing reaches Discord.
        expect(deploy).not.toHaveBeenCalled();
    });

    test('refuses without DISCORD_TOKEN', async () => {
        const deploy = jest.fn();
        const code = await runDeployCli({ ...silent, env: { CLIENT_ID: '1' }, deploy });

        expect(code).toBe(1);
        expect(deploy).not.toHaveBeenCalled();
    });

    test('refuses on an empty string, not just a missing key', async () => {
        const deploy = jest.fn();
        const code = await runDeployCli({ ...silent, env: { CLIENT_ID: '', DISCORD_TOKEN: 't' }, deploy });

        expect(code).toBe(1);
        expect(deploy).not.toHaveBeenCalled();
    });

    test('says which variables are missing', async () => {
        const logError = jest.fn();
        await runDeployCli({ ...silent, logError, env: {}, deploy: jest.fn() });

        expect(logError.mock.calls.flat().join(' ')).toMatch(/CLIENT_ID.*DISCORD_TOKEN/);
    });

    test('deploys with both present, and reports the count', async () => {
        const deploy = jest.fn().mockResolvedValue(92);
        const log = jest.fn();
        const code = await runDeployCli({ ...silent, log, env: { CLIENT_ID: '1', DISCORD_TOKEN: 't' }, deploy });

        expect(code).toBe(0);
        expect(deploy).toHaveBeenCalledWith('1', 't');
        expect(log.mock.calls.flat().join(' ')).toMatch(/92/);
    });

    test('a rejected deploy is exit 1, not a thrown promise', async () => {
        // The entrypoint turns this into `process.exit(1)`. Left to throw it
        // would be an unhandled rejection, which Node reports on stderr and
        // then exits *non-deterministically* depending on the version's
        // --unhandled-rejections default.
        const deploy = jest.fn().mockRejectedValue(new Error('Discord said no'));
        const code = await runDeployCli({ ...silent, env: { CLIENT_ID: '1', DISCORD_TOKEN: 't' }, deploy });

        expect(code).toBe(1);
    });

    test('logs the whole error, so a rejection keeps its per-command detail', async () => {
        const error = new Error('Invalid Form Body');
        error.rawError = { errors: { 3: { name: { _errors: [{ code: 'X' }] } } } };
        const logError = jest.fn();
        await runDeployCli({ ...silent, logError, env: { CLIENT_ID: '1', DISCORD_TOKEN: 't' },
            deploy: jest.fn().mockRejectedValue(error) });

        // The error object itself, not `error.message` — `rawError` is the only
        // thing that says which command body was refused.
        expect(logError).toHaveBeenCalledWith(expect.any(String), error);
    });
});
