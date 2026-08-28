'use strict';

/**
 * #838, the schema half. Everything else in the MCP directory is the bot asking
 * a server for something; elicitation is the one exchange that runs the other
 * way — a tool that has got halfway and needs one more fact asks the person,
 * down the same stream its result is still coming on, and waits.
 *
 * What is pinned here is what a server is allowed to ask for and what comes
 * back when it asks for something else. The spec restricts `requestedSchema` to
 * a flat object of primitives; this enforces it rather than trusting it,
 * because a modal holds five inputs and a schema this cannot render honestly is
 * better declined in a sentence the model can read than half-collected.
 */

const {
    fieldsOf, fieldOf, coerce, collect, promptText, MAX_FIELDS, MAX_ELICITATIONS_PER_TURN,
} = require('../src/services/ai/mcp/elicitation');

const schema = (properties, required = []) => ({ type: 'object', properties, required });

describe('what a server is allowed to ask for', () => {
    test('a flat object of primitives becomes fields', () => {
        const { fields } = fieldsOf(schema({
            name: { type: 'string', title: 'Your name' },
            count: { type: 'integer' },
            confirm: { type: 'boolean' },
        }, ['name']));

        expect(fields).toEqual([
            expect.objectContaining({ name: 'name', title: 'Your name', kind: 'string', required: true }),
            expect.objectContaining({ name: 'count', kind: 'integer', required: false }),
            expect.objectContaining({ name: 'confirm', kind: 'boolean', required: false }),
        ]);
    });

    // A list of legal answers beats a blank box somebody can get wrong, so an
    // enum is read as a choice before its declared type is looked at.
    test('an enum is a choice rather than free text', () => {
        expect(fieldOf('env', { type: 'string', enum: ['staging', 'production'] }))
            .toMatchObject({ kind: 'enum', options: ['staging', 'production'] });
    });

    test('a nested object is refused, not flattened', () => {
        expect(fieldsOf(schema({ user: { type: 'object', properties: {} } })).error)
            .toMatch(/not a type this client can ask a person for/);
    });

    test('an array is refused too', () => {
        expect(fieldsOf(schema({ tags: { type: 'array' } })).error).toBeTruthy();
    });

    test('a schema with no properties is refused', () => {
        expect(fieldsOf({ type: 'object' }).error).toMatch(/no properties/);
        expect(fieldsOf(schema({})).error).toMatch(/asks for nothing/);
        expect(fieldsOf(null).error).toBeTruthy();
    });

    // Half the fields collected is a tool call that fails on the far side with
    // a message about the ones it did not get.
    test(`more than ${MAX_FIELDS} fields is refused rather than truncated`, () => {
        const many = Object.fromEntries(
            Array.from({ length: MAX_FIELDS + 1 }, (_, i) => [`f${i}`, { type: 'string' }]),
        );
        expect(fieldsOf(schema(many)).error).toMatch(new RegExp(`at most ${MAX_FIELDS}`));
    });

    test(`exactly ${MAX_FIELDS} is allowed`, () => {
        const many = Object.fromEntries(
            Array.from({ length: MAX_FIELDS }, (_, i) => [`f${i}`, { type: 'string' }]),
        );
        expect(fieldsOf(schema(many)).fields).toHaveLength(MAX_FIELDS);
    });

    // Titles and descriptions are somebody else's text going into a Discord
    // message, and a backtick in the wrong place turns the rest of it into
    // prose.
    test('the server\'s own words are flattened and clamped', () => {
        const { fields } = fieldsOf(schema({
            q: { type: 'string', title: `a\nvery ${'long '.repeat(30)}title with \`backticks\`` },
        }));

        expect(fields[0].title).not.toContain('\n');
        expect(fields[0].title).not.toContain('`');
        expect(fields[0].title.length).toBeLessThanOrEqual(45);
    });
});

