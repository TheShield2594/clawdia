'use strict';

/**
 * A size for the prompt, and a rule for what goes when it does not fit (#840).
 *
 * Prompt assembly used to be string concatenation with nothing measuring the
 * result: `maxHistory` counted messages rather than tokens, a knowledge entry
 * was injected whole however long it was, and only MCP tool results had a hard
 * cap. A guild with a full knowledge base and a hundred-message retention
 * window could exceed a small model's context, and what happened next was the
 * provider's choice — an opaque 400 from the hosted APIs, or silent truncation
 * from Ollama, which is worse: the model answers, confidently, having been
 * shown the second half of its instructions.
 *
 * So the prompt is measured before it is sent, and when it is too big the
 * things that go are chosen here rather than by whoever's tokenizer trims from
 * the top. Priority order, cheapest first:
 *
 *   1. knowledge injected as *background* — entries nobody's question matched
 *   2. the oldest turns of the conversation
 *   3. MCP resources, lowest-scoring document first
 *   4. knowledge that did match the question
 *
 * and, only if all of that still leaves it over, the message itself is
 * truncated. Nothing marked `required` is ever dropped: the system prompt, the
 * tool rules and the action rules are what makes the reply behave, and a reply
 * that behaves badly is worse than one that knows less.
 *
 * Estimation is chars/4 — the rule of thumb for English text through a BPE
 * tokenizer. It is not exact and does not need to be: it decides what to drop,
 * and it is paired with a headroom reserve below so that being wrong by a
 * tenth costs nothing. Counting properly would mean a tokenizer per provider,
 * three of which are not shipped as libraries, to answer a question that only
 * has to be roughly right.
 */

const CHARS_PER_TOKEN = 4;

// Roles, message framing, tool schemas, and the slack that a chars/4 estimate
// needs to be allowed to be wrong by.
const HEADROOM_TOKENS = 1024;

// However small the window and however large the reply budget, this much input
// is always allowed through: below it there is no prompt left to send, and a
// misconfigured `maxTokens` should degrade the context rather than empty it.
const MIN_INPUT_TOKENS = 512;

// What one image costs before anybody has typed a word. Providers tile images
// differently — OpenAI bills a 1024×1024 image at roughly 1100 tokens, Anthropic
// at (w×h)/750 — so this is the order of magnitude rather than any one of their
// formulas, and it is deliberately not generous: an image that is cheaper than
// this leaves the budget with slack, which is the safe direction.
const IMAGE_TOKENS = 1500;

// Left on a message the budget had to cut. Counted against the room the message
// is given rather than appended once it has been spent.
const TRUNCATION_MARKER = '\n[message truncated to fit the model\'s context]';

// Model context windows, longest-match-first per provider. Unknown models fall
// to the provider's default, which is the smallest window that provider still
// ships — guessing small costs some knowledge, guessing large costs the reply.
const CONTEXT_WINDOWS = {
    openai: {
        entries: [
            { match: /^(gpt-4\.1|gpt-5)/i, tokens: 1_000_000 },
            { match: /^(o1|o3|o4)/i, tokens: 200_000 },
            { match: /^(gpt-4o|chatgpt-4o|gpt-4-turbo)/i, tokens: 128_000 },
            { match: /^gpt-3\.5/i, tokens: 16_385 },
            { match: /^gpt-4/i, tokens: 8_192 }
        ],
        default: 128_000
    },
    anthropic: {
        entries: [
            { match: /claude-(3|4|5|opus|sonnet|haiku)/i, tokens: 200_000 },
            { match: /claude-2/i, tokens: 100_000 }
        ],
        default: 200_000
    },
    gemini: {
        entries: [
            { match: /1\.5-pro/i, tokens: 2_000_000 },
            { match: /(1\.5-flash|2\.\d|flash|pro)/i, tokens: 1_000_000 }
        ],
        default: 1_000_000
    },
    // Ollama serves whatever `num_ctx` the model was loaded with, and its own
    // default has historically been 4096 — small enough that this is the case
    // the whole module exists for. Nothing here sets num_ctx, so the safe
    // assumption is the server's, and an operator running a 128k model can say
    // so with `ai.contextTokens`.
    ollama: { entries: [], default: 8_192 },
    // Routed to somebody else's model; the id says who but not how big.
    openrouter: { entries: [], default: 128_000 }
};

const DEFAULT_CONTEXT_TOKENS = 128_000;

