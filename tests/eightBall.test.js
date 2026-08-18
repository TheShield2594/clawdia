'use strict';

// The 8-ball's pure logic: the answer distribution the toy is supposed to have,
// and the question sanitising that keeps a hostile question inside its quote.

// The shake animation sleeps between frames. Nothing under test depends on the
// wall-clock gap, and the handler tests drive a dozen shakes apiece.
jest.mock('../src/utils/delay', () => ({ delay: () => Promise.resolve() }));

const { __test__ } = require('../src/commands/fun/8ball');
const { RESPONSES, TYPE_CONFIG, pickResponse, normalizeQuestion, quoteQuestion, MAX_QUESTION } = __test__;

// Deterministic stand-in for Math.random that walks a fixed list of values.
function seq(values) {
    let i = 0;
    return () => values[i++ % values.length];
}

describe('response table', () => {
    test('carries the classic 20 answers, 10/5/5', () => {
        expect(RESPONSES.positive).toHaveLength(10);
        expect(RESPONSES.neutral).toHaveLength(5);
        expect(RESPONSES.negative).toHaveLength(5);
    });

    test('every category has display config', () => {
        for (const type of Object.keys(RESPONSES)) {
            expect(TYPE_CONFIG[type]).toMatchObject({
                color:   expect.stringMatching(/^#[0-9a-f]{6}$/i),
                emoji:   expect.any(String),
                outlook: expect.any(String),
            });
        }
    });
});

describe('pickResponse', () => {
    test('maps the category roll to the documented 50/25/25 split', () => {
        expect(pickResponse(seq([0.00, 0])).type).toBe('positive');
        expect(pickResponse(seq([0.49, 0])).type).toBe('positive');
        expect(pickResponse(seq([0.50, 0])).type).toBe('neutral');
        expect(pickResponse(seq([0.74, 0])).type).toBe('neutral');
        expect(pickResponse(seq([0.75, 0])).type).toBe('negative');
        expect(pickResponse(seq([0.99, 0])).type).toBe('negative');
    });

    test('the second roll indexes within the category', () => {
        expect(pickResponse(seq([0.0, 0.0])).text).toBe(RESPONSES.positive[0]);
        expect(pickResponse(seq([0.0, 0.99])).text).toBe(RESPONSES.positive[9]);
        expect(pickResponse(seq([0.8, 0.99])).text).toBe(RESPONSES.negative[4]);
    });

    test('never indexes off the end of a pool', () => {
        for (const r of [0.0, 0.5, 0.75]) {
            const { type, text } = pickResponse(seq([r, 0.9999999]));
            expect(RESPONSES[type]).toContain(text);
        }
    });

    test('answers are uniform 1-in-20, like the physical toy', () => {
        // Sweep the category roll evenly, then the in-pool roll evenly: every
        // answer should come up the same number of times.
        const counts = new Map();
        const STEPS = 2000;
        for (let a = 0; a < STEPS; a++) {
            for (let b = 0; b < 20; b++) {
                const { text } = pickResponse(seq([a / STEPS, b / 20]));
                counts.set(text, (counts.get(text) ?? 0) + 1);
            }
        }

        const all = Object.values(RESPONSES).flat();
        expect(counts.size).toBe(20);
        expect(all.every(text => counts.has(text))).toBe(true);

        const expected = (STEPS * 20) / 20;
        for (const [, n] of counts) {
            // Well inside the rounding slack of the sweep.
            expect(Math.abs(n - expected)).toBeLessThan(expected * 0.02);
        }
    });

    test('defaults to Math.random and stays in the table', () => {
        for (let i = 0; i < 200; i++) {
            const { type, text } = pickResponse();
            expect(RESPONSES[type]).toContain(text);
        }
    });
});

describe('normalizeQuestion', () => {
    test('trims and collapses whitespace so the quote stays on one line', () => {
        expect(normalizeQuestion('  will   it\nrain\ttoday? ')).toBe('will it rain today?');
    });

    test('caps length even when the option limit is bypassed', () => {
        expect(normalizeQuestion('x'.repeat(500))).toHaveLength(MAX_QUESTION);
    });

    test('treats blank and missing input as no question', () => {
        expect(normalizeQuestion('   ')).toBe('');
        expect(normalizeQuestion('\n\t')).toBe('');
        expect(normalizeQuestion(null)).toBe('');
        expect(normalizeQuestion(undefined)).toBe('');
    });
});

describe('quoteQuestion', () => {
    test('escapes markdown instead of letting it reformat the embed', () => {
        const out = quoteQuestion('**bold** `code` ||spoiler||');
        expect(out).toContain('\\*\\*bold\\*\\*');
        expect(out).toContain('\\`code\\`');
        expect(out).not.toMatch(/(?<!\\)\|\|/);
    });

    test('renders as a single block-quote line', () => {
        const out = quoteQuestion(normalizeQuestion('am I\nsure?'));
        expect(out.split('\n')).toHaveLength(1);
        expect(out.startsWith('> ')).toBe(true);
    });
});

// ── Persistent buttons ───────────────────────────────────────────────────────
//
// The buttons are routed through events/interactionCreate rather than held by a
// collector, so they outlive the command, the session and the process. Nothing
// can be closed over: the owner rides in the custom id, and the question and
// shake count are read back off the message.

const {
    readState, ownerOf, isEightBallButton, isEightBallModal,
    buttonRow, resultView, shakingView, textContents,
    handleButton, handleModal, shaking, shakeLimiter, SHAKE_LIMIT, BALL_FILE,
} = __test__;

// What a rendered message looks like once Discord has round-tripped it: the
// builders are gone, leaving raw component JSON.
const asMessage = (view, id = 'msg-1') => ({ id, components: [view.toJSON()] });
const lastEdit  = interaction => interaction.editReply.mock.calls.at(-1)[0];
const viewJSON  = payload => payload.components[0].toJSON();
const textOf    = payload => textContents({ components: payload.components }).join('\n');

describe('custom ids', () => {
    test('claim only the 8-ball\'s own buttons', () => {
        expect(isEightBallButton('8ball_again_123')).toBe(true);
        expect(isEightBallButton('8ball_newq_123')).toBe(true);
        expect(isEightBallButton('8ball_modal_123')).toBe(false);
        expect(isEightBallButton('poll_vote_1')).toBe(false);
        expect(isEightBallModal('8ball_modal_123')).toBe(true);
        expect(isEightBallModal('8ball_again_123')).toBe(false);
    });

    test('carry the owner, and stay inside Discord\'s 100 character limit', () => {
        const snowflake = '1234567890123456789';
        for (const button of buttonRow(snowflake).toJSON().components) {
            expect(button.custom_id.length).toBeLessThanOrEqual(100);
            expect(ownerOf(button.custom_id)).toBe(snowflake);
        }
    });
});

describe('readState', () => {
    test('round-trips what a shake needs from a rendered message', () => {
        const quoted = quoteQuestion('will it rain?');
        const view   = resultView(quoted, { type: 'positive', text: 'Yes.' }, 4, '1111');

        expect(readState(asMessage(view))).toEqual({ quoted, shakes: 4 });
    });

    test('finds the question inside a nested section, not just a bare text display', () => {
        // The question lives in a Section's text display; the shake count lives
        // in a top-level one. Both have to be reachable.
        const json = resultView(quoteQuestion('nested?'), { type: 'neutral', text: 'Ask again later.' }, 2, '1111').toJSON();
        expect(json.components[0].type).toBe(9); // Section
        expect(textContents({ components: [json] }).length).toBeGreaterThan(1);
        expect(readState({ components: [json] }).quoted).toBe(quoteQuestion('nested?'));
    });

    test('carries an escaped question forward without re-escaping it', () => {
        const quoted = quoteQuestion('**really**?');
        const answer = { type: 'neutral', text: 'Ask again later.' };

        // A second shake reuses the stored string verbatim; escaping it again
        // would pile up backslashes with every click.
        const once  = readState(asMessage(resultView(quoted, answer, 1, '1111'))).quoted;
        const twice = readState(asMessage(resultView(once, answer, 2, '1111'))).quoted;
        expect(twice).toBe(quoted);
    });

    test('does not mistake the shake counter for part of the question', () => {
        const quoted = quoteQuestion('is Shake #9 a real question?');
        const state  = readState(asMessage(resultView(quoted, { type: 'positive', text: 'Yes.' }, 3, '1111')));
        expect(state.quoted).toBe(quoted);
        expect(state.shakes).toBe(3);
    });

    test('survives a message it cannot read', () => {
        for (const message of [undefined, {}, { components: [] }, { components: [{ type: 17 }] }]) {
            const state = readState(message);
            expect(typeof state.quoted).toBe('string');
            expect(state.shakes).toBe(0);
        }
    });
});

describe('rendering', () => {
    test('the answer is text as well as picture, and the ball carries alt text', () => {
        const payload = resultView(quoteQuestion('legible?'), { type: 'negative', text: 'Very doubtful.' }, 1, '1111').toJSON();
        const section = payload.components.find(c => c.type === 9);

        expect(section.accessory.media.url).toBe(`attachment://${BALL_FILE}`);
        expect(section.accessory.description).toContain('Very doubtful.');
        // Screen readers and image-blocked clients still get the verdict.
        expect(textContents({ components: [payload] }).join('\n')).toContain('Very doubtful.');
    });

    test('the accent colour tracks the outlook', () => {
        const colors = ['positive', 'neutral', 'negative'].map(type =>
            resultView('> *"q"*', { type, text: 'x' }, 1, '1111').toJSON().accent_color);
        expect(new Set(colors).size).toBe(3);
        expect(colors.every(Number.isInteger)).toBe(true);
    });

    test('a shaking ball shows no answer and no buttons to press', () => {
        const payload = shakingView(quoteQuestion('mid-shake?'), 0).toJSON();
        expect(JSON.stringify(payload)).not.toContain('attachment://');
        expect(payload.components.some(c => c.type === 1)).toBe(false);
    });
});

describe('button handler', () => {
    const OWNER = '1111';

    function buttonInteraction(overrides = {}) {
        return {
            customId:    `8ball_again_${OWNER}`,
            user:        { id: OWNER },
            message:     { id: `msg-${Math.random()}`, components: [] },
            reply:       jest.fn().mockResolvedValue(undefined),
            deferUpdate: jest.fn().mockResolvedValue(undefined),
            editReply:   jest.fn().mockResolvedValue(undefined),
            showModal:   jest.fn().mockResolvedValue(undefined),
            ...overrides,
        };
    }

    beforeEach(() => {
        shaking.clear();
        shakeLimiter._map.clear();
    });

    test('turns away members who do not own the ball', async () => {
        const i = buttonInteraction({ user: { id: 'someone-else' } });
        await handleButton(i);

        expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining(OWNER),
        }));
        expect(i.deferUpdate).not.toHaveBeenCalled();
    });

    test('opens the modal for a new question rather than shaking', async () => {
        const i = buttonInteraction({ customId: `8ball_newq_${OWNER}` });
        await handleButton(i);

        expect(i.showModal).toHaveBeenCalledTimes(1);
        expect(i.showModal.mock.calls[0][0].toJSON().custom_id).toBe(`8ball_modal_${OWNER}`);
        expect(i.editReply).not.toHaveBeenCalled();
    });

    test('shakes, and leaves the buttons attached for next time', async () => {
        const i = buttonInteraction();
        await handleButton(i);

        expect(i.deferUpdate).toHaveBeenCalled();
        const final = lastEdit(i);
        expect(final.components).toHaveLength(1);
        expect(viewJSON(final).components.some(c => c.type === 1)).toBe(true);
    });

    test('never pings the asker it names, however many times it is shaken', async () => {
        const i = buttonInteraction();
        await handleButton(i);

        const final = lastEdit(i);
        expect(textOf(final)).toContain('asked by <@');
        expect(final.allowedMentions).toEqual({ parse: [] });
    });

    test('clears the previous render so the message does not collect images', async () => {
        const i = buttonInteraction();
        await handleButton(i);

        for (const call of i.editReply.mock.calls) expect(call[0].attachments).toEqual([]);
        expect(lastEdit(i).files).toHaveLength(1);
    });

    test('counts up from whatever the message already recorded', async () => {
        const view = resultView(quoteQuestion('again?'), { type: 'positive', text: 'Yes.' }, 7, OWNER);
        const i = buttonInteraction({ message: asMessage(view, 'msg-count') });
        await handleButton(i);

        expect(textOf(lastEdit(i))).toContain('Shake #8');
    });

    test('rate limits a member hammering the button', async () => {
        for (let n = 0; n < SHAKE_LIMIT; n++) await handleButton(buttonInteraction());

        const blocked = buttonInteraction();
        await handleButton(blocked);
        expect(blocked.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('moment'),
        }));
        expect(blocked.editReply).not.toHaveBeenCalled();
    });

    test('a failed shake still lets go of the message', async () => {
        const message = { id: 'msg-boom', components: [] };
        const i = buttonInteraction({ message });
        i.deferUpdate.mockRejectedValue(new Error('unknown interaction'));

        // The error is the router's to log; what matters here is that the lock
        // doesn't outlive it and wedge the message shut.
        await expect(handleButton(i)).rejects.toThrow('unknown interaction');
        expect(shaking.has(message.id)).toBe(false);
    });

    test('one shake at a time per message', async () => {
        const message = { id: 'msg-shared', components: [] };
        const first  = buttonInteraction({ message });
        const second = buttonInteraction({ message });

        const running = handleButton(first);
        await handleButton(second);

        expect(second.editReply).not.toHaveBeenCalled();
        expect(second.deferUpdate).toHaveBeenCalled();
        await running;

        // The lock lifts once the first shake finishes.
        expect(shaking.has(message.id)).toBe(false);
    });
});

