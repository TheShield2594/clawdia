'use strict';

// The replay-button session shared by /8ball, /coinflip and /roll. These
// collectors run after execute() has returned, outside the dispatcher's error
// handling, so the guarantees worth pinning down are: other members never see a
// raw interaction failure, overlapping clicks can't start two renders, a
// throwing handler is logged rather than left unhandled, and the buttons come
// off when the session ends.

const EventEmitter = require('events');
const { createReplaySession, IDLE_MS, MAX_MS } = require('../src/utils/replaySession');

class FakeCollector extends EventEmitter {
    constructor(options) {
        super();
        this.options    = options;
        this.ended      = false;
        this.resetTimer = jest.fn();
    }
}

function button(userId = 'owner', customId = 'replay') {
    return {
        customId,
        user:        { id: userId },
        reply:       jest.fn().mockResolvedValue(undefined),
        deferUpdate: jest.fn().mockResolvedValue(undefined),
    };
}

function setup({ onCollect = jest.fn().mockResolvedValue(undefined), claim } = {}) {
    let collector;
    const message = {
        createMessageComponentCollector: jest.fn(options => {
            collector = new FakeCollector(options);
            return collector;
        }),
    };
    const interaction = {
        user:       { id: 'owner', toString: () => '<@owner>' },
        editReply:  jest.fn().mockResolvedValue(undefined),
    };

    const session = createReplaySession({
        interaction,
        message,
        customIds: ['replay', 'other'],
        label:     'test',
        claim,
        onCollect,
    });

    return {
        session, interaction, onCollect,
        get collector() { return collector; },
        // Call the registered listener directly so each click is awaitable.
        collect: b => collector.listeners('collect')[0](b),
        end: () => { collector.ended = true; collector.emit('end'); },
    };
}

let errorSpy;
beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errorSpy.mockRestore(); });

describe('collector setup', () => {
    test('only listens to the buttons it was given', () => {
        const h = setup();
        const { filter } = h.collector.options;
        expect(filter(button('owner', 'replay'))).toBe(true);
        expect(filter(button('owner', 'other'))).toBe(true);
        expect(filter(button('owner', 'someone-elses-button'))).toBe(false);
    });

    test('caps the session below the 15 minute interaction token life', () => {
        const h = setup();
        expect(h.collector.options.idle).toBe(IDLE_MS);
        expect(h.collector.options.time).toBe(MAX_MS);
        expect(MAX_MS).toBeLessThan(15 * 60_000);
    });
});

describe('ownership', () => {
    test('other members get an ephemeral note, not a failed interaction', async () => {
        const h = setup();
        const stranger = button('someone-else');
        await h.collect(stranger);

        expect(stranger.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('<@owner>'),
        }));
        expect(h.onCollect).not.toHaveBeenCalled();
    });

    test('a caller-supplied claim message wins', async () => {
        const h = setup({ claim: 'hands off' });
        const stranger = button('someone-else');
        await h.collect(stranger);
        expect(stranger.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'hands off' }));
    });

    test('the invoker runs the handler', async () => {
        const h = setup();
        const b = button();
        await h.collect(b);
        expect(h.onCollect).toHaveBeenCalledTimes(1);
        expect(h.onCollect.mock.calls[0][0]).toBe(b);
    });
});

describe('overlap guard', () => {
    test('a click during a render is acknowledged, not run twice', async () => {
        let finish;
        const inFlight = new Promise(resolve => { finish = resolve; });
        const h = setup({ onCollect: jest.fn(() => inFlight) });

        const first  = h.collect(button());
        const second = button();
        await h.collect(second);

        expect(h.onCollect).toHaveBeenCalledTimes(1);
        expect(second.deferUpdate).toHaveBeenCalled();

        finish();
        await first;

        // The guard lifts once the render finishes.
        await h.collect(button());
        expect(h.onCollect).toHaveBeenCalledTimes(2);
    });

    test('a bystander\'s click cannot release a render in flight', async () => {
        let finish;
        const inFlight = new Promise(resolve => { finish = resolve; });
        const h = setup({ onCollect: jest.fn(() => inFlight) });

        const running = h.collect(button());        // owner starts a render
        await h.collect(button('someone-else'));    // bystander is turned away
        await h.collect(button());                  // owner clicks again

        // The bystander's rejection must not have handed the second owner click
        // a free claim on a session that is still rendering.
        expect(h.onCollect).toHaveBeenCalledTimes(1);

        finish();
        await running;
    });

    test('a rejected overlapping click cannot release the claim it lost to', async () => {
        let finish;
        const inFlight = new Promise(resolve => { finish = resolve; });
        const h = setup({ onCollect: jest.fn(() => inFlight) });

        const running = h.collect(button());
        await h.collect(button());  // rejected as overlapping
        await h.collect(button());  // must still be rejected

        expect(h.onCollect).toHaveBeenCalledTimes(1);
        finish();
        await running;
    });

    test('release() lets a click through mid-handler, hold() takes it back', async () => {
        const h = setup({ onCollect: jest.fn() });
        expect(h.session.hold()).toBe(true);
        expect(h.session.hold()).toBe(false);
        h.session.release();
        expect(h.session.hold()).toBe(true);
        h.session.release();
    });
});

describe('failure handling', () => {
    test('a throwing handler is logged instead of going unhandled', async () => {
        const boom = new Error('editReply exploded');
        const h = setup({ onCollect: jest.fn().mockRejectedValue(boom) });

        await expect(h.collect(button())).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('[test] component handler error:', boom);
    });

    test('the overlap guard is released even when the handler throws', async () => {
        const h = setup({ onCollect: jest.fn().mockRejectedValue(new Error('nope')) });
        await h.collect(button());
        expect(h.session.hold()).toBe(true);
    });

    test('a failed ephemeral reply does not escape either', async () => {
        const h = setup();
        const stranger = button('someone-else');
        stranger.reply.mockRejectedValue(new Error('unknown interaction'));
        await expect(h.collect(stranger)).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalled();
    });
});

describe('teardown', () => {
    test('ending the session strips the buttons', () => {
        const h = setup();
        h.end();
        expect(h.interaction.editReply).toHaveBeenCalledWith({ components: [] });
    });

    test('a render in flight is left to settle its own components', async () => {
        let finish;
        const inFlight = new Promise(resolve => { finish = resolve; });
        const h = setup({ onCollect: jest.fn(() => inFlight) });

        const pending = h.collect(button());
        h.end();
        expect(h.interaction.editReply).not.toHaveBeenCalled();

        // session.ended is what the render consults before re-attaching buttons.
        expect(h.session.ended).toBe(true);
        finish();
        await pending;
    });

    test('a failing teardown edit is swallowed', () => {
        const h = setup();
        h.interaction.editReply.mockRejectedValue(new Error('expired token'));
        expect(() => h.end()).not.toThrow();
    });
});

describe('extend', () => {
    test('restarts the idle timer without outliving the deadline', () => {
        const h = setup();
        h.session.extend();

        expect(h.collector.resetTimer).toHaveBeenCalledTimes(1);
        const [{ idle, time }] = h.collector.resetTimer.mock.calls[0];
        expect(idle).toBe(IDLE_MS);
        expect(time).toBeGreaterThan(0);
        expect(time).toBeLessThanOrEqual(MAX_MS);
    });

    test('is a no-op once the session has ended', () => {
        const h = setup();
        h.end();
        h.session.extend();
        expect(h.collector.resetTimer).not.toHaveBeenCalled();
    });
});
