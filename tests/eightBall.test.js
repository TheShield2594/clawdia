'use strict';

// The 8-ball's pure logic: the answer distribution the toy is supposed to have,
// and the question sanitising that keeps a hostile question inside its quote.

// The shake plays for a beat before the answer surfaces. Nothing under test
// depends on the wall-clock gap, and the handler tests drive a dozen shakes apiece.
jest.mock('../src/utils/delay', () => ({ delay: () => Promise.resolve() }));

// Server command policy is read per press; by default no guild, no policy.
jest.mock('../src/utils/guildSettingsCache', () => ({
    getGuildSettings: jest.fn().mockResolvedValue(null),
}));

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

    test('every category has an accent colour', () => {
        for (const type of Object.keys(RESPONSES)) {
            expect(TYPE_CONFIG[type]).toMatchObject({
                color: expect.stringMatching(/^#[0-9a-f]{6}$/i),
            });
        }
    });

    test('every language carries the same answers, index for index', () => {
        const { STRINGS } = __test__;
        for (const strings of Object.values(STRINGS)) {
            for (const type of Object.keys(RESPONSES)) {
                expect(strings.answers[type]).toHaveLength(RESPONSES[type].length);
            }
        }
    });

    test('the same roll picks the same answer in every language', () => {
        const en = pickResponse(seq([0.8, 0.5]), 'en');
        const es = pickResponse(seq([0.8, 0.5]), 'es');
        expect(es.type).toBe(en.type);
        expect(es.index).toBe(en.index);
        expect(es.text).toBe(__test__.STRINGS.es.answers[en.type][en.index]);
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

    test('escapes masked links, so a question cannot plant a disguised link in a bot message', () => {
        const out = quoteQuestion('is [this](https://evil.example) safe?');
        expect(out).toContain('\\[this]');
        expect(out).not.toMatch(/(?<!\\)\[this\]\(/);
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

const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const command = require('../src/commands/fun/8ball');

const {
    readState, ownerOf, isEightBallButton, isEightBallModal, langOf,
    buttonRow, resultView, shakingView, cloudedView, textContents, STRINGS,
    handleButton, handleModal, shaking, shakeLimiter, SHAKE_LIMIT,
    BALL_FILE, SHAKE_FILE, OWN_BUTTON, OWN_MODAL,
} = __test__;

// What a rendered message looks like once Discord has round-tripped it: the
// builders are gone, leaving raw component JSON.
const asMessage = (view, id = 'msg-1') => ({ id, components: [view.toJSON()] });
const lastEdit  = interaction => interaction.editReply.mock.calls.at(-1)[0];
const viewJSON  = payload => payload.components[0].toJSON();
const textOf    = payload => textContents({ components: payload.components }).join('\n');
const buttonsOf = json => json.components.find(c => c.type === ComponentType.ActionRow).components;
const galleryOf = json => json.components.find(c => c.type === ComponentType.MediaGallery);

const { ComponentType, ButtonStyle } = require('discord.js');

// A guild whose policy blocks /8ball outright.
const BLOCKED = {
    commandPolicies: { enabled: true, rules: [{ command: '8ball', effect: 'deny' }] },
};

beforeEach(() => {
    shaking.clear();
    shakeLimiter._map.clear();
    getGuildSettings.mockReset().mockResolvedValue(null);
});

describe('custom ids', () => {
    test('claim only the 8-ball\'s own buttons', () => {
        expect(isEightBallButton('8ball_again_123')).toBe(true);
        expect(isEightBallButton('8ball_newq_123')).toBe(true);
        expect(isEightBallButton(OWN_BUTTON)).toBe(true);
        expect(isEightBallButton('8ball_modal_123')).toBe(false);
        expect(isEightBallButton('poll_vote_1')).toBe(false);
        expect(isEightBallModal('8ball_modal_123')).toBe(true);
        expect(isEightBallModal(OWN_MODAL)).toBe(true);
        expect(isEightBallModal('8ball_again_123')).toBe(false);
    });

    test('carry the owner, and stay inside Discord\'s 100 character limit', () => {
        const snowflake = '1234567890123456789';
        const owned = buttonRow(snowflake).toJSON().components.filter(b => b.custom_id !== OWN_BUTTON);
        expect(owned).toHaveLength(2);
        for (const button of owned) {
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

    test('a first answer carries no count, and still reads as one shake', () => {
        const view = resultView(quoteQuestion('first?'), { type: 'positive', text: 'Yes.' }, 1, '1111');
        expect(textContents(asMessage(view)).join('\n')).not.toContain('×');
        expect(readState(asMessage(view)).shakes).toBe(1);
    });

    test('reads the count whatever language the ball was asked in', () => {
        const view = resultView(quoteQuestion('¿sí?'), { type: 'positive', text: 'Sí.' }, 6, '1111', 'es');
        expect(readState(asMessage(view)).shakes).toBe(6);
    });

    test('still reads balls posted before the current layout', () => {
        // The old layout: a Section holding the question, then "Shake #n".
        const legacy = { components: [{ type: 17, components: [
            { type: 9, components: [{ type: 10, content: '### 🎱 Magic 8-Ball\n> *"old?"*' }] },
            { type: 10, content: '## ✅ Yes.\n-# Positive · Shake #5 · asked by <@1111>' },
        ] }] };
        expect(readState(legacy)).toEqual({ quoted: '> *"old?"*', shakes: 5 });
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
        const quoted = quoteQuestion('is ×9 or Shake #9 a real question?');
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
    const answer = { type: 'negative', text: 'Very doubtful.' };

    test('the ball is the hero image, and the answer is text as well as picture', () => {
        const payload = resultView(quoteQuestion('legible?'), answer, 1, '1111').toJSON();
        const [item] = galleryOf(payload).items;

        expect(item.media.url).toBe(`attachment://${BALL_FILE}`);
        expect(item.description).toContain('Very doubtful.');
        // Screen readers and image-blocked clients still get the verdict.
        expect(textContents({ components: [payload] }).join('\n')).toContain('## Very doubtful.');
    });

    test('the accent colour tracks the outlook', () => {
        const colors = ['positive', 'neutral', 'negative'].map(type =>
            resultView('> *"q"*', { type, text: 'x' }, 1, '1111').toJSON().accent_color);
        expect(new Set(colors).size).toBe(3);
        expect(colors.every(Number.isInteger)).toBe(true);
    });

    test('shaking and answered share one layout, so the message never changes height', () => {
        const kinds = view => view.toJSON().components.map(c => c.type);
        const shake = shakingView(quoteQuestion('q'), 1, '1111');
        const done  = resultView(quoteQuestion('q'), answer, 1, '1111');
        expect(kinds(shake)).toEqual(kinds(done));
    });

    test('a shaking ball shows the clip, no answer, and a greyed Shake Again', () => {
        const payload = shakingView(quoteQuestion('mid-shake?'), 1, '1111').toJSON();
        expect(galleryOf(payload).items[0].media.url).toBe(`attachment://${SHAKE_FILE}`);
        expect(JSON.stringify(payload)).not.toContain(BALL_FILE);

        const [again, newq, own] = buttonsOf(payload);
        expect(again.disabled).toBe(true);
        // New Question stays live: it is the way back into a ball a restart
        // left mid-shake.
        expect(newq.disabled).toBeFalsy();
        expect(own.disabled).toBeFalsy();
    });

    test('a hazy answer puts Shake Again forward', () => {
        const [again] = buttonsOf(resultView('> *"q"*', { type: 'neutral', text: 'Reply hazy, try again.' }, 1, '1').toJSON());
        expect(again.style).toBe(ButtonStyle.Primary);
        const [plain] = buttonsOf(resultView('> *"q"*', { type: 'positive', text: 'Yes.' }, 1, '1').toJSON());
        expect(plain.style).toBe(ButtonStyle.Secondary);
    });

    test('no outlook labels: the answer speaks for itself', () => {
        const text = textContents(asMessage(resultView('> *"q"*', { type: 'positive', text: 'Yes.' }, 1, '1'))).join('\n');
        expect(text).not.toMatch(/Positive|Negative|Uncertain|✅|❌/);
    });

    test('the shake count gets impatient', () => {
        const meta = n => textContents(asMessage(resultView('> *"q"*', answer, n, '1'))).join('\n');
        expect(meta(2)).toContain('×2');
        expect(meta(5)).toContain('impatient');
        expect(meta(12)).toContain('lie down');
    });

    test('a clouded ball keeps its buttons live and its count readable', () => {
        const payload = cloudedView(quoteQuestion('q'), 3, '1111').toJSON();
        expect(buttonsOf(payload).every(b => !b.disabled)).toBe(true);
        expect(readState({ components: [payload] })).toEqual({ quoted: quoteQuestion('q'), shakes: 3 });
    });
});

describe('language', () => {
    test('follows the asker\'s Discord client language', () => {
        expect(langOf({ locale: 'es-ES' })).toBe('es');
        expect(langOf({ locale: 'es-419' })).toBe('es');
        expect(langOf({ locale: 'en-GB' })).toBe('en');
        expect(langOf({ locale: 'fr' })).toBe('en');
        expect(langOf({})).toBe('en');
    });

    test('a Spanish ball is Spanish throughout', () => {
        const payload = resultView('> *"q"*', { type: 'positive', text: 'Sí.' }, 1, '1', 'es').toJSON();
        expect(textContents({ components: [payload] }).join('\n')).toContain(STRINGS.es.heading);
        expect(buttonsOf(payload).map(b => b.label)).toEqual([
            STRINGS.es.shakeAgain, STRINGS.es.newQuestion, STRINGS.es.askOwn,
        ]);
    });
});

describe('button handler', () => {
    const OWNER = '1111';

    function buttonInteraction(overrides = {}) {
        return {
            customId:    `8ball_again_${OWNER}`,
            user:        { id: OWNER },
            guild:       { id: 'guild-1' },
            locale:      'en-US',
            message:     { id: `msg-${Math.random()}`, components: [] },
            reply:       jest.fn().mockResolvedValue(undefined),
            deferUpdate: jest.fn().mockResolvedValue(undefined),
            editReply:   jest.fn().mockResolvedValue(undefined),
            showModal:   jest.fn().mockResolvedValue(undefined),
            ...overrides,
        };
    }

    test('turns away members who do not own the ball, and points them at their own', async () => {
        const i = buttonInteraction({ user: { id: 'someone-else' } });
        await handleButton(i);

        expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining(OWNER),
        }));
        expect(i.reply.mock.calls[0][0].content).toContain('Ask Your Own');
        expect(i.deferUpdate).not.toHaveBeenCalled();
    });

    test('opens the modal for a new question rather than shaking', async () => {
        const i = buttonInteraction({ customId: `8ball_newq_${OWNER}` });
        await handleButton(i);

        expect(i.showModal).toHaveBeenCalledTimes(1);
        expect(i.showModal.mock.calls[0][0].toJSON().custom_id).toBe(`8ball_modal_${OWNER}`);
        expect(i.editReply).not.toHaveBeenCalled();
    });

    test('Ask Your Own opens a question for anyone who presses it', async () => {
        const i = buttonInteraction({ customId: OWN_BUTTON, user: { id: 'bystander' } });
        await handleButton(i);

        expect(i.reply).not.toHaveBeenCalled();
        expect(i.showModal.mock.calls[0][0].toJSON().custom_id).toBe(OWN_MODAL);
    });

    test('shows the shake, then the answer, with the buttons attached for next time', async () => {
        const i = buttonInteraction();
        await handleButton(i);

        expect(i.deferUpdate).toHaveBeenCalled();
        expect(i.editReply).toHaveBeenCalledTimes(2);
        const [shake, final] = i.editReply.mock.calls.map(c => c[0]);
        expect(shake.files[0].name).toBe(SHAKE_FILE);
        expect(final.files[0].name).toBe(BALL_FILE);
        expect(buttonsOf(viewJSON(final)).every(b => !b.disabled)).toBe(true);
    });

    test('never pings the asker it names, however many times it is shaken', async () => {
        const i = buttonInteraction();
        await handleButton(i);

        for (const [payload] of i.editReply.mock.calls) {
            expect(textOf(payload)).toContain('Asked by <@');
            expect(payload.allowedMentions).toEqual({ parse: [] });
        }
    });

    test('clears the previous render so the message does not collect images', async () => {
        const i = buttonInteraction();
        await handleButton(i);

        for (const call of i.editReply.mock.calls) {
            expect(call[0].attachments).toEqual([]);
            expect(call[0].files).toHaveLength(1);
        }
    });

    test('counts up from whatever the message already recorded', async () => {
        const view = resultView(quoteQuestion('again?'), { type: 'positive', text: 'Yes.' }, 7, OWNER);
        const i = buttonInteraction({ message: asMessage(view, 'msg-count') });
        await handleButton(i);

        expect(textOf(lastEdit(i))).toContain('×8');
    });

    test('answers in the presser\'s language', async () => {
        const i = buttonInteraction({ locale: 'es-ES' });
        await handleButton(i);

        const text = textOf(lastEdit(i));
        expect(text).toContain(STRINGS.es.heading);
        expect(Object.values(STRINGS.es.answers).flat().some(a => text.includes(`## ${a}`))).toBe(true);
    });

    test('rate limits a member hammering the button', async () => {
        for (let n = 0; n < SHAKE_LIMIT; n++) await handleButton(buttonInteraction());

        const blocked = buttonInteraction();
        await handleButton(blocked);
        expect(blocked.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: STRINGS.en.tooHard,
        }));
        expect(blocked.editReply).not.toHaveBeenCalled();
    });

    test('obeys the server\'s command policy, like the slash command does', async () => {
        getGuildSettings.mockResolvedValue(BLOCKED);
        for (const customId of [`8ball_again_${OWNER}`, `8ball_newq_${OWNER}`, OWN_BUTTON]) {
            const i = buttonInteraction({ customId });
            await handleButton(i);

            expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('blocked'),
            }));
            expect(i.showModal).not.toHaveBeenCalled();
            expect(i.editReply).not.toHaveBeenCalled();
        }
    });

    test('refuses rather than guesses when server settings cannot be read', async () => {
        getGuildSettings.mockRejectedValue(new Error('db down'));
        const i = buttonInteraction();
        await handleButton(i);

        expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: STRINGS.en.settingsDown }));
        expect(i.editReply).not.toHaveBeenCalled();
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

    test('a shake that cannot deliver its answer puts the buttons back', async () => {
        const i = buttonInteraction();
        i.editReply
            .mockResolvedValueOnce(undefined)                   // the shaking view
            .mockRejectedValueOnce(new Error('upload failed'))  // the answer
            .mockResolvedValueOnce(undefined);                  // the recovery

        await expect(handleButton(i)).rejects.toThrow('upload failed');
        const recovered = viewJSON(lastEdit(i));
        expect(textOf(lastEdit(i))).toContain(STRINGS.en.clouded);
        expect(buttonsOf(recovered).every(b => !b.disabled)).toBe(true);
    });

    test('one shake at a time per message', async () => {
        const message = { id: 'msg-shared', components: [] };
        const first  = buttonInteraction({ message });
        const second = buttonInteraction({ message });

        // Hold the first shake open until the second press has landed.
        let release;
        first.deferUpdate.mockReturnValue(new Promise(resolve => { release = resolve; }));

        const running = handleButton(first);
        await new Promise(setImmediate);
        expect(shaking.has(message.id)).toBe(true);
        await handleButton(second);
        release();

        expect(second.editReply).not.toHaveBeenCalled();
        expect(second.deferUpdate).toHaveBeenCalled();
        await running;

        // The lock lifts once the first shake finishes.
        expect(shaking.has(message.id)).toBe(false);
    });

    test('a press the lock drops does not spend a shake', async () => {
        shaking.add('msg-busy');
        await handleButton(buttonInteraction({ message: { id: 'msg-busy', components: [] } }));
        expect(shakeLimiter._map.get(OWNER)).toBeUndefined();
    });
});

describe('modal handler', () => {
    const OWNER = '2222';

    function modalInteraction(value, overrides = {}) {
        return {
            customId:      `8ball_modal_${OWNER}`,
            user:          { id: OWNER },
            guild:         { id: 'guild-1' },
            locale:        'en-US',
            message:       { id: `msg-${Math.random()}`, components: [] },
            isFromMessage: () => true,
            fields:        { getTextInputValue: jest.fn().mockReturnValue(value) },
            reply:         jest.fn().mockResolvedValue({ resource: { message: { id: `new-${Math.random()}` } } }),
            deferUpdate:   jest.fn().mockResolvedValue(undefined),
            editReply:     jest.fn().mockResolvedValue(undefined),
            ...overrides,
        };
    }

    test('asks the new question and restarts the count', async () => {
        const view = resultView(quoteQuestion('old?'), { type: 'positive', text: 'Yes.' }, 7, OWNER);
        const i = modalInteraction('will it snow?', { message: asMessage(view) });
        await handleModal(i);

        const text = textOf(lastEdit(i));
        expect(text).toContain(quoteQuestion('will it snow?'));
        expect(readState({ components: lastEdit(i).components }).shakes).toBe(1);
    });

    test('rejects a blank question without touching the message', async () => {
        const i = modalInteraction('   ');
        await handleModal(i);

        expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: STRINGS.en.noQuestion }));
        expect(i.editReply).not.toHaveBeenCalled();
    });

    test('refuses a submission that did not come from an 8-ball message', async () => {
        const i = modalInteraction('anything', { isFromMessage: () => false });
        await handleModal(i);

        expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: expect.anything() }));
        expect(i.editReply).not.toHaveBeenCalled();
    });

    test('a question sent mid-shake is refused out loud, not dropped', async () => {
        const i = modalInteraction('now?');
        shaking.add(i.message.id);
        await handleModal(i);

        expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: STRINGS.en.settling }));
        expect(i.editReply).not.toHaveBeenCalled();
    });

    test('Ask Your Own posts a fresh ball owned by whoever asked', async () => {
        const i = modalInteraction('mine?', { customId: OWN_MODAL, user: { id: 'bystander' } });
        await handleModal(i);

        const [posted] = i.reply.mock.calls[0];
        expect(posted.withResponse).toBe(true);
        expect(posted.files[0].name).toBe(SHAKE_FILE);
        expect(i.deferUpdate).not.toHaveBeenCalled();

        const final = lastEdit(i);
        expect(textOf(final)).toContain(quoteQuestion('mine?'));
        expect(textOf(final)).toContain('<@bystander>');
        expect(buttonsOf(viewJSON(final))[0].custom_id).toBe('8ball_again_bystander');
    });

    test('obeys the server\'s command policy', async () => {
        getGuildSettings.mockResolvedValue(BLOCKED);
        const i = modalInteraction('blocked?', { customId: OWN_MODAL });
        await handleModal(i);

        expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('blocked'),
        }));
        expect(i.editReply).not.toHaveBeenCalled();
    });
});

