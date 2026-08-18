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
    buttonRow, resultEmbed, handleButton, handleModal, shaking, shakeLimiter,
    SHAKE_LIMIT,
} = __test__;

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
    const author = { name: 'Asker', iconURL: 'https://example.invalid/a.png' };

    function messageFrom(embed) {
        return { id: 'msg-1', embeds: [embed.toJSON()] };
    }

    test('round-trips what a shake needs from a rendered message', () => {
        const quoted = quoteQuestion('will it rain?');
        const embed  = resultEmbed(author, quoted, { type: 'positive', text: 'Yes.' }, 4);

        const state = readState(messageFrom(embed));
        expect(state.quoted).toBe(quoted);
        expect(state.shakes).toBe(4);
        expect(state.author).toEqual(author);
    });

    test('reads the author whichever way the avatar field is spelled', () => {
        // messageFrom() hands over the raw gateway shape (icon_url); the Embed
        // class discord.js wraps it in exposes the same value as iconURL.
        const quoted = quoteQuestion('either way?');
        const embed  = resultEmbed(author, quoted, { type: 'positive', text: 'Yes.' }, 1);

        const wrapped = {
            id: 'msg-2',
            embeds: [{ ...embed.toJSON(), author: { name: author.name, iconURL: author.iconURL } }],
        };
        expect(readState(wrapped).author).toEqual(author);
    });

    test('carries an escaped question forward without re-escaping it', () => {
        const quoted = quoteQuestion('**really**?');
        const embed  = resultEmbed(author, quoted, { type: 'neutral', text: 'Ask again later.' }, 1);

        // A second shake reuses the stored string verbatim; escaping it again
        // would pile up backslashes with every click.
        const once  = readState(messageFrom(embed)).quoted;
        const twice = readState(messageFrom(resultEmbed(author, once, { type: 'neutral', text: 'Ask again later.' }, 2))).quoted;
        expect(twice).toBe(quoted);
    });

    test('survives a message it cannot read', () => {
        for (const message of [undefined, {}, { embeds: [] }, { embeds: [{}] }]) {
            const state = readState(message);
            expect(typeof state.quoted).toBe('string');
            expect(state.shakes).toBe(0);
            expect(state.author).toBeNull();
        }
    });
});

describe('button handler', () => {
    const OWNER = '1111';

    function buttonInteraction(overrides = {}) {
        return {
            customId:    `8ball_again_${OWNER}`,
            user:        { id: OWNER },
            message:     { id: `msg-${Math.random()}`, embeds: [] },
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
        const final = i.editReply.mock.calls.at(-1)[0];
        expect(final.components).toHaveLength(1);
        expect(final.components[0].toJSON().components).toHaveLength(2);
    });

    test('counts up from whatever the message already recorded', async () => {
        const embed = resultEmbed(null, quoteQuestion('again?'), { type: 'positive', text: 'Yes.' }, 7);
        const i = buttonInteraction({ message: { id: 'msg-count', embeds: [embed.toJSON()] } });
        await handleButton(i);

        const shown = i.editReply.mock.calls.at(-1)[0].embeds[0].toJSON();
        expect(shown.fields.find(f => f.name === '🌀 Shakes').value).toBe('**8**');
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

    test('one shake at a time per message', async () => {
        const message = { id: 'msg-shared', embeds: [] };
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
            message:       { id: `msg-${Math.random()}`, embeds: [] },
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

        const shown = i.editReply.mock.calls.at(-1)[0].embeds[0].toJSON();
        expect(shown.description).toBe(quoteQuestion('will it snow?'));
        expect(shown.fields.find(f => f.name === '🌀 Shakes').value).toBe('**1**');
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
