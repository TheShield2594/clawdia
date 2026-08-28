'use strict';

/**
 * #647. `unhandledRejection` and `uncaughtException` wrote a line and exited,
 * into a rolling text stream nothing watches — so a bot that crash-looped at
 * 04:00 was found out days later, by a user.
 *
 * What these hold is that the sink is genuinely opt-in (unset, the exit stays
 * synchronous and nothing is sent), that it can never keep the process alive,
 * and that a failing sink cannot replace the error it was reporting.
 */

const { reportError, reportAndExit, isConfigured, describe: describeError, buildBody } =
    require('../src/utils/errorReporter');

const DISCORD_URL = 'https://discord.com/api/webhooks/123/abc';
const PLAIN_URL = 'https://errors.example.com/ingest';

let fetchMock;
const saved = {};

beforeEach(() => {
    for (const key of ['ERROR_WEBHOOK_URL', 'ERROR_REPORT_TIMEOUT_MS', 'NODE_ENV', 'SERVICE_NAME']) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
});

afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe('with no sink configured', () => {
    test('reports nothing', async () => {
        expect(isConfigured()).toBe(false);
        await expect(reportError('uncaughtException', new Error('boom'))).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('exits synchronously, exactly as the handler did before', () => {
        const exit = jest.fn();
        // Not awaited on purpose: the assertion is that the exit has already
        // happened by the time reportAndExit returns.
        reportAndExit('uncaughtException', new Error('boom'), { exit });
        expect(exit).toHaveBeenCalledWith(1);
    });
});

describe('with a sink configured', () => {
    beforeEach(() => { process.env.ERROR_WEBHOOK_URL = PLAIN_URL; });

    test('posts a flat JSON event describing the error', async () => {
        process.env.NODE_ENV = 'production';

        await reportError('unhandledRejection', new Error('boom'), { guildId: '42' });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(PLAIN_URL);
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body);
        expect(body).toMatchObject({
            kind: 'unhandledRejection',
            service: 'clawdia',
            environment: 'production',
            guildId: '42',
        });
        expect(body.error).toMatchObject({ name: 'Error', message: 'boom' });
        expect(body.error.stack).toContain('boom');
    });

    test('handles a rejection carrying something that is not an Error', async () => {
        // `Promise.reject('nope')` is legal and does reach this handler.
        await reportError('unhandledRejection', 'nope');
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).error)
            .toEqual({ name: 'string', message: 'nope', stack: null });
    });

    test('exits once the report resolves', async () => {
        const exit = jest.fn();
        await reportAndExit('uncaughtException', new Error('boom'), { exit });
        expect(fetchMock).toHaveBeenCalled();
        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(1);
    });

    test('still exits when the sink itself is down', async () => {
        // The likeliest thing to be broken at the same moment as the bot.
        fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
        const exit = jest.fn();

        await expect(reportAndExit('uncaughtException', new Error('boom'), { exit }))
            .resolves.toBe(false);
        expect(exit).toHaveBeenCalledWith(1);
    });

    test('reports a non-2xx as undelivered rather than throwing', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500 });
        await expect(reportError('uncaughtException', new Error('boom'))).resolves.toBe(false);
    });

    test('exits only once, however the report finishes', async () => {
        const exit = jest.fn();
        await reportAndExit('uncaughtException', new Error('boom'), { exit });
        // The timeout guard is still armed at this point; it must not fire a
        // second exit into a process that has already started shutting down.
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(exit).toHaveBeenCalledTimes(1);
    });

    test('bounds the wait rather than the delivery', async () => {
        process.env.ERROR_REPORT_TIMEOUT_MS = '50';
        await reportError('uncaughtException', new Error('boom'));
        expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    test('does not name the URL when delivery fails — it is a credential', async () => {
        fetchMock.mockRejectedValue(new Error(`connect ECONNREFUSED ${PLAIN_URL}`));
        const errors = [];
        const spy = jest.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));

        await reportError('uncaughtException', new Error('boom'));

        expect(errors.join('\n')).not.toContain(PLAIN_URL);
        spy.mockRestore();
    });
});

describe('a Discord webhook', () => {
    test('gets Discord’s payload shape, since that is the sink a bot operator has', () => {
        const event = {
            kind: 'uncaughtException', service: 'clawdia', shard: 2,
            error: { message: 'boom', stack: 'Error: boom\n    at x' },
        };
        const body = buildBody(DISCORD_URL, event);
        expect(body.content).toContain('uncaughtException');
        expect(body.content).toContain('shard 2');
        expect(body.content).toContain('Error: boom');
    });

    test('truncates, because Discord rejects a message over 2000 characters', () => {
        const event = {
            kind: 'uncaughtException', service: 'clawdia',
            error: { message: 'boom', stack: 'x'.repeat(50_000) },
        };
        // Rejected outright, not truncated by Discord — so an untruncated
        // report is no report at all.
        expect(buildBody(DISCORD_URL, event).content.length).toBeLessThan(2000);
    });

    test('anything else keeps the flat JSON event', () => {
        const event = { kind: 'uncaughtException', error: { message: 'boom' } };
        expect(buildBody(PLAIN_URL, event)).toBe(event);
    });
});

describe('describe()', () => {
    test('keeps name, message and stack for an Error', () => {
        expect(describeError(new TypeError('bad'))).toMatchObject({ name: 'TypeError', message: 'bad' });
    });

    test('says something useful about undefined', () => {
        expect(describeError(undefined)).toEqual({ name: 'undefined', message: 'undefined', stack: null });
    });
});