/** Roughly how many tokens `text` is. See the note above on chars/4. */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

/** The context window this provider and model are assumed to have. */
function contextWindow(provider, model) {
    const table = CONTEXT_WINDOWS[provider];
    if (!table) return DEFAULT_CONTEXT_TOKENS;
    const name = String(model || '');
    // OpenRouter-style `vendor/model` ids match on the model half.
    const bare = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
    const hit = table.entries.find(entry => entry.match.test(bare));
    return hit ? hit.tokens : table.default;
}

/**
 * How many tokens of input this request may send.
 *
 * The reply has to fit in the same window, so `maxTokens` is subtracted rather
 * than assumed to be free — the failure this prevents is a prompt that fits
 * exactly and leaves the model no room to answer.
 *
 * `ai.maxTokens` and `ai.contextTokens` are separate settings validated apart,
 * so nothing stops a guild asking for a 1024-token reply out of a 1024-token
 * window. Subtracting one from the other there leaves nothing, and the floor
 * below would then hand back a budget the window cannot hold — a limit that
 * permits more than the model has. So the reply's *reservation* is capped at
 * half the window, and the returned budget can never exceed what is left after
 * it: the numbers this hands out always fit, whatever the settings say. The
 * request itself will still fail at the provider, which is the right place for
 * an impossible configuration to be refused; what it must not do is fail
 * because this said the prompt would fit.
 *
 * `contextTokens` is the guild's own number, for the operator who knows what
 * their Ollama is loaded with. Clamped, because it is a settings field and a
 * settings field is somebody's input.
 */
function inputBudget({ provider, model, maxTokens = 1024, contextTokens = null }) {
    const configured = Number(contextTokens);
    const window = Number.isFinite(configured) && configured > 0
        ? Math.min(Math.max(Math.floor(configured), 1024), 2_000_000)
        : contextWindow(provider, model);

    const asked = Number.isFinite(Number(maxTokens)) ? Math.max(Number(maxTokens), 0) : 1024;
    const reply = Math.min(asked, Math.floor(window / 2));
    // Scaled for a small window too, for the same reason: a fixed 1024 of
    // overhead against a 1024-token window is the whole of it.
    const headroom = Math.min(HEADROOM_TOKENS, Math.floor(window / 8));

    // `window - reply` is at least half the window, which the schema's own
    // 1024 floor keeps at or above MIN_INPUT_TOKENS — so this is never zero
    // and never negative.
    return Math.min(Math.max(window - reply - headroom, MIN_INPUT_TOKENS), window - reply);
}

/** One section as it will appear in the system prompt, or '' when it is empty. */
function renderSection(section) {
    if (!section.items) return section.text || '';
    if (!section.items.length) return '';
    return (section.header || '') + section.items.join(section.joiner ?? '');
}

function sectionsText(sections) {
    return sections.map(renderSection).filter(Boolean).join('');
}

function messagesTokens(messages) {
    return messages.reduce((sum, m) => sum + estimateTokens(m?.content), 0);
}

/**
 * The removals available, in the order they should be made.
 *
 * Each step takes one thing away — the last item of a section, the oldest
 * message — and they are pre-ordered so the loop below can simply run them
 * until the prompt fits. A section given `items` is dropped a document or an
 * entry at a time, which is why the callers pass their blocks in relevance
 * order: the tail is the least missed.
 */
function removalSteps(sections, history) {
    const steps = [];

    for (const section of sections) {
        if (section.required) continue;
        const priority = section.priority ?? 50;
        if (section.items) {
            for (let i = 0; i < section.items.length; i++) {
                steps.push({ priority, order: i, id: section.id, run: () => { section.items.pop(); } });
            }
        } else if (section.text) {
            steps.push({ priority, order: 0, id: section.id, run: () => { section.text = ''; } });
        }
    }

    // Oldest first. Each step also drops whatever it leaves at the front that
    // is not a user turn: Anthropic rejects a conversation that opens on an
    // assistant message, and every other provider reads one as a non sequitur.
    for (let i = 0; i < history.length; i++) {
        steps.push({
            priority: HISTORY_PRIORITY,
            order: i,
            id: 'history',
            run: () => {
                history.shift();
                while (history.length && history[0].role !== 'user') history.shift();
            }
        });
    }

    return steps.sort((a, b) => a.priority - b.priority || a.order - b.order);
}