describe('turning what somebody typed into what the schema asked for', () => {
    const field = (over = {}) => ({ name: 'x', title: 'X', required: true, kind: 'string', ...over });

    test('a string is itself, trimmed', () => {
        expect(coerce(field(), '  hello  ')).toEqual({ value: 'hello' });
    });

    test.each([['yes', true], ['y', true], ['true', true], ['1', true], ['no', false], ['FALSE', false], ['off', false]])(
        '"%s" is read as %s', (typed, value) => {
            expect(coerce(field({ kind: 'boolean' }), typed)).toEqual({ value });
        });

    test('and anything else is an error the person can act on', () => {
        expect(coerce(field({ kind: 'boolean' }), 'maybe').error).toMatch(/yes or no/);
    });

    test('a number has to be one', () => {
        expect(coerce(field({ kind: 'number' }), '4.5')).toEqual({ value: 4.5 });
        expect(coerce(field({ kind: 'number' }), 'four').error).toMatch(/should be a number/);
    });

    test('an integer has to be whole', () => {
        expect(coerce(field({ kind: 'integer' }), '4.5').error).toMatch(/whole number/);
        expect(coerce(field({ kind: 'integer' }), '4')).toEqual({ value: 4 });
    });

    test('and stays inside the bounds the schema gave', () => {
        const bounded = field({ kind: 'integer', minimum: 1, maximum: 10 });
        expect(coerce(bounded, '0').error).toMatch(/at least 1/);
        expect(coerce(bounded, '11').error).toMatch(/at most 10/);
        expect(coerce(bounded, '5')).toEqual({ value: 5 });
    });

    // The list is the authority on spelling; the person is typing one of the
    // options they were just shown.
    test('an enum matches case-insensitively and comes back canonical', () => {
        const enumField = field({ kind: 'enum', options: ['Staging', 'Production'] });
        expect(coerce(enumField, 'production')).toEqual({ value: 'Production' });
        expect(coerce(enumField, 'dev').error).toMatch(/one of: Staging, Production/);
    });

    // "" is a different statement from "no value", especially to a tool that
    // will pass it straight to an API.
    test('an empty optional answer is an omission, not an empty string', () => {
        expect(coerce(field({ required: false }), '   ')).toEqual({ omitted: true });
    });

    test('an empty required answer is an error', () => {
        expect(coerce(field(), '').error).toMatch(/required/);
    });
});

describe('collecting a whole form', () => {
    const fields = [
        { name: 'repo', title: 'Repo', kind: 'string', required: true },
        { name: 'draft', title: 'Draft', kind: 'boolean', required: false },
        { name: 'note', title: 'Note', kind: 'string', required: false },
    ];

    test('omits the optional answers nobody filled in', () => {
        const typed = { repo: 'clawdia', draft: '', note: '' };
        expect(collect(fields, name => typed[name])).toEqual({ content: { repo: 'clawdia' } });
    });

    test('and reports the first thing wrong rather than sending a half-form', () => {
        const typed = { repo: 'clawdia', draft: 'perhaps', note: 'x' };
        expect(collect(fields, name => typed[name]).error).toMatch(/yes or no/);
        expect(collect(fields, name => typed[name]).content).toBeUndefined();
    });
});

/**
 * The spec says servers must not use elicitation for secrets, which is a rule
 * for well-behaved servers and no protection from the others. A guild admin
 * connects the server, so its URL is trusted to the extent the admin is — the
 * person answering in a channel is often not that admin.
 */
describe('what the person is shown', () => {
    const { fields } = fieldsOf(schema({
        env: { type: 'string', enum: ['staging', 'production'] },
        force: { type: 'boolean' },
        note: { type: 'string' },
    }, ['env']));
    const text = promptText('u1', 'github', 'Which environment should I deploy to?', fields);

    test('names the server doing the asking', () => {
        expect(text).toContain('github');
    });

    test('and warns about the thing a real server will not ask for', () => {
        expect(text).toMatch(/password|API key|login code/i);
    });

    test('shows the legal answers rather than a blank box', () => {
        expect(text).toContain('staging, production');
        expect(text).toContain('yes or no');
    });

    // The label is the schema's `title` when it gave one and the property name
    // when it did not, which is what these three have.
    test('and marks which answers are optional', () => {
        expect(text).toContain('**note** (optional)');
        expect(text).toContain('**force** (optional)');
        expect(text).not.toContain('**env** (optional)');
    });

    // Nothing the server wrote can ping anybody — the send locks mentions to
    // the asker — but the question is also flattened so it cannot break the
    // message it sits in.
    test('the server\'s question is flattened into the message', () => {
        const nasty = promptText('u1', 'evil', 'line one\n@everyone\n```', fields);
        expect(nasty.split('\n').filter(l => l.startsWith('> '))).toHaveLength(1);
        expect(nasty).not.toContain('```');
    });

    test('and a server that said nothing still gets a readable prompt', () => {
        expect(promptText('u1', 'github', '', fields)).toContain('It did not say what for');
    });
});

