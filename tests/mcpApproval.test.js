'use strict';

// The buttons a channel sees before a tool that writes something runs.
//
// Two things here are worth pinning hard. One is that every way of not getting
// a yes — Cancel, silence, a channel the bot lost — ends up as "not approved",
// because the whole point is that the tool does not run unless somebody said it
// could. The other is that nothing in the prompt can ping: the tool name comes
// from the server and the arguments come from the model, and this message is
// posted to a channel by a bot that can mention everyone.

const {
    createToolConfirmer,
    renderArgs,
    argsAttachment,
    MAX_ARGS_CHARS,
    ARGS_FILE_NAME
} = require('../src/services/ai/mcp/approval');

const APPROVE = 'mcp-approve';
const DENY = 'mcp-deny';

function fakeMessage() {
    const prompt = {
        content: '',
        edit: jest.fn(async payload => { prompt.content = payload.content; return prompt; }),
        awaitMessageComponent: jest.fn()
    };
    const sends = [];
    const message = {
        author: { id: 'asker' },
        guild: { id: 'g1' },
        channel: {
            id: 'c1',
            send: jest.fn(async payload => { sends.push(payload); prompt.content = payload.content; return prompt; })
        }
    };
    return { message, prompt, sends };
}

// A click, as awaitMessageComponent resolves it.
function click(customId, { userId = 'asker', manageGuild = false } = {}) {
    return {
        customId,
        user: { id: userId },
        memberPermissions: { has: () => manageGuild },
        update: jest.fn(async () => {}),
        reply: jest.fn(async () => {})
    };
}

const CALL = { server: 'github', tool: 'create_issue', name: 'github__create_issue', args: { title: 'bug' } };

