'use strict';

/**
 * The aim phase, driven by the clock.
 *
 * `gradeShot` is pure and unit-tested elsewhere. What it cannot see is the part
 * that decides *what numbers it is handed*: a wait, an edit that goes out over
 * the wire, and a collector armed against a deadline. Every bug this phase has
 * had has been in that seam rather than in the grading — the old version armed
 * the button only after the wait, which made an early shot impossible and left
 * the grade to be decided by round-trip time.
 *
 * So the collector fake here honours its own deadline instead of standing in
 * for one: `time` arms it, `resetTimer` re-arms it, expiry fires `end('time')`,
 * and a press fires `collect` and ends it. Under fake timers that makes "the
 * player fired 2.1 seconds after the call, over a connection that took 400ms to
 * deliver it" a thing a test can actually say.
 */

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));

const { __test__ } = require('../src/commands/economy/hunt');
const { runAimPhase, AIM_WINDOW_MS, AIM_LATE_MS } = __test__;

const USER_ID = 'u1';
/** Math.random stubbed to 0, so the wait is the bottom of its 1000–2000ms range. */
const AIM_WAIT_MS = 1000;

/** A collector that keeps its own deadline, the way the real one does. */
function fakeCollector() {
    const self = {
        handlers: {},
        ended:    false,
        timer:    null,
        options:  null,
        resets:   [],

        arm(ms) {
            clearTimeout(self.timer);
            self.timer = setTimeout(() => self.finish('time'), ms);
        },
        on(event, fn) { self.handlers[event] = fn; return self; },
        resetTimer(opts) { self.resets.push(opts); self.arm(opts.time); },
        stop() { self.finish('user'); },

        finish(reason) {
            if (self.ended) return;
            self.ended = true;
            clearTimeout(self.timer);
            self.handlers.end?.(null, reason);
        },

        /** The player pressing Fire. Returns false if the window already closed. */
        async press() {
            if (self.ended) return false;
            self.ended = true;
            clearTimeout(self.timer);
            await self.handlers.collect({ user: { id: USER_ID }, deferUpdate: async () => {} });
            return true;
        },
    };
    return self;
}

/**
 * An interaction whose edits take `editMs` of wire time — the thing the phase
 * must not charge to the player.
 */
function fakeInteraction(editMs = 0) {
    return {
        id:   'interaction-1',
        user: { id: USER_ID },
        edits: [],
        editReply: jest.fn(function (payload) {
            this.edits.push(payload);
            return editMs ? new Promise(r => setTimeout(r, editMs)) : Promise.resolve();
        }),
    };
}

/** Title of the nth embed the phase rendered. */
const titleAt = (interaction, n) => interaction.edits[n]?.embeds?.[0]?.data?.title ?? '';

beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/** Starts the phase with the sights on screen and the button live. */
async function startPhase(editMs) {
    const interaction = fakeInteraction(editMs);
    const collector   = fakeCollector();
    const huntMsg     = { createMessageComponentCollector: opts => { collector.options = opts; collector.arm(opts.time); return collector; } };

    const phase = runAimPhase(interaction, huntMsg);
    await jest.advanceTimersByTimeAsync(editMs);   // the sights edit lands

    // Settling costs the result edit plus the 600ms beat after it.
    const settle = () => jest.advanceTimersByTimeAsync(editMs + 600).then(() => phase);

    return { interaction, collector, phase, settle, editMs };
}

/**
 * Runs the phase up to the moment the call is on screen, and reports when that
 * was. Leaves the returned promise pending so the caller can decide when — or
 * whether — to press.
 */
async function upToTheCall(editMs) {
    const started = await startPhase(editMs);
    const from    = Date.now();

    await jest.advanceTimersByTimeAsync(AIM_WAIT_MS);   // the wait
    await jest.advanceTimersByTimeAsync(editMs);        // the call going out

    return { ...started, calledAt: Date.now() - from + editMs };
}