/**
 * The channel half. The shape is close to `approval.js` — a message, buttons,
 * an answer routed back to a caller waiting on a promise, a clock — and what
 * differs is that Discord's only way to collect typed data is a modal, which
 * can only be opened from an interaction. So it is two steps, and every way of
 * not getting an answer has to end as one of the spec's three actions rather
 * than as a promise nobody settles: the tool on the far side is holding its
 * request open until this resolves.
 */
const { createElicitationHandler } = require('../src/services/ai/mcp/elicitation');

function fakeMessage() {
    const prompt = {
        content: '',
        edit: jest.fn(async payload => { prompt.content = payload.content; return prompt; }),
        awaitMessageComponent: jest.fn(),
    };
    const sends = [];
    const message = {
        author: { id: 'asker' },
        guild: { id: 'g1' },
        channel: {
            id: 'c1',
            send: jest.fn(async payload => { sends.push(payload); prompt.content = payload.content; return prompt; }),
        },
    };
    return { message, prompt, sends };
}

/** A button click, and the modal submission it goes on to open. */
function click(customId, { userId = 'asker', manageGuild = false, typed = null } = {}) {
    const submission = typed && {
        user: { id: userId },
        fields: { getTextInputValue: name => typed[name] ?? '' },
        deferUpdate: jest.fn(async () => {}),
        reply: jest.fn(async () => {}),
    };
    return {
        customId,
        user: { id: userId },
        memberPermissions: { has: () => manageGuild },
        deferUpdate: jest.fn(async () => {}),
        showModal: jest.fn(async () => {}),
        awaitModalSubmit: jest.fn(async () => {
            if (!submission) throw new Error('never submitted');
            return submission;
        }),
        submission,
    };
}

const ASK = {
    message: 'Which environment?',
    requestedSchema: {
        type: 'object',
        properties: { env: { type: 'string', enum: ['staging', 'production'] }, force: { type: 'boolean' } },
        required: ['env'],
    },
};

let warn;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