describe('the answer', () => {
    test('is approval when somebody clicks Run it', async () => {
        const { message, prompt } = fakeMessage();
        const clicked = click(APPROVE);
        prompt.awaitMessageComponent.mockResolvedValue(clicked);

        expect(await createToolConfirmer(message)(CALL)).toEqual({ approved: true });
        // The buttons come off, so the record in the channel says what happened
        // rather than still offering a choice that is no longer live.
        expect(clicked.update).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
        expect(clicked.update.mock.calls[0][0].content).toContain('Approved');
    });

    test('is refusal when somebody clicks Cancel', async () => {
        const { message, prompt } = fakeMessage();
        const clicked = click(DENY);
        prompt.awaitMessageComponent.mockResolvedValue(clicked);

        expect(await createToolConfirmer(message)(CALL)).toEqual({ approved: false });
        expect(clicked.update.mock.calls[0][0].content).toContain('Cancelled');
    });

    test('is refusal, marked as such, when nobody answers', async () => {
        const { message, prompt } = fakeMessage();
        prompt.awaitMessageComponent.mockRejectedValue(new Error('time'));

        expect(await createToolConfirmer(message)(CALL)).toEqual({ approved: false, timedOut: true });
        // The buttons are taken away, so a click an hour later cannot land on a
        // turn that is long over.
        expect(prompt.edit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
        expect(prompt.edit.mock.calls[0][0].content).toContain('Nobody answered');
    });

    test('carries the timeout the caller asked for', async () => {
        const { message, prompt } = fakeMessage();
        prompt.awaitMessageComponent.mockResolvedValue(click(APPROVE));

        await createToolConfirmer(message, { timeoutMs: 1234 })(CALL);
        expect(prompt.awaitMessageComponent.mock.calls[0][0].time).toBe(1234);
    });
});

describe('who may answer', () => {
    const filterFor = async () => {
        const { message, prompt } = fakeMessage();
        prompt.awaitMessageComponent.mockResolvedValue(click(APPROVE));
        await createToolConfirmer(message)(CALL);
        return prompt.awaitMessageComponent.mock.calls[0][0].filter;
    };

    test('the person who asked', async () => {
        expect((await filterFor())(click(APPROVE, { userId: 'asker' }))).toBe(true);
    });

    test('anyone who can manage the server', async () => {
        // They could have configured the connection in the first place.
        expect((await filterFor())(click(APPROVE, { userId: 'mod', manageGuild: true }))).toBe(true);
    });

    test('nobody else — and they are told so rather than left hanging', async () => {
        const passer = click(APPROVE, { userId: 'passer-by' });
        expect((await filterFor())(passer)).toBe(false);
        // A filter that returns false without replying leaves Discord showing
        // "This interaction failed" three seconds later.
        expect(passer.reply).toHaveBeenCalled();
    });

    test('and a click on some other component is ignored in silence', async () => {
        const unrelated = click('poll-vote-1', { userId: 'passer-by' });
        expect((await filterFor())(unrelated)).toBe(false);
        expect(unrelated.reply).not.toHaveBeenCalled();
    });
});

describe('what the prompt says', () => {
    const promptFor = async (call, message) => {
        const fake = message || fakeMessage();
        fake.prompt.awaitMessageComponent.mockResolvedValue(click(APPROVE));
        await createToolConfirmer(fake.message)(call);
        return fake.sends[0];
    };

    test('names the server, the tool and the arguments', async () => {
        const sent = await promptFor(CALL);
        expect(sent.content).toContain('github');
        expect(sent.content).toContain('create_issue');
        expect(sent.content).toContain('bug');
    });

    test('pings the person being waited on, and nobody else', async () => {
        const sent = await promptFor(CALL);
        expect(sent.allowedMentions).toEqual({ users: ['asker'] });
    });

    test('strips a tool name that was chosen to look like a ping', async () => {
        const sent = await promptFor({ server: 'github', tool: '@everyone', args: {} });
        expect(sent.content).toContain('github · everyone');
        expect(sent.content).not.toContain('@everyone');
    });

    test('shows an argument as written but cannot be made to ping by it', async () => {
        // The arguments are what a person is being asked to approve, so
        // rewriting them would be lying about the call. allowedMentions is what
        // makes that safe: it names the one user this message may notify,
        // whatever the model put in the text.
        const sent = await promptFor({
            server: 'github',
            tool: 'create_issue',
            args: { body: '@everyone @here <@&1234>' }
        });

        expect(sent.content).toContain('@everyone @here');
        expect(sent.allowedMentions).toEqual({ users: ['asker'] });
    });

    test('repeats what the server said the tool does, when it said anything', async () => {
        const sent = await promptFor({ ...CALL, annotations: { title: 'File a bug report' } });
        expect(sent.content).toContain('File a bug report');
    });

    test('says it is destructive when that is all the server offered', async () => {
        const sent = await promptFor({ ...CALL, annotations: { readOnlyHint: false, destructiveHint: true } });
        expect(sent.content).toMatch(/destructive/i);
    });
});

describe('rendering the arguments', () => {
    test('shows them as a readable block', () => {
        expect(renderArgs({ q: 'clawdia' })).toContain('"q"');
        expect(renderArgs({ q: 'clawdia' })).toContain('```json');
    });

    test('adds nothing for a tool that takes none', () => {
        expect(renderArgs({})).toBe('');
        expect(renderArgs(null)).toBe('');
    });

    test('neutralises a backtick that would break out of the block', () => {
        const rendered = renderArgs({ note: '``` @everyone' });
        expect(rendered.split('```')).toHaveLength(3);
    });

    test('truncates arguments too big to read', () => {
        const rendered = renderArgs({ blob: 'x'.repeat(5000) });
        expect(rendered.length).toBeLessThan(700);
        expect(rendered).toContain('truncated');
    });

    test('says how much of the payload it is not showing', () => {
        // "Truncated" alone says the preview stops, not that somebody is being
        // asked to approve four thousand bytes they have not read — which is
        // where a payload with something to hide would put it.
        const rendered = renderArgs({ blob: 'x'.repeat(5000) });
        const [, hidden, total] = rendered.match(/truncated — (\d+) of (\d+) bytes not shown/);

        expect(Number(total)).toBeGreaterThan(5000);
        expect(Number(hidden)).toBe(Number(total) - MAX_ARGS_CHARS);
    });

    test('counts what an emoji actually costs, not what it looks like', () => {
        // The size limit on the attachment is in bytes, and for a payload that
        // is not ASCII the two are nowhere near the same number: saying
        // "5000 characters" of something three times that size understates the
        // part going unread.
        const rendered = renderArgs({ blob: '🎉'.repeat(2000) });
        const [, , total] = rendered.match(/truncated — (\d+) of (\d+) bytes not shown/);

        // Four bytes each, not the two UTF-16 units the string reports.
        expect(Number(total)).toBeGreaterThan(8000);
    });

    test('never cuts an emoji in half at the boundary', () => {
        // A lone surrogate renders as a replacement character sitting in the
        // middle of the payload somebody is being asked to read.
        for (let pad = 480; pad < 510; pad++) {
            const rendered = renderArgs({ n: 'a'.repeat(pad) + '🎉' + 'b'.repeat(50) });
            expect(rendered).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
            expect(rendered).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        }
    });
});

describe('the part the preview leaves out', () => {
    test('goes up beside the buttons as a file', () => {
        const file = argsAttachment({ body: 'y'.repeat(5000) });

        expect(file.name).toBe(ARGS_FILE_NAME);
        // The payload as the tool would receive it, not the fenced preview.
        expect(JSON.parse(file.attachment.toString('utf8'))).toEqual({ body: 'y'.repeat(5000) });
    });

    test('is nothing at all when the preview was the whole thing', () => {
        expect(argsAttachment({ q: 'clawdia' })).toBeNull();
        expect(argsAttachment({})).toBeNull();
        expect(argsAttachment(null)).toBeNull();
    });

    test('is left to the preview\'s own count when it is too big to post', () => {
        expect(argsAttachment({ blob: 'z'.repeat(2 * 1024 * 1024) })).toBeNull();
    });

    test('reaches the channel with the prompt that asks about it', async () => {
        const fake = fakeMessage();
        fake.prompt.awaitMessageComponent.mockResolvedValue(click(APPROVE));

        await createToolConfirmer(fake.message)({ ...CALL, args: { body: 'y'.repeat(5000) } });
        const [sent] = fake.sends;

        expect(sent.files).toHaveLength(1);
        expect(sent.files[0].name).toBe(ARGS_FILE_NAME);
        // And the message says the file is there, so a partial approval is at
        // least a knowing one.
        expect(sent.content).toContain(ARGS_FILE_NAME);
    });

    test('is not attached to a call whose arguments fit', async () => {
        const fake = fakeMessage();
        fake.prompt.awaitMessageComponent.mockResolvedValue(click(APPROVE));

        await createToolConfirmer(fake.message)(CALL);
        expect(fake.sends[0].files).toEqual([]);
    });

    test('drops arguments that cannot be serialised at all', () => {
        const circular = { name: 'x' };
        circular.self = circular;
        expect(renderArgs(circular)).toBe('');
    });
});
