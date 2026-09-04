'use strict';

/**
 * #647. 660-odd raw `console.*` calls, no levels, nothing an operator can
 * filter on, and 250 MB of retention per service holding unparsed text.
 *
 * The fix is a pino logger plus a bridge that routes the existing calls through
 * it, so what these assertions hold is the bridge: that a `[TAG] message` line
 * comes out as a level, a component and a message; that an Error keeps its
 * stack as a field rather than being flattened into text; that secrets are
 * redacted; and that installing the bridge is reversible, since the rest of the
 * suite asserts on the real console.
 */

const fs = require('fs');
const path = require('path');

const {
    createLogger,
    installConsoleBridge,
    withContext,
    addContext,
    toRecord,
    scrubSecrets,
    prettyLine,
    resolveLevel,
    resolveFormat,
} = require('../src/utils/logger');

/** A destination that collects the JSON records pino writes. */
function collector() {
    const lines = [];
    return {
        lines,
        records: () => lines.map(l => JSON.parse(l)),
        write(chunk) { lines.push(chunk); },
    };
}

function jsonLogger(level = 'trace') {
    const out = collector();
    return { out, log: createLogger({ level, format: 'json', out }) };
}

describe('the console bridge', () => {
    test('turns a [TAG] prefix into a component field', () => {
        const { out, log } = jsonLogger();
        const target = {};
        installConsoleBridge({ target, log });

        target.log('[READY] Logged in as %s', 'Clawdia#1');

        // The tag was greppable text and nothing else; it is now a field a log
        // backend can facet on, and the message reads without it.
        expect(out.records()[0]).toMatchObject({
            component: 'READY',
            msg: 'Logged in as Clawdia#1',
        });
    });

    test('maps console methods onto levels', () => {
        const { out, log } = jsonLogger();
        const target = {};
        installConsoleBridge({ target, log });

        target.log('[A] one');
        target.info('[A] two');
        target.warn('[A] three');
        target.error('[A] four');
        target.debug('[A] five');

        expect(out.records().map(r => r.level)).toEqual(['info', 'info', 'warn', 'error', 'debug']);
    });

    test('keeps an Error as a serialized field rather than flattening it', () => {
        const { out, log } = jsonLogger();
        const target = {};
        installConsoleBridge({ target, log });

        target.error('[DEPLOY] Discord rejected the payload:', new Error('boom'));

        const [record] = out.records();
        expect(record.component).toBe('DEPLOY');
        expect(record.err.message).toBe('boom');
        expect(record.err.stack).toContain('boom');
        // The message keeps the human half; the stack is queryable on its own.
        expect(record.msg).toContain('Discord rejected the payload');
    });

    test('falls back to the error message when there is nothing else to say', () => {
        const { msg } = toRecord([new Error('lonely')]);
        expect(msg).toBe('lonely');
    });

    test('applies console format specifiers exactly as console would', () => {
        expect(toRecord(['%s scored %d', 'fish', 12]).msg).toBe('fish scored 12');
        expect(toRecord(['[X] state', { a: 1 }]).msg).toBe("state { a: 1 }");
    });

    test('lifts the shard prefix out of the message', () => {
        // utils/sharding.js prefixes lines with `[shard 0/4] ` when there is
        // more than one process; as text it is unfilterable.
        const { fields, msg } = toRecord(['[shard 2/4] [DASHBOARD] Not the primary shard']);
        expect(fields).toMatchObject({ shard: 2, component: 'DASHBOARD' });
        expect(msg).toBe('Not the primary shard');
    });

    test('leaves a message that merely starts with a bracket alone', () => {
        const { fields, msg } = toRecord(['[this is not a tag, it is a sentence] etc']);
        expect(fields.component).toBeUndefined();
        expect(msg).toBe('[this is not a tag, it is a sentence] etc');
    });

    test('restores the real console, which the rest of the suite depends on', () => {
        const original = () => {};
        const target = { log: original, info: original, warn: original, error: original, debug: original };
        const restore = installConsoleBridge({ target, log: jsonLogger().log });

        expect(target.log).not.toBe(original);
        restore();
        expect(target.log).toBe(original);
    });

    test('is idempotent, so a double install cannot trap the real console', () => {
        const original = () => {};
        const target = { log: original, info: original, warn: original, error: original, debug: original };
        const first = installConsoleBridge({ target, log: jsonLogger().log });
        const second = installConsoleBridge({ target, log: jsonLogger().log });

        expect(second).toBe(first);
        first();
        expect(target.log).toBe(original);
    });
});