describe('putting a question to the channel', () => {
    test('an answered form comes back as accept with the typed content', async () => {
        const { message, prompt } = fakeMessage();
        prompt.awaitMessageComponent.mockResolvedValue(
            click('mcp-elicit-answer', { typed: { env: 'production', force: 'yes' } }),
        );

        const result = await createElicitationHandler(message)('github', ASK, {});

        expect(result).toEqual({ action: 'accept', content: { env: 'production', force: true } });
        expect(prompt.content).toMatch(/Answered by/);
    });

    test('Cancel is a decline, which is the person saying no', async () => {
        const { message, prompt } = fakeMessage();
        prompt.awaitMessageComponent.mockResolvedValue(click('mcp-elicit-decline'));

        await expect(createElicitationHandler(message)('github', ASK, {})).resolves.toEqual({ action: 'decline' });
        expect(prompt.content).toMatch(/Cancelled by/);
    });

    // Not the same thing, and a server may reasonably treat them differently:
    // nobody refused, nobody was there.
    test('silence is a cancel, which is nobody having chosen', async () => {
        const { message, prompt } = fakeMessage();
        prompt.awaitMessageComponent.mockRejectedValue(new Error('time'));

        await expect(createElicitationHandler(message)('github', ASK, {})).resolves.toEqual({ action: 'cancel' });
        expect(prompt.content).toMatch(/Nobody answered/);
    });

    test('and a form opened but never submitted is a cancel too', async () => {
        const { message, prompt } = fakeMessage();
        prompt.awaitMessageComponent.mockResolvedValue(click('mcp-elicit-answer'));

        await expect(createElicitationHandler(message)('github', ASK, {})).resolves.toEqual({ action: 'cancel' });
        expect(prompt.content).toMatch(/not submitted/);
    });

    // One shot at the form: a retry loop is a nicer experience and a worse one
    // for the tool call holding its request open behind it.
    test('an answer that does not fit the schema is declined, not half-sent', async () => {
        const { message, prompt } = fakeMessage();
        const interaction = click('mcp-elicit-answer', { typed: { env: 'dev', force: 'yes' } });
        prompt.awaitMessageComponent.mockResolvedValue(interaction);

        const result = await createElicitationHandler(message)('github', ASK, {});

        expect(result).toEqual({ action: 'decline' });
        expect(interaction.submission.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringMatching(/one of: staging, production/) }),
        );
    });

    // The tool name and the question both come from the server, and this
    // message is posted to a channel by a bot that can mention everyone.
    test('the prompt pings the asker and nobody else', async () => {
        const { message, prompt, sends } = fakeMessage();
        prompt.awaitMessageComponent.mockRejectedValue(new Error('time'));

        await createElicitationHandler(message)('github', ASK, {});

        expect(sends[0].allowedMentions).toEqual({ users: ['asker'] });
    });

    // The buttons go, so a click an hour later cannot land on a request the
    // server stopped waiting for.
    test('and the buttons come off however it ended', async () => {
        const { message, prompt } = fakeMessage();
        prompt.awaitMessageComponent.mockResolvedValue(click('mcp-elicit-decline'));

        await createElicitationHandler(message)('github', ASK, {});

        expect(prompt.edit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    });

    // The clock this pushes out is the one that would otherwise destroy the
    // stream while somebody is still reading the question.
    test('the deadline is moved before the prompt goes up, not after it is answered', async () => {
        const { message, prompt } = fakeMessage();
        const extendDeadline = jest.fn();
        prompt.awaitMessageComponent.mockImplementation(async () => {
            expect(extendDeadline).toHaveBeenCalled();
            expect(message.channel.send).toHaveBeenCalled();
            return click('mcp-elicit-decline');
        });

        await createElicitationHandler(message)('github', ASK, { extendDeadline });

        expect(extendDeadline).toHaveBeenCalledWith(expect.any(Number));
    });

    // A handler with no context at all — the deadline is somebody else's
    // problem, and a missing one must not be a thrown TypeError inside a
    // stream reader.
    test('and a call with no context still works', async () => {
        const { message, prompt } = fakeMessage();
        prompt.awaitMessageComponent.mockResolvedValue(click('mcp-elicit-decline'));

        await expect(createElicitationHandler(message)('github', ASK)).resolves.toEqual({ action: 'decline' });
    });
});

describe('a server that asks too much', () => {
    // An elicitation is a person being interrupted. A server that asks four
    // times in one reply is not collecting an argument, it is running a form —
    // or fishing.
    test('is declined past the per-turn ceiling, without another prompt', async () => {
        const { message, prompt } = fakeMessage();
        prompt.awaitMessageComponent.mockResolvedValue(click('mcp-elicit-decline'));
        const elicit = createElicitationHandler(message);

        for (let i = 0; i < MAX_ELICITATIONS_PER_TURN; i++) {
            await expect(elicit('github', ASK, {})).resolves.toEqual({ action: 'decline' });
        }
        const sentSoFar = message.channel.send.mock.calls.length;

        await expect(elicit('github', ASK, {})).resolves.toEqual({ action: 'decline' });
        expect(message.channel.send).toHaveBeenCalledTimes(sentSoFar);
    });

    // The ceiling counts interruptions to one person, not requests to one
    // server, so a second server cannot start the count again.
    test('and the ceiling counts every server together', async () => {
        const { message, prompt } = fakeMessage();
        prompt.awaitMessageComponent.mockResolvedValue(click('mcp-elicit-decline'));
        const elicit = createElicitationHandler(message);

        for (let i = 0; i < MAX_ELICITATIONS_PER_TURN; i++) await elicit('github', ASK, {});
        const sentSoFar = message.channel.send.mock.calls.length;

        await elicit('linear', ASK, {});
        expect(message.channel.send).toHaveBeenCalledTimes(sentSoFar);
    });

    test('a schema this cannot render never reaches the channel at all', async () => {
        const { message } = fakeMessage();

        const result = await createElicitationHandler(message)(
            'github', { message: 'hi', requestedSchema: { type: 'object', properties: { deep: { type: 'object' } } } }, {},
        );

        expect(result).toEqual({ action: 'decline' });
        expect(message.channel.send).not.toHaveBeenCalled();
    });
});
