'use strict';

// #840: a size for the prompt, and a rule for what goes when it does not fit.
//
// Prompt assembly used to be concatenation with nothing measuring the result:
// `maxHistory` counted messages, a knowledge entry was injected whole however
// long it was, and a guild with a full knowledge base against a small model
// found out from the provider — a 400 from the hosted APIs, or silent
// truncation from Ollama, which answers anyway from whatever half survived.

const {
    estimateTokens,
    contextWindow,
    inputBudget,
    fitPrompt,
    IMAGE_TOKENS,
    MIN_INPUT_TOKENS,
    BACKGROUND_PRIORITY,
    HISTORY_PRIORITY,
    RESOURCE_PRIORITY,
    MATCHED_KNOWLEDGE_PRIORITY
} = require('../src/services/ai/budget');

// Long enough that each piece is worth measuring, short enough to read.
const chars = n => 'x'.repeat(n);
const turn = (role, n) => ({ role, content: chars(n) });

describe('estimating', () => {
    test('is chars over four, rounded up', () => {
        expect(estimateTokens('12345')).toBe(2);
        expect(estimateTokens('')).toBe(0);
        expect(estimateTokens(null)).toBe(0);
    });

    test('knows the windows it has been told about', () => {
        expect(contextWindow('openai', 'gpt-4o-mini')).toBe(128_000);
        expect(contextWindow('anthropic', 'claude-haiku-4-5')).toBe(200_000);
        // The case the module exists for: Ollama serves whatever num_ctx the
        // model was loaded with, and its own default is small.
        expect(contextWindow('ollama', 'llama3.2')).toBe(8_192);
    });

    test('and falls to the provider default for a model it does not', () => {
        expect(contextWindow('openai', 'gpt-9-experimental')).toBe(128_000);
        expect(contextWindow('nonesuch', 'anything')).toBe(128_000);
    });

    test('an OpenRouter-style id is matched on the model half', () => {
        expect(contextWindow('openai', 'openai/gpt-3.5-turbo')).toBe(16_385);
    });
});

describe('the input budget', () => {
    test('leaves the reply room in the same window', () => {
        const window = contextWindow('ollama', 'llama3.2');

        expect(inputBudget({ provider: 'ollama', model: 'llama3.2', maxTokens: 1024 }))
            .toBeLessThan(window - 1024);
    });

    test("honours the guild's own number for a model no table can know", () => {
        expect(inputBudget({ provider: 'ollama', model: 'llama3.2', maxTokens: 1024, contextTokens: 128_000 }))
            .toBeGreaterThan(100_000);
    });

    test('clamps a settings field that says something absurd', () => {
        expect(inputBudget({ provider: 'ollama', model: 'x', contextTokens: 99_000_000 }))
            .toBeLessThanOrEqual(2_000_000);
        expect(inputBudget({ provider: 'ollama', model: 'x', contextTokens: -5 }))
            .toBe(inputBudget({ provider: 'ollama', model: 'x' }));
    });

    test('never returns nothing, however large the reply budget', () => {
        expect(inputBudget({ provider: 'ollama', model: 'llama3.2', maxTokens: 999_999 }))
            .toBe(MIN_INPUT_TOKENS);
    });
});

describe('fitting a prompt that already fits', () => {
    test('changes nothing at all', () => {
        const sections = [
            { id: 'base', text: 'be helpful', required: true },
            { id: 'knowledgeBackground', priority: BACKGROUND_PRIORITY, header: 'H:', joiner: '|', items: ['a', 'b'] }
        ];
        const history = [turn('user', 10), turn('assistant', 10)];

        const fitted = fitPrompt({ sections, history, prompt: 'hello', budget: 10_000 });

        expect(fitted.systemPrompt).toBe('be helpfulH:a|b');
        expect(fitted.history).toHaveLength(2);
        expect(fitted.prompt).toBe('hello');
        expect(fitted.report.historyDropped).toBe(0);
        expect(fitted.report.dropped).toEqual({});
    });
});

describe('what goes first when it does not', () => {
    // One of each droppable thing, all the same size, against a budget that
    // only has room for a couple of them.
    const build = () => ({
        sections: [
            { id: 'base', text: chars(40), required: true },
            { id: 'knowledge', priority: MATCHED_KNOWLEDGE_PRIORITY, header: '', joiner: '', items: [chars(400)] },
            { id: 'knowledgeBackground', priority: BACKGROUND_PRIORITY, header: '', joiner: '', items: [chars(400)] },
            { id: 'mcpResources', priority: RESOURCE_PRIORITY, header: '', joiner: '', items: [chars(400), chars(400)] }
        ],
        history: [turn('user', 400), turn('assistant', 400)],
        prompt: 'what is the plan?'
    });

    test('background knowledge, then history, then resources, then matched knowledge', () => {
        const order = [];
        // Squeeze in stages: each tighter budget forces one more thing out, and
        // the order they leave in is the priority order.
        for (const budget of [550, 400, 250, 100]) {
            const fitted = fitPrompt({ ...build(), budget });
            order.push({
                background: Boolean(fitted.report.dropped.knowledgeBackground),
                history: fitted.report.historyDropped > 0,
                resources: Boolean(fitted.report.dropped.mcpResources),
                matched: Boolean(fitted.report.dropped.knowledge)
            });
        }

        expect(order[0]).toMatchObject({ background: true, history: false, resources: false, matched: false });
        expect(order[1]).toMatchObject({ background: true, history: true, resources: false, matched: false });
        expect(order[2]).toMatchObject({ background: true, history: true, resources: true, matched: false });
        expect(order[3]).toMatchObject({ background: true, history: true, resources: true, matched: true });
    });

    test('the required sections survive everything', () => {
        const fitted = fitPrompt({ ...build(), budget: 20 });

        expect(fitted.systemPrompt).toBe(chars(40));
    });

    test('a section of many documents loses them one at a time, weakest first', () => {
        const sections = [{
            id: 'mcpResources',
            priority: RESOURCE_PRIORITY,
            header: 'DOCS:',
            joiner: '|',
            items: ['best', 'middling', 'weakest']
        }];

        const fitted = fitPrompt({ sections, prompt: '', budget: estimateTokens('DOCS:best|middling') });

        expect(fitted.systemPrompt).toBe('DOCS:best|middling');
        expect(fitted.report.dropped.mcpResources).toBe(1);
    });

    test('a section emptied of items takes its header with it', () => {
        const sections = [{ id: 'mcpResources', priority: RESOURCE_PRIORITY, header: 'DOCS:', joiner: '|', items: ['a'] }];

        const fitted = fitPrompt({ sections, prompt: '', budget: 1 });

        expect(fitted.systemPrompt).toBe('');
    });
});