describe('correlation context', () => {
    test('attaches its fields to every line inside it, across an await', async () => {
        const { out, log } = jsonLogger();
        const target = {};
        installConsoleBridge({ target, log });

        await withContext({ requestId: 'req-1' }, async () => {
            target.log('[API] before');
            await Promise.resolve();
            target.log('[API] after');
        });
        target.log('[API] outside');

        const records = out.records();
        expect(records.map(r => r.requestId)).toEqual(['req-1', 'req-1', undefined]);
    });

    test('merges rather than replaces, so a nested scope keeps the request id', async () => {
        const { out, log } = jsonLogger();
        const target = {};
        installConsoleBridge({ target, log });

        await withContext({ requestId: 'req-1' }, async () => {
            await withContext({ guildId: '42' }, async () => target.log('[API] nested'));
        });

        expect(out.records()[0]).toMatchObject({ requestId: 'req-1', guildId: '42' });
    });

    test('addContext extends the scope in force and is a no-op outside one', async () => {
        const { out, log } = jsonLogger();
        const target = {};
        installConsoleBridge({ target, log });

        expect(addContext({ userId: 'u1' })).toBe(false);
        await withContext({ requestId: 'req-1' }, async () => {
            expect(addContext({ userId: 'u1' })).toBe(true);
            target.log('[API] hello');
        });

        expect(out.records()[0]).toMatchObject({ requestId: 'req-1', userId: 'u1' });
    });
});

describe('redaction through the console bridge', () => {
    // #854 review: pino's `redact` only sees structured fields, and the bridge
    // hands it a message string that `util.format` has already flattened — so
    // a credential passed as a console argument reached the log intact. The
    // argument is scrubbed before it is formatted.

    test.each([
        ['token', { token: 'gateway-token' }, 'gateway-token'],
        ['authorization', { headers: { authorization: 'Bearer abc' } }, 'Bearer abc'],
        ['apiKey', { config: { apiKey: 'sk-live-123' } }, 'sk-live-123'],
    ])('censors %s passed as a console argument', (_label, payload, secret) => {
        const { out, log } = jsonLogger();
        const target = {};
        installConsoleBridge({ target, log });

        target.error('[AI] request failed', payload);

        expect(out.lines[0]).not.toContain(secret);
        expect(out.lines[0]).toContain('[redacted]');
    });

    test('catches a credential nested below the top level', () => {
        // A failed request's `init.headers.Authorization` is three deep, which
        // is why this is a walk rather than a fixed path list.
        const scrubbed = scrubSecrets({ a: { b: { c: { sessionSecret: 'shh' } } } });
        expect(JSON.stringify(scrubbed)).not.toContain('shh');
    });

    test('matches the key by substring, not by exact name', () => {
        const scrubbed = scrubSecrets({ discordToken: 'x', 'X-Api-Key': 'y', refreshToken: 'z' });
        expect(Object.values(scrubbed)).toEqual(['[redacted]', '[redacted]', '[redacted]']);
    });

    test('leaves everything else exactly as it was', () => {
        const input = { url: 'https://x', retries: 2, nested: { ok: true } };
        expect(scrubSecrets(input)).toEqual(input);
    });

    test('copies rather than mutating — the caller is often about to retry it', () => {
        const config = { headers: { authorization: 'Bearer abc' } };
        scrubSecrets(config);
        expect(config.headers.authorization).toBe('Bearer abc');
    });

    test('survives a cycle', () => {
        const cyclic = { token: 'x' };
        cyclic.self = cyclic;
        expect(() => scrubSecrets(cyclic)).not.toThrow();
        expect(scrubSecrets(cyclic).token).toBe('[redacted]');
    });

    test('leaves an Error instance intact, so its stack still serializes', () => {
        const err = new Error('boom');
        expect(scrubSecrets(err)).toBe(err);
    });
});

describe('redaction', () => {
    test('censors credentials wherever they appear in the record', () => {
        const { out, log } = jsonLogger();

        log.error({
            token: 'gateway-token',
            headers: { authorization: 'Bearer abc' },
            config: { apiKey: 'sk-live-123' },
        }, 'request failed');

        const line = out.lines[0];
        expect(line).not.toContain('gateway-token');
        expect(line).not.toContain('Bearer abc');
        expect(line).not.toContain('sk-live-123');
        expect(line).toContain('[redacted]');
    });
});

