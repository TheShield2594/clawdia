'use strict';

// #592. A join raid is the heaviest load pattern the bot has, and the welcome
// card was the heaviest thing on that path: a synchronous `canvas.toBuffer()`
// per member, uncapped, straight on the gateway's event loop.
//
// Three things changed, and this suite covers each of them: the encode is the
// async form now, concurrent renders are capped, and a guild past its
// cards-per-minute budget sends the plain embed instead of a card.

const { encodeCanvas } = require('../src/utils/canvasEncode');
const { deferred } = require('./helpers/deferred');
const {
    renderQueued,
    _resetCardRenderQueue,
    MAX_CONCURRENT,
    MAX_QUEUED,
    GUILD_LIMIT,
} = require('../src/utils/cardRenderQueue');

/** A promise plus the handles to settle it from the test body. */
beforeEach(() => _resetCardRenderQueue());

describe('encodeCanvas', () => {
    // The whole point of the change. A canvas whose toBuffer only answers the
    // callback form stands in for node-canvas: if the generator ever goes back
    // to `toBuffer()`, this returns undefined rather than a buffer.
    test('takes the callback form, which encodes off the main thread', async () => {
        const toBuffer = jest.fn(cb => cb(null, Buffer.from('png')));

        await expect(encodeCanvas({ toBuffer })).resolves.toEqual(Buffer.from('png'));
        expect(typeof toBuffer.mock.calls[0][0]).toBe('function');
    });

    test('passes the mime type through', async () => {
        const toBuffer = jest.fn((cb, mime) => cb(null, Buffer.from(mime)));

        await expect(encodeCanvas({ toBuffer }, 'image/jpeg')).resolves.toEqual(Buffer.from('image/jpeg'));
    });

    test('rejects rather than resolving undefined when the encode fails', async () => {
        const boom = new Error('encode failed');

        await expect(encodeCanvas({ toBuffer: cb => cb(boom) })).rejects.toThrow('encode failed');
    });
});

describe('renderQueued concurrency', () => {
    test(`runs at most ${MAX_CONCURRENT} renders at once`, async () => {
        const gates = [];
        let running = 0;
        let peak = 0;

        const calls = Array.from({ length: MAX_CONCURRENT + 2 }, (_, i) => {
            const gate = deferred();
            gates.push(gate);
            return renderQueued(`guild-${i}`, async () => {
                running++;
                peak = Math.max(peak, running);
                await gate.promise;
                running--;
                return Buffer.from('card');
            });
        });

        // Let every admitted render reach its gate before anything finishes.
        await new Promise(setImmediate);
        expect(running).toBe(MAX_CONCURRENT);

        gates.forEach(g => g.resolve());
        await Promise.all(calls);

        expect(peak).toBe(MAX_CONCURRENT);
    });

    test('a waiting render still gets its turn', async () => {
        const gate = deferred();
        const order = [];

        const first = Array.from({ length: MAX_CONCURRENT }, (_, i) =>
            renderQueued(`g${i}`, async () => { await gate.promise; order.push('first'); return Buffer.from('a'); }));
        const queued = renderQueued('later', async () => { order.push('queued'); return Buffer.from('b'); });

        await new Promise(setImmediate);
        expect(order).toEqual([]);

        gate.resolve();
        await Promise.all(first);

        await expect(queued).resolves.toEqual(Buffer.from('b'));
        expect(order[order.length - 1]).toBe('queued');
    });

    test(`refuses once ${MAX_QUEUED} renders are already waiting`, async () => {
        const gate = deferred();
        const held = Array.from({ length: MAX_CONCURRENT }, (_, i) =>
            renderQueued(`hold-${i}`, () => gate.promise.then(() => Buffer.from('a'))));

        const waiting = Array.from({ length: MAX_QUEUED }, (_, i) =>
            renderQueued(`wait-${i}`, async () => Buffer.from('b')));
        await new Promise(setImmediate);

        // The queue is full: this one is refused rather than joining it.
        await expect(renderQueued('overflow', async () => Buffer.from('c'))).resolves.toBeNull();

        gate.resolve();
        await Promise.all([...held, ...waiting]);
    });

    // A render that throws must not keep its slot, or MAX_CONCURRENT failures
    // wedge the queue permanently — the failure mode the try/finally exists for.
    test('gives the slot back when a render throws', async () => {
        for (let i = 0; i < MAX_CONCURRENT; i++) {
            await expect(renderQueued(`boom-${i}`, async () => { throw new Error('render failed'); }))
                .rejects.toThrow('render failed');
        }

        await expect(renderQueued('after', async () => Buffer.from('ok'))).resolves.toEqual(Buffer.from('ok'));
    });
});

describe('renderQueued per-guild budget', () => {
    test(`stops at ${GUILD_LIMIT} cards a minute for one guild`, async () => {
        const render = jest.fn(async () => Buffer.from('card'));

        for (let i = 0; i < GUILD_LIMIT; i++) {
            await expect(renderQueued('raided', render)).resolves.toEqual(Buffer.from('card'));
        }
        await expect(renderQueued('raided', render)).resolves.toBeNull();

        // Refused means not rendered — not rendered late.
        expect(render).toHaveBeenCalledTimes(GUILD_LIMIT);
    });

    test('the budget is per guild, so one raid does not mute everyone else', async () => {
        const render = async () => Buffer.from('card');
        for (let i = 0; i < GUILD_LIMIT + 5; i++) await renderQueued('raided', render);

        await expect(renderQueued('quiet-neighbour', render)).resolves.toEqual(Buffer.from('card'));
    });
});