describe('trimming the conversation', () => {
    test('drops the oldest turns and keeps the newest', () => {
        const history = [turn('user', 400), turn('assistant', 400), { role: 'user', content: 'newest' }];

        const fitted = fitPrompt({ history, prompt: '', budget: 20 });

        expect(fitted.history).toEqual([{ role: 'user', content: 'newest' }]);
        expect(fitted.report.historyDropped).toBe(2);
    });

    // Anthropic rejects a conversation that opens on an assistant message, and
    // every other provider reads one as a non sequitur.
    test('never leaves the conversation opening on an assistant turn', () => {
        const history = [turn('user', 400), turn('assistant', 20), { role: 'user', content: 'newest' }];

        const fitted = fitPrompt({ history, prompt: '', budget: 10 });

        expect(fitted.history[0].role).toBe('user');
    });

    test('the pinned memories and the rolling summary are never trimmed', () => {
        const historyPrefix = [
            { role: 'user', content: '[My saved context]' },
            { role: 'assistant', content: 'Understood.' }
        ];

        const fitted = fitPrompt({
            historyPrefix,
            history: [turn('user', 4000)],
            prompt: '',
            budget: 20
        });

        expect(fitted.history).toEqual(historyPrefix);
        expect(fitted.report.historyDropped).toBe(1);
    });

    test('history is dropped ahead of a document the question pointed at', () => {
        const sections = [{ id: 'mcpResources', priority: RESOURCE_PRIORITY, header: '', joiner: '', items: [chars(200)] }];

        const fitted = fitPrompt({
            sections,
            history: [turn('user', 200)],
            prompt: '',
            budget: estimateTokens(chars(200))
        });

        expect(fitted.report.historyDropped).toBe(1);
        expect(fitted.systemPrompt).toBe(chars(200));
        expect(HISTORY_PRIORITY).toBeLessThan(RESOURCE_PRIORITY);
    });
});

describe('the message itself', () => {
    test('is the last thing cut, and only when nothing else is left', () => {
        const fitted = fitPrompt({
            sections: [{ id: 'knowledgeBackground', priority: BACKGROUND_PRIORITY, header: '', joiner: '', items: [chars(400)] }],
            history: [turn('user', 400)],
            prompt: chars(40_000),
            budget: 600
        });

        expect(fitted.report.promptTruncated).toBe(true);
        expect(fitted.prompt).toContain('[message truncated');
        expect(fitted.prompt.length).toBeLessThan(40_000);
    });

    test('is left alone when the droppable material was enough', () => {
        const fitted = fitPrompt({
            sections: [{ id: 'knowledgeBackground', priority: BACKGROUND_PRIORITY, header: '', joiner: '', items: [chars(4000)] }],
            prompt: 'a short question',
            budget: 100
        });

        expect(fitted.report.promptTruncated).toBe(false);
        expect(fitted.prompt).toBe('a short question');
    });
});

describe('images', () => {
    test('are charged against the same window as the text', () => {
        const withoutImages = fitPrompt({ history: [turn('user', 400)], prompt: '', budget: 200, images: 0 });
        const withImages = fitPrompt({ history: [turn('user', 400)], prompt: '', budget: 200, images: 2 });

        expect(withoutImages.report.historyDropped).toBe(0);
        // Two images cost more than the budget on their own, so the text goes.
        expect(withImages.report.historyDropped).toBe(1);
        expect(withImages.report.estimatedBefore - withoutImages.report.estimatedBefore).toBe(2 * IMAGE_TOKENS);
    });
});

describe("the caller's own arrays", () => {
    test('are not mutated by fitting', () => {
        const items = ['a', 'b'];
        const history = [turn('user', 400), turn('assistant', 400)];

        fitPrompt({
            sections: [{ id: 'knowledgeBackground', priority: BACKGROUND_PRIORITY, header: '', joiner: '', items }],
            history,
            prompt: '',
            budget: 1
        });

        expect(items).toEqual(['a', 'b']);
        expect(history).toHaveLength(2);
    });
});