describe('LOG_LEVEL and LOG_FORMAT', () => {
    test('a level below the threshold is not written at all', () => {
        const { out, log } = jsonLogger('warn');
        const target = {};
        installConsoleBridge({ target, log });

        target.log('[A] chatty');
        target.error('[A] serious');

        expect(out.records().map(r => r.msg)).toEqual(['serious']);
    });

    test('an unrecognised level warns and falls back to info', () => {
        const warnings = [];
        expect(resolveLevel('verbose', m => warnings.push(m))).toBe('info');
        expect(warnings[0]).toContain('LOG_LEVEL');
        // A typo must not silence the bot.
        expect(resolveLevel('verbose', () => {})).not.toBe('silent');
    });

    test('an empty or absent level is info', () => {
        expect(resolveLevel(undefined)).toBe('info');
        expect(resolveLevel('  ')).toBe('info');
        expect(resolveLevel('DEBUG')).toBe('debug');
    });

    test('production defaults to JSON and development to pretty', () => {
        const saved = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = 'production';
            expect(resolveFormat(undefined)).toBe('json');
            process.env.NODE_ENV = 'development';
            expect(resolveFormat(undefined)).toBe('pretty');
            // An explicit setting wins in either direction.
            expect(resolveFormat('json')).toBe('json');
            process.env.NODE_ENV = 'production';
            expect(resolveFormat('pretty')).toBe('pretty');
        } finally {
            process.env.NODE_ENV = saved;
        }
    });

    test('the JSON record carries level, ISO time, component and message', () => {
        const { out, log } = jsonLogger();
        const target = {};
        installConsoleBridge({ target, log });

        target.warn('[MIGRATIONS] slow');

        const [record] = out.records();
        expect(record.level).toBe('warn');
        expect(record.component).toBe('MIGRATIONS');
        expect(record.msg).toBe('slow');
        expect(record.time).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    });
});

describe('the pretty renderer', () => {
    const record = {
        level: 'warn', time: '2026-08-14T11:42:35.000Z', msg: 'slow',
        component: 'MIGRATIONS', pid: 1, hostname: 'box', durationMs: 900,
    };

    test('reads as a log line, with the extras appended as JSON', () => {
        const line = prettyLine(record);
        expect(line).toBe('11:42:35.000 WARN  [MIGRATIONS] slow {"durationMs":900}\n');
    });

    test('drops pid and hostname, which are noise in a terminal', () => {
        expect(prettyLine(record)).not.toContain('hostname');
    });

    test('prints the stack under the line', () => {
        const line = prettyLine({ ...record, err: { message: 'boom', stack: 'Error: boom\n    at x' } });
        expect(line).toContain('\nError: boom\n    at x');
    });

    test('passes a line through unparsed rather than dropping it', () => {
        // Anything that is not one of ours still has to reach the operator.
        const written = [];
        const log = createLogger({ level: 'info', format: 'pretty', out: { write: s => written.push(s) } });
        log.info('hello');
        expect(written.join('')).toContain('hello');
    });
});

describe('where the bridge is installed', () => {
    const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

    // A bot that logs through pino and a shard manager that does not would put
    // one unparsed stream in the middle of the JSON.
    test.each(['src/index.js', 'src/shard.js'])('%s installs it', file => {
        expect(read(file)).toContain("require('./utils/logger').installConsoleBridge()");
    });

    test('it goes in before anything else can log', () => {
        const source = read('src/index.js');
        // Every line written before this point escapes the bridge, so its
        // position in the file is the guarantee, not just its presence.
        expect(source.indexOf('installConsoleBridge'))
            .toBeLessThan(source.indexOf("require('./health')"));
    });

    test('the standalone deploy leaves the real console alone', () => {
        // `npm run deploy` is a terminal tool whose output is the point, and it
        // runs with no database and no log backend to ship JSON to.
        expect(read('src/deploy-commands.js')).not.toContain('installConsoleBridge');
    });

    test('the crash handlers report as well as log', () => {
        const source = read('src/index.js');
        for (const handler of ['unhandledRejection', 'uncaughtException']) {
            expect([handler, source.includes(handler)]).toEqual([handler, true]);
        }
        // Both paths exit through reportAndExit, which is synchronous when no
        // sink is configured and bounded when one is.
        expect(source).toContain("reportAndExit('uncaughtException'");
        expect(source).toContain("reportAndExit('unhandledRejection'");
    });
});