describe('slash command', () => {
    function slash(question, overrides = {}) {
        return {
            user:      { id: '3333' },
            locale:    'en-US',
            options:   { getString: () => question },
            reply:     jest.fn().mockResolvedValue({ resource: { message: { id: `slash-${Math.random()}` } } }),
            editReply: jest.fn().mockResolvedValue(undefined),
            ...overrides,
        };
    }

    test('posts the shake, then settles on an answer', async () => {
        const i = slash('will it work?');
        await command.execute(i);

        expect(i.reply).toHaveBeenCalledTimes(1);
        expect(i.reply.mock.calls[0][0].files[0].name).toBe(SHAKE_FILE);
        // One edit, straight to the answer: no duplicate first frame.
        expect(i.editReply).toHaveBeenCalledTimes(1);
        expect(lastEdit(i).files[0].name).toBe(BALL_FILE);
    });

    test('spends from the same shake budget as the buttons', async () => {
        for (let n = 0; n < SHAKE_LIMIT; n++) await command.execute(slash('again?'));

        const blocked = slash('again?');
        await command.execute(blocked);
        expect(blocked.reply).toHaveBeenCalledWith(expect.objectContaining({ content: STRINGS.en.tooHard }));
        expect(blocked.editReply).not.toHaveBeenCalled();
    });

    test('holds the message lock while it shakes', async () => {
        let id;
        const i = slash('locked?');
        i.reply.mockImplementation(async () => {
            id = 'slash-locked';
            return { resource: { message: { id } } };
        });
        i.editReply.mockImplementation(async () => {
            expect(shaking.has(id)).toBe(true);
        });
        await command.execute(i);
        expect(shaking.has(id)).toBe(false);
    });
});