describe('modal handler', () => {
    const OWNER = '2222';

    function modalInteraction(value, overrides = {}) {
        return {
            customId:      `8ball_modal_${OWNER}`,
            user:          { id: OWNER },
            message:       { id: `msg-${Math.random()}`, components: [] },
            isFromMessage: () => true,
            fields:        { getTextInputValue: jest.fn().mockReturnValue(value) },
            reply:         jest.fn().mockResolvedValue(undefined),
            deferUpdate:   jest.fn().mockResolvedValue(undefined),
            editReply:     jest.fn().mockResolvedValue(undefined),
            ...overrides,
        };
    }

    beforeEach(() => {
        shaking.clear();
        shakeLimiter._map.clear();
    });

    test('asks the new question and restarts the count', async () => {
        const i = modalInteraction('will it snow?');
        await handleModal(i);

        const text = textOf(lastEdit(i));
        expect(text).toContain(quoteQuestion('will it snow?'));
        expect(text).toContain('Shake #1');
    });

    test('rejects a blank question without touching the message', async () => {
        const i = modalInteraction('   ');
        await handleModal(i);

        expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('actual question'),
        }));
        expect(i.editReply).not.toHaveBeenCalled();
    });

    test('ignores a submission that did not come from an 8-ball message', async () => {
        const i = modalInteraction('anything', { isFromMessage: () => false });
        await handleModal(i);

        expect(i.reply).not.toHaveBeenCalled();
        expect(i.editReply).not.toHaveBeenCalled();
    });
});