// The priority lane the conversation's own turns sit in, between background
// knowledge (which nobody asked for) and fetched documents (which the question
// at least pointed at). Exported so the callers' section priorities can be
// written against it rather than against a number that means nothing.
const BACKGROUND_PRIORITY = 10;
const HISTORY_PRIORITY = 20;
const RESOURCE_PRIORITY = 30;
const MATCHED_KNOWLEDGE_PRIORITY = 40;

/**
 * Fit a prompt to the model's context, dropping in priority order.
 *
 * @param {object[]} sections   system-prompt pieces; `{ id, text }` or
 *                              `{ id, header, items, joiner }`, plus
 *                              `required: true` or a `priority`.
 * @param {object[]} historyPrefix  messages that are never dropped — the
 *                              pinned memories and the rolling summary, which
 *                              are already the compressed form of turns that
 *                              have gone.
 * @param {object[]} history    the conversation, oldest first, trimmable.
 * @param {string}   prompt     what the user just said; truncated only as the
 *                              last resort, because a request without it has
 *                              nothing to answer.
 * @param {number}   images     images riding on this message.
 * @returns {{systemPrompt: string, history: object[], prompt: string, report: object}}
 */
function fitPrompt({
    sections = [],
    historyPrefix = [],
    history = [],
    prompt = '',
    images = 0,
    budget
}) {
    // Copied, because the steps below mutate them and the caller's arrays are
    // used again — the history is written back to storage, the entries are
    // listed as citations.
    const live = sections.map(section => ({
        ...section,
        items: section.items ? [...section.items] : null
    }));
    const trimmable = [...history];

    const imageCost = Math.max(0, images) * IMAGE_TOKENS;
    const fixed = messagesTokens(historyPrefix) + imageCost;
    let promptText = prompt;

    const total = () => fixed + estimateTokens(sectionsText(live))
        + messagesTokens(trimmable) + estimateTokens(promptText);

    const before = total();
    const dropped = {};
    let historyDropped = 0;

    if (before > budget) {
        for (const step of removalSteps(live, trimmable)) {
            if (total() <= budget) break;
            const had = trimmable.length;
            step.run();
            if (step.id === 'history') historyDropped += had - trimmable.length;
            else dropped[step.id] = (dropped[step.id] || 0) + 1;
        }
    }

    // Everything droppable is gone and it still does not fit, so the message
    // itself is cut. Only reachable for a genuinely enormous message against a
    // tiny window, and a truncated question the model can see beats a request
    // the provider refuses.
    //
    // The marker is part of what gets sent, so it comes out of the room the
    // message has rather than being added on top of it — appending it after
    // slicing to the full budget put the result back over the line it had just
    // been cut to.
    let promptTruncated = false;
    if (total() > budget) {
        const room = budget - (total() - estimateTokens(promptText)) - estimateTokens(TRUNCATION_MARKER);
        const chars = room * CHARS_PER_TOKEN;
        if (room > 0 && promptText.length > chars) {
            promptText = promptText.slice(0, chars) + TRUNCATION_MARKER;
            promptTruncated = true;
        }
    }

    // What is left after everything droppable has gone. It can still be over
    // budget, and only two things get it there: the sections nothing may drop,
    // and the fixed costs — the pinned memories, the rolling summary, the
    // images. A guild can arrange all three larger than its model's window, and
    // the honest answer then is that this request cannot be sent, not a prompt
    // handed to the provider in the hope it disagrees. `fits` is that answer;
    // the caller says so in the channel rather than spending the call.
    const estimatedAfter = total();

    return {
        systemPrompt: sectionsText(live),
        history: [...historyPrefix, ...trimmable],
        prompt: promptText,
        report: {
            budget,
            estimatedBefore: before,
            estimatedAfter,
            fits: estimatedAfter <= budget,
            // What of the overflow is not this module's to trim, so the caller
            // can say which knob the person on the other end has to turn.
            fixedTokens: fixed,
            dropped,
            historyDropped,
            promptTruncated
        }
    };
}

module.exports = {
    estimateTokens,
    contextWindow,
    inputBudget,
    fitPrompt,
    CHARS_PER_TOKEN,
    HEADROOM_TOKENS,
    MIN_INPUT_TOKENS,
    IMAGE_TOKENS,
    BACKGROUND_PRIORITY,
    HISTORY_PRIORITY,
    RESOURCE_PRIORITY,
    MATCHED_KNOWLEDGE_PRIORITY
};