describe('the aim phase pays for a shot taken after the call', () => {
    test('a shot inside the window is perfect', async () => {
        const { collector, settle } = await upToTheCall(0);

        await jest.advanceTimersByTimeAsync(300);
        expect(await collector.press()).toBe(true);

        expect((await settle()).grade).toBe('perfect');
    });

    test('a shot after the window closes is late, not nothing', async () => {
        const { collector, settle } = await upToTheCall(0);

        await jest.advanceTimersByTimeAsync(AIM_WINDOW_MS + 200);
        expect(await collector.press()).toBe(true);

        expect((await settle()).grade).toBe('late');
    });

    test('never firing scores nothing', async () => {
        const { collector, settle } = await upToTheCall(0);

        await jest.advanceTimersByTimeAsync(AIM_LATE_MS + 1);
        expect(collector.ended).toBe(true);

        expect((await settle()).grade).toBe('timeout');
    });
});

describe('the call is what the clock starts from, not the wait', () => {
    // 400ms is an ordinary mobile round trip. Before this, the collector was
    // armed for aimWaitMs + AIM_LATE_MS from before the edit went out, so those
    // 400ms came out of the player's grace: they had 2.1s to take a late shot
    // where a player on a fast connection had 2.5s.
    const SLOW_EDIT_MS = 400;

    test('the grace period is re-armed once the call is actually on screen', async () => {
        const { collector, settle, calledAt } = await upToTheCall(SLOW_EDIT_MS);

        expect(collector.resets).toEqual([{ time: AIM_LATE_MS }]);
        // Armed before the edit went out, the collector's original deadline was
        // AIM_LATE_MS from the wait — which is SLOW_EDIT_MS before this.
        expect(calledAt).toBe(AIM_WAIT_MS + 2 * SLOW_EDIT_MS);

        await jest.advanceTimersByTimeAsync(AIM_LATE_MS + 1);
        await settle();
    });

    test('a late shot near the end of the grace still counts on a slow connection', async () => {
        const { collector, settle } = await upToTheCall(SLOW_EDIT_MS);

        // Past where the deadline used to fall, inside the one the player was
        // promised.
        await jest.advanceTimersByTimeAsync(AIM_LATE_MS - 50);
        expect(collector.ended).toBe(false);
        expect(await collector.press()).toBe(true);

        expect((await settle()).grade).toBe('late');
    });

    test('the grace still ends — a slow connection does not buy unlimited time', async () => {
        const { collector, settle } = await upToTheCall(SLOW_EDIT_MS);

        await jest.advanceTimersByTimeAsync(AIM_LATE_MS + 1);
        expect(collector.ended).toBe(true);
        expect(await collector.press()).toBe(false);

        expect((await settle()).grade).toBe('timeout');
    });

    test('a slow connection does not shorten the perfect window either', async () => {
        const { collector, settle } = await upToTheCall(SLOW_EDIT_MS);

        await jest.advanceTimersByTimeAsync(AIM_WINDOW_MS);
        expect(await collector.press()).toBe(true);

        expect((await settle()).grade).toBe('perfect');
    });
});

describe('firing before the call', () => {
    test('is graded as rushed, and costs', async () => {
        const { collector, settle } = await startPhase(0);

        // Mashing the trigger the moment the button appears — which used to be
        // the optimal play, because the button only appeared when it was time.
        await jest.advanceTimersByTimeAsync(200);
        expect(await collector.press()).toBe(true);

        const aim = await settle();
        expect(aim.grade).toBe('early');
        expect(aim.bonus).toBeLessThan(0);
    });

    test('never shows the FIRE! call — a player who jumped the gun is not told they were on time', async () => {
        const { interaction, collector, settle } = await startPhase(0);

        await jest.advanceTimersByTimeAsync(200);
        await collector.press();
        await settle();

        expect(titleAt(interaction, 0)).toMatch(/Target in Sights/);
        expect(interaction.edits.map(e => e.embeds?.[0]?.data?.title ?? '')).not.toContain('💥 FIRE!');
        expect(titleAt(interaction, 1)).toMatch(/rushed it/);
    });

    test('the button is on the message from the moment the sights are', async () => {
        // The whole mechanic rests on this: an early shot has to be possible.
        const { interaction, settle } = await startPhase(0);

        expect(titleAt(interaction, 0)).toMatch(/Target in Sights/);
        expect(interaction.edits[0].components).toHaveLength(1);

        await jest.advanceTimersByTimeAsync(AIM_WAIT_MS + AIM_LATE_MS + 1);
        await settle();
    });
});
