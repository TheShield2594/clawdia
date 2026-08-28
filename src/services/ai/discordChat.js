const User = require('../../models/User');
const { resolveMcpServers } = require('../../config/mcpServers');
const { providers, mcpMode, usesClientTools, supportsVision } = require('./providers');
const { resolveProviderConfig, streamCompletion, getCompletion } = require('./index');
const { retrieveKnowledge, knowledgeSection } = require('./knowledge');
const { collectImages, loadImages, visionNotice } = require('./vision');
const {
    fitPrompt,
    inputBudget,
    BACKGROUND_PRIORITY,
    RESOURCE_PRIORITY,
    MATCHED_KNOWLEDGE_PRIORITY
} = require('./budget');
const { loadHistory, appendHistory, clearHistory } = require('./history');
const { createSummarizer, summaryContext } = require('./summarize');
const { peekRateLimit, peekChannelRateLimit, userRateLimitKey } = require('./rateLimit');
const { buildActionsAddendum, buildToolActionsAddendum, extractAction, executeAction } = require('./actions');
const { buildBotTools, BOT_SERVER } = require('./botTools');
const { buildMcpAddendum } = require('./mcp/prompt');
const { retrieveMcpKnowledge } = require('./mcp/resources');
const { createToolActivity, STATUS_RESERVE } = require('./mcp/activity');
const { createToolConfirmer } = require('./mcp/approval');
const { createElicitationHandler } = require('./mcp/elicitation');
const { recordToolCalls } = require('./mcp/usage');

// Discord transport for the AI chat loop: rate limiting, prompt assembly,
// message streaming/chunking, and post-processing. Everything provider-shaped
// lives behind streamCompletion/getCompletion.

const DISCORD_MAX_LEN = 2000;
const STREAM_EDIT_INTERVAL_MS = 800;
// Discord typing indicator expires after 10s — refresh every 8s during long generations
const TYPING_REFRESH_INTERVAL_MS = 8000;
// A tool round yields no text, so the edit loop below is parked on the provider
// for the whole of it. The tool status needs its own clock or it would only
// ever appear after the tool it is announcing had already finished.
const STATUS_REFRESH_INTERVAL_MS = 1200;
// How long a flush waits for a repaint already in flight, and how often it
// looks. One Discord edit is a fraction of this; the ceiling is only here so a
// request that never returns cannot hold the reply open.
const PAINT_LOCK_WAIT_MS = 2000;
const PAINT_LOCK_TICK_MS = 25;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Nothing this transport sends is allowed to ping anybody.
 *
 * Every message it posts is assembled from text the bot did not write: the
 * model's own output, an MCP server's progress note, a tool result, the title
 * of a knowledge entry. A model can be talked into typing `@everyone`, and a
 * server can call a tool it — and either one arriving in Discord as a live
 * mention is this bot pinging a server on a stranger's say-so.
 *
 * `utils/toolLabel.js` strips what it can from the names it handles, and says
 * in as many words that it is belt rather than braces. This is the braces, and
 * it belongs on the send: it is the one place that covers the model's text as
 * well, which is the larger surface and was never covered at all.
 *
 * `repliedUser` keeps the single mention this transport actually means — a
 * reply notifies the person who asked, the way it always has. Specifying
 * `allowedMentions` at all turns that default off, so it is asked for back.
 */
const NO_MENTIONS = { parse: [] };
const REPLY_MENTIONS = { parse: [], repliedUser: true };

// Discord takes a bare string or a payload object. These take either and always
// hand back a payload carrying the policy, so a call site cannot post without
// one by writing the shorter form.
function withMentionPolicy(content, allowedMentions) {
    return typeof content === 'string'
        ? { content, allowedMentions }
        : { allowedMentions, ...content };
}

const reply = (message, content) => message.reply(withMentionPolicy(content, REPLY_MENTIONS));
const send = (channel, content) => channel.send(withMentionPolicy(content, NO_MENTIONS));
const edit = (msg, content) => msg.edit(withMentionPolicy(content, NO_MENTIONS));

/**
 * Run `fn`, retrying it for the failures that a second attempt can fix.
 *
 * `canRetry` is asked after each failure and before each retry, for the
 * failures a second attempt should not be made for even though the error looks
 * transient — see the call sites, where it is what stops a turn re-running
 * tools it has already run.
 */
async function withRetry(fn, { retries = 2, baseDelayMs = 800, canRetry = () => true } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const status = err?.status || err?.response?.status;
            // A rate-limited call is refused before the provider is touched, so
            // retrying it only burns more of the same budget and cannot succeed
            // inside the window. It has no HTTP status, which the check below
            // would otherwise read as a transient network failure.
            if (err?.rateLimited) throw err;
            const retryable = !status || status === 408 || status === 429 || status >= 500;
            if (!retryable || i === retries || !canRetry()) throw err;
            await sleep(baseDelayMs * Math.pow(2, i));
        }
    }
    throw lastErr;
}

/**
 * Leave the tool summary on the finished reply.
 *
 * Appended to the last message rather than sent as its own, so a reply that
 * used a tool stays one message in the channel instead of two. It becomes a
 * separate message only when there is no room for it, or nothing to append it
 * to — a turn that called tools and then produced no text at all.
 */
async function attachToolFooter(msg, text, footer, channel) {
    if (!footer) return;
    const body = (text || '').trimEnd();
    if (msg && body.length + footer.length + 1 <= DISCORD_MAX_LEN) {
        const edited = await edit(msg, body ? `${body}\n${footer}` : footer).then(() => true).catch(() => false);
        if (edited) return;
    }
    await send(channel, footer).catch(() => {});
}

// Where to cut `text` for a piece of at most `size`: the last newline in
// range, else the last space, else a hard cut. One preference order for every
// split — the streamed overflow below goes through chunkText too, so it no
// longer slices mid-word or mid-code-fence at exactly the limit (#825).
function splitIndex(text, size) {
    if (text.length <= size) return text.length;
    let cut = text.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = text.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    return cut;
}

function chunkText(text, size = DISCORD_MAX_LEN) {
    if (text.length <= size) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > size) {
        const cut = splitIndex(remaining, size);
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

/**
 * `promptContent` is the message text with the bot's own mention tokens already
 * removed (src/events/messageCreate.js). Everything here that reads what the
 * user actually said — the `!reset` match, knowledge retrieval, the prompt sent
 * to the provider, the history entry — reads it rather than `message.content`,
 * which on a mention-triggered message still carries the raw `<@id>` token
 * (#820). Callers that have no stripped form to hand fall back to the raw
 * content, which is the right answer for the reply-to-bot trigger.
 */
async function handleAIChat(message, aiSettings, promptContent) {
    const { provider, model, temperature, maxTokens, contextTokens, apiKey, baseUrl, mcpServers, mcpConfirm, mcpRoute, rateLimit } = resolveProviderConfig(aiSettings);
    const providerDef = providers.get(provider);
    const providerLabel = providerDef?.label || provider;

    if (provider !== 'ollama' && !apiKey) {
        return reply(message, `${providerLabel} is not configured. Add an API key in the dashboard.`);
    }

    const modelError = providerDef?.validateModel?.(model);
    if (modelError) {
        return reply(message, modelError);
    }

    const content = (promptContent ?? message.content).trim();
    if (content.toLowerCase() === '!reset') {
        await clearHistory(message.guild.id, message.channel.id, message.author.id);
        return reply(message, 'Conversation history cleared.');
    }

    // What the message carries besides words (#839). Collected here — it is a
    // read of `message.attachments` and nothing more — because whether there is
    // a picture decides the question below, and whether it is worth
    // downloading is decided later, once the model is known to be able to see.
    const attached = collectImages(message);
    const canSee = supportsVision(provider, model);

    // A bare `@Clawdia` is all mention and no question. Before the token was
    // stripped this reached the provider as the literal `<@id>`; now it would
    // reach it as an empty prompt, which some providers reject outright. A
    // message with no text but a screenshot on it is a question, though — it is
    // how most people ask "what is this?" — so only a message with neither has
    // nothing in it to answer.
    if (!content && !attached.images.length) {
        return reply(message, 'You mentioned me but did not ask anything — what can I help with?');
    }

    // Something still has to arrive as the user's turn when the user typed
    // nothing at all. This says what happened rather than inventing a question
    // on their behalf, and it is what goes into the history too, so the next
    // message's context reads the way this one did.
    const promptText = content || '[The user sent this attachment with no message text.]';

    // A peek, not a consuming check: the slot is spent inside getCompletion /
    // streamCompletion, which is what actually bounds provider spend. This is
    // only here to refuse before the history load, knowledge retrieval and
    // prompt assembly below, and to say so in the channel where the user asked.
    // The same key enforcement will consume, so the peek and the spend agree.
    if (!peekRateLimit(userRateLimitKey(message.guild.id, message.author.id), rateLimit.perUser, rateLimit.windowMin)) {
        return reply(message, `Rate limit reached (${rateLimit.perUser} per ${rateLimit.windowMin}m). Please slow down.`);
    }

    if (!peekChannelRateLimit(message.channel.id, rateLimit.perChannel, rateLimit.windowMin)) {
        return reply(message, `This channel has reached the AI request limit. Please wait before sending more AI requests here.`);
    }

    const maxHistory = aiSettings.maxHistory ?? 20;
    const useStreaming = aiSettings.streaming !== false;

    // The streaming path posts this "…" before the first chunk arrives, so an
    // error after that point has to land *in* it. Left alone it stays in the
    // channel as a permanent ellipsis next to a separate error message.
    let placeholder = null;

    // The system prompt as labelled pieces rather than one string (#840).
    //
    // Base + knowledge + tool rules + action rules + fetched documents, each
    // saying whether it may be dropped and how readily, so that a prompt too
    // big for the model loses the least valuable part of itself instead of
    // whatever the far end's tokenizer happens to cut off. `required` is what
    // makes the reply behave — the persona and the tool rules — and is never
    // dropped; see budget.js for the order the rest goes in.
    const sections = [{
        id: 'base',
        text: aiSettings.systemPrompt || 'You are a helpful Discord bot assistant.',
        required: true
    }];

    const userDoc = await User.findOne({ userId: message.author.id, guildId: message.guild.id }).lean();
    const pinnedMemories = userDoc?.pinnedMemories?.length ? userDoc.pinnedMemories : null;

    // Two tiers now, not one mode (#840): what the question actually retrieved,
    // which the reply may cite, and the always-on background tier, which it may
    // not. They are separate sections because they are worth different amounts
    // — background is the first thing dropped when the prompt does not fit, and
    // a matched entry is nearly the last.
    const kb = await retrieveKnowledge(message.guild.id, content);
    const kbMatched = kb.matched ?? (kb.isBackground ? [] : kb.entries || []);
    const kbBackground = kb.background ?? (kb.isBackground ? kb.entries || [] : []);
    if (kbMatched.length) {
        sections.push({ id: 'knowledge', priority: MATCHED_KNOWLEDGE_PRIORITY, ...knowledgeSection(kbMatched) });
    }
    if (kbBackground.length) {
        sections.push({
            id: 'knowledgeBackground',
            priority: BACKGROUND_PRIORITY,
            ...knowledgeSection(kbBackground, { background: true })
        });
    }
    // Every provider can reach MCP servers now — Anthropic through its own
    // connector, the rest through the bot's MCP client — so this only asks
    // whether the provider supports them at all and whether any resolve after
    // the config file and the guild's list are merged.
    const mcpActive = Boolean(mcpMode(provider)) && resolveMcpServers(mcpServers).length > 0;

    // Deliberately not inside the actions branch. This rule used to ride on it,
    // which meant a guild running MCP with actions off was told nothing at all
    // about where tool results come from — and that guild still has a model
    // that can be talked into calling another tool.
    // The in-channel actions, as tools rather than as a line of text the model
    // appends to its reply (#832). Which of the two the model is offered comes
    // down to whether this request runs the bot's own tool loop: every provider
    // but Anthropic always does, and Anthropic does unless it is taking its own
    // MCP connector, where the bot never sees a call to attach a tool to.
    const botTools = buildBotTools(message, { enabled: Boolean(aiSettings.actionsEnabled) });
    const toolActions = botTools.length > 0
        && usesClientTools(provider, { mcpRoute, mcpConfirm, mcpServers, botTools });

    if (mcpActive) {
        // The ACTION sentence only belongs in the MCP rule while there is an
        // ACTION block to be talked into emitting; the tool route's own addendum
        // carries the same rule in the vocabulary it uses.
        sections.push({
            id: 'mcpRules',
            required: true,
            text: buildMcpAddendum({ actionsEnabled: Boolean(aiSettings.actionsEnabled) && !toolActions })
        });
    }
    if (toolActions) {
        sections.push({ id: 'actionRules', required: true, text: buildToolActionsAddendum(userDoc?.timezone) });
    } else if (aiSettings.actionsEnabled) {
        sections.push({ id: 'actionRules', required: true, text: buildActionsAddendum(userDoc?.timezone) });
    }

    try {
        await message.channel.sendTyping();

        // The bytes behind the attachments, now that the model is known to be
        // able to use them (#839). Started here rather than awaited here: it
        // and the resource retrieval below are independent round trips on the
        // same critical path, and somebody is watching a typing indicator for
        // the sum of everything on it.
        const visionPending = loadImages(attached, { supported: canSee });

        // The other knowledge base: documents published by an MCP server the
        // guild switched resources on for, fetched now rather than pasted into
        // the dashboard a month ago. Behind sendTyping because it is a network
        // round trip on the way to an answer somebody is waiting for, and
        // best-effort because a docs server being down is a reason to answer
        // without it rather than not to answer.
        const mcpKnowledge = await retrieveMcpKnowledge(mcpServers, content)
            .catch(err => {
                console.warn(`[MCP] resource retrieval failed: ${err.message}`);
                return null;
            });
        if (mcpKnowledge) {
            // Its items are in score order, so what the budget drops first is
            // the document that looked least like an answer.
            sections.push({
                id: 'mcpResources',
                priority: RESOURCE_PRIORITY,
                ...(mcpKnowledge.section || { header: mcpKnowledge.text, joiner: '', items: [''] })
            });
        }

        const { messages: rawHistory, summary } = await loadHistory(
            message.guild.id, message.channel.id, message.author.id, maxHistory
        );

        // Prepend pinned memories as a user-context message so the model treats
        // them as reference information, not authoritative system instructions.
        // The rolling summary of turns that have fallen out of the retention
        // window (#833) rides in the same way, and after the memories: it is
        // the older material of the two, so it reads in the order it happened.
        //
        // Neither is trimmable by the budget below, which is why they are held
        // apart from the turns themselves: the memories are the user's own
        // standing context, and the summary is already the compressed form of
        // everything the window has dropped. Spending either to keep one more
        // recent turn would be exactly backwards.
        const historyPrefix = [
            ...(pinnedMemories
                ? [
                    { role: 'user', content: `[My saved context for this conversation]\n${pinnedMemories.map(m => `- ${m.content}`).join('\n')}` },
                    { role: 'assistant', content: 'Understood, I have noted your saved context.' }
                  ]
                : []),
            ...summaryContext(summary)
        ];

        const vision = await visionPending;
        if (vision.skipped || vision.unsupported) {
            // A model told nothing about an image it cannot see will answer the
            // question anyway, from the text and its imagination.
            sections.push({ id: 'visionNotice', required: true, text: visionNotice(vision) });
        }

        // Everything assembled is now measured against what the model can
        // actually hold, and trimmed in priority order if it does not fit
        // (#840). Before this, a large knowledge base and a long retention
        // window could exceed a small model's context and fail as an opaque
        // 400 — or, on Ollama, silently, with the model answering from whatever
        // half of the prompt survived.
        const fitted = fitPrompt({
            sections,
            historyPrefix,
            history: rawHistory,
            prompt: promptText,
            images: vision.images.length,
            budget: inputBudget({ provider, model, maxTokens, contextTokens })
        });
        const { report } = fitted;
        if (report.estimatedBefore > report.budget) {
            console.warn(`[AI:${provider}] prompt was ~${report.estimatedBefore} tokens against a ${report.budget} budget for `
                + `${model}; trimmed to ~${report.estimatedAfter} (dropped ${JSON.stringify(report.dropped)}, `
                + `${report.historyDropped} history message(s)${report.promptTruncated ? ', message truncated' : ''}).`);
        }

        // Everything trimmable is gone and it still does not fit. What is left
        // is what nobody here may drop — the system prompt and the tool rules —
        // plus the fixed costs: the pinned memories, the rolling summary, the
        // images. Sending it anyway is a request that has already failed: a 400
        // from the hosted APIs, or Ollama quietly cutting the instructions and
        // answering as somebody else. So it is refused here, where the refusal
        // can name the knob to turn, rather than spent for a reply nobody can
        // use.
        if (!report.fits) {
            console.warn(`[AI:${provider}] ~${report.estimatedAfter} tokens will not fit ${model}'s `
                + `${report.budget}-token budget with nothing left to trim (~${report.fixedTokens} of it fixed).`);
            return reply(message, `That does not fit in ${providerLabel}'s context window for \`${model}\``
                + `${vision.images.length ? ' along with the attached image(s)' : ''}. `
                + 'Try sending fewer images, clearing saved context with `/ai memories`, or ask an admin to '
                + 'shorten the system prompt or raise the model context window in the dashboard.');
        }

        const usageOut = {};
        // Collects what the MCP tools did across every round of this turn, so
        // the reply can say what the bot is waiting on while it waits, and what
        // it used once it is done.
        const activity = createToolActivity();
        const callArgs = {
            provider, model, apiKey, baseUrl,
            systemPrompt: fitted.systemPrompt, history: fitted.history, prompt: fitted.prompt,
            // The provider filters these again against its own model list, so
            // an image can never reach a model that would refuse it.
            images: vision.images,
            temperature, maxTokens, mcpServers,
            guildId: message.guild.id, usageOut, onToolEvent: activity.onEvent,
            // The guild's policy, and the buttons that answer it. The toolkit
            // holds the call until this resolves, so a tool that writes
            // something does not run until somebody in the channel says so.
            mcpConfirm, mcpRoute, confirmTool: createToolConfirmer(message),
            // And the question a server may ask back (#838). Same channel, same
            // rule about who may answer — the difference is that this one
            // carries data, and the tool on the far side is holding its request
            // open until it arrives.
            elicit: createElicitationHandler(message),
            // The bot's own tools ride the same loop as the servers' — same
            // approval prompt, same activity footer, same result budget.
            botTools: toolActions ? botTools : [],
            // Who the request is for, so the limit is enforced where the spend
            // happens rather than only in the peek above.
            rateLimit, userId: message.author.id, channelId: message.channel.id
        };

        let fullResponse = '';

        if (useStreaming) {
            placeholder = await reply(message, '…');
            let lastEdit = 0;
            let currentMsg = placeholder;
            let currentBuf = '';
            const sentMessages = [placeholder]; // all Discord messages emitted during streaming

            // What was last written to currentMsg. Two things repaint it now —
            // a text delta and the status clock — and neither should spend an
            // edit on text Discord already has.
            let painted = null;
            let painting = false;

            /**
             * Write the text so far, plus any live tool status, to the message.
             *
             * Serialised through `painting` because those two callers can
             * collide: Discord applies whichever edit *lands* last, not
             * whichever was issued last, so two in flight can leave the older
             * text on screen.
             */
            const paint = async () => {
                if (painting) return;
                const text = activity.decorate(currentBuf) || '…';
                if (text === painted) return;
                painting = true;
                painted = text;
                try {
                    await edit(currentMsg, text);
                } catch {
                    // Let the next paint try again rather than believing this landed.
                    painted = null;
                } finally {
                    painting = false;
                }
            };

            /**
             * Wait for a repaint already in flight to land.
             *
             * `paint` skips when the flag is set, which keeps the clock out of
             * a flush — but not the other way round: a flush starting while
             * paint is mid-edit would still write to the same message
             * concurrently, and Discord applies whichever edit *lands* last.
             * Bounded, because the worst case of giving up is the race this
             * exists to narrow, and the worst case of waiting forever is a
             * reply that never finishes.
             */
            const untilPaintIdle = async () => {
                for (let waited = 0; painting && waited < PAINT_LOCK_WAIT_MS; waited += PAINT_LOCK_TICK_MS) {
                    await sleep(PAINT_LOCK_TICK_MS);
                }
            };

            const statusInterval = setInterval(() => { paint(); }, STATUS_REFRESH_INTERVAL_MS);
            // Keep the typing indicator alive for long generations
            const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), TYPING_REFRESH_INTERVAL_MS);

            try {
                // The retry below is for a provider that dropped the stream, and
                // it re-enters the whole turn — which means re-running every
                // tool the failed attempt already ran. That was fine when MCP
                // was read-mostly and is not now: a turn that filed an issue,
                // then lost the stream to a 500, would file a second one and
                // ask somebody to approve it again. So a turn that has touched
                // a tool does not get retried; the user gets the error instead,
                // which is the smaller loss.
                await withRetry(async () => {
                    fullResponse = '';
                    currentBuf = '';
                    // Nothing has run yet on this attempt — and if a previous
                    // one got as far as a tool, canRetry below stopped us
                    // getting here at all.
                    activity.reset();
                    // A previous attempt may have overflowed into extra
                    // messages. This attempt paints from the placeholder
                    // alone — left in place, attempt 2 would write into the
                    // *last* split message while the earlier ones kept
                    // attempt 1's text, a chimera of two responses (#825).
                    if (sentMessages.length > 1) {
                        await untilPaintIdle();
                        painting = true;
                        try {
                            // Each extra message stays tracked until it is
                            // actually gone: a failed delete falls back to
                            // blanking it, and one that still shows attempt
                            // 1's text fails this attempt — the error report
                            // beats leaving the chimera on screen.
                            while (sentMessages.length > 1) {
                                const extra = sentMessages.at(-1);
                                const gone = await extra.delete().then(() => true).catch(() => false)
                                    || await edit(extra, '…').then(() => true).catch(() => false);
                                if (!gone) throw new Error('could not clear a stale reply message before retrying');
                                sentMessages.pop();
                            }
                            currentMsg = placeholder;
                            await edit(placeholder, '…').catch(() => {});
                        } finally {
                            painted = null;
                            painting = false;
                        }
                    }
                    for await (const piece of streamCompletion(callArgs)) {
                        fullResponse += piece;
                        currentBuf += piece;
                        // Once there is a status line to show, room is kept for
                        // it, so appending it cannot push the message past
                        // Discord's limit and clip the text above it.
                        const flushAt = DISCORD_MAX_LEN - 50 - (activity.used ? STATUS_RESERVE : 0);
                        if (currentBuf.length >= flushAt) {
                            // Held across the whole sequence, not just the
                            // edit: `currentMsg` is reassigned in the middle of
                            // it, and a repaint landing on either side of that
                            // writes the wrong text to one of the two messages.
                            await untilPaintIdle();
                            painting = true;
                            try {
                                // One yielded piece can be arbitrarily large,
                                // so the buffer may hold more than two
                                // messages' worth. Finalize every full chunk
                                // and keep only the last as the live buffer —
                                // each send stays within Discord's limit.
                                const chunks = chunkText(currentBuf);
                                await edit(currentMsg, chunks[0]);
                                for (const middle of chunks.slice(1, -1)) {
                                    currentMsg = await send(message.channel, middle);
                                    sentMessages.push(currentMsg);
                                }
                                const tail = chunks.length > 1 ? chunks.at(-1) : '';
                                currentMsg = await send(message.channel, tail || '…');
                                sentMessages.push(currentMsg);
                                currentBuf = tail;
                                painted = null;
                            } finally {
                                painting = false;
                            }
                            lastEdit = Date.now();
                            continue;
                        }
                        const now = Date.now();
                        if (now - lastEdit >= STREAM_EDIT_INTERVAL_MS) {
                            await paint();
                            lastEdit = now;
                        }
                    }
                    if (currentBuf) {
                        // The status line is gone by here — nothing is running —
                        // so the message settles on the text alone. Still takes
                        // the flag: the clock is not stopped until the `finally`
                        // below, so a repaint can still be in flight.
                        await untilPaintIdle();
                        painting = true;
                        painted = currentBuf;
                        try {
                            await edit(currentMsg, currentBuf);
                        } catch {
                            painted = null;
                        } finally {
                            painting = false;
                        }
                    }
                }, { canRetry: () => !activity.ranTools });
            } finally {
                clearInterval(statusInterval);
                clearInterval(typingInterval);
            }

            // Where the tool summary goes, unless the reconcile below moves it.
            let tailMsg = currentMsg;
            let tailText = currentBuf;

            // Post-process: reconcile sentMessages against the canonical cleanText chunks
            if (aiSettings.actionsEnabled && !toolActions) {
                const { cleanText, action } = extractAction(fullResponse);
                if (action) {
                    // Derive the canonical chunks from cleanText so every sent message
                    // reflects exactly the visible response (no ACTION payload leaking out).
                    const canonicalChunks = cleanText.trim() ? chunkText(cleanText) : [];
                    for (let i = 0; i < sentMessages.length; i++) {
                        if (i < canonicalChunks.length) {
                            await edit(sentMessages[i], canonicalChunks[i]).catch(() => {});
                        } else {
                            // Extra messages that existed only to hold overflow or ACTION text
                            await sentMessages[i].delete().catch(() => {});
                        }
                    }
                    fullResponse = cleanText;
                    // currentMsg may be one of the messages just deleted — the
                    // one that held nothing but the ACTION block — so the footer
                    // follows the reconcile rather than the stream.
                    const kept = Math.min(canonicalChunks.length, sentMessages.length);
                    tailMsg = kept ? sentMessages[kept - 1] : null;
                    tailText = kept ? canonicalChunks[kept - 1] : '';
                    await executeAction(action, message);
                }
            }

            await attachToolFooter(tailMsg, tailText, activity.footer(), message.channel);
        } else {
            let response = await withRetry(() => {
                activity.reset();
                return getCompletion(callArgs);
            }, { canRetry: () => !activity.ranTools });
            response = response || '(empty response)';

            if (aiSettings.actionsEnabled && !toolActions) {
                const { cleanText, action } = extractAction(response);
                if (action) {
                    response = cleanText || '';
                    await executeAction(action, message);
                }
            }

            fullResponse = response;
            let tailMsg = null;
            let tailText = '';
            if (fullResponse.trim()) {
                const chunks = chunkText(fullResponse);
                tailMsg = await reply(message, chunks[0]);
                tailText = chunks[0];
                for (let i = 1; i < chunks.length; i++) {
                    tailMsg = await send(message.channel, chunks[i]);
                    tailText = chunks[i];
                }
            }
            await attachToolFooter(tailMsg, tailText, activity.footer(), message.channel);
        }

        // Anything a tool produced that the channel can show and the model
        // could not use — a chart, a screenshot. Its own message, after the
        // text, so a failed send costs the pictures and not the answer.
        if (activity.attachments.length) {
            await send(message.channel, { files: activity.attachments }).catch(err =>
                console.error('[MCP] tool attachments send failed:', err?.message || err)
            );
        }

        // After the reply, never before it: the ledger is for the dashboard, and
        // nothing about it is worth adding to the wait the user is already in.
        //
        // The bot's own tools are left out of it: that ledger is the Connections
        // panel, one row per server an admin configured, and the bot is not one
        // of them. They still show in the reply's activity footer, which is
        // where "what did it just do" belongs.
        if (activity.used) {
            const serverCalls = activity.calls.filter(call => call.server !== BOT_SERVER);
            if (serverCalls.length || activity.unreachableServers.length) {
                await recordToolCalls(message.guild.id, serverCalls, activity.unreachableServers);
            }
        }

        if (fullResponse.trim()) {
            // The turns this trim drops are summarised rather than lost (#833).
            // One cheap request per trim, attributed to the same user so it is
            // bounded by the guild's own limits, and best-effort: the reply is
            // already on screen, and a conversation without a summary is what
            // this guild had yesterday.
            await appendHistory(
                message.guild.id, message.channel.id, message.author.id,
                promptText, fullResponse, maxHistory,
                createSummarizer(
                    { provider, model, apiKey, baseUrl, rateLimit },
                    { guildId: message.guild.id, userId: message.author.id, channelId: message.channel.id }
                )
            );
            // Only what the question matched is a source. The background tier
            // is in the prompt because it is recent, not because it answered
            // anything, so citing it would credit an entry nobody retrieved.
            if (kbMatched.length) {
                const prefix = '📚 Sources: ';
                const limit = DISCORD_MAX_LEN - prefix.length - 10;
                let body = '';
                let omitted = 0;
                for (const entry of kbMatched) {
                    const title = entry.title.length > 80 ? entry.title.slice(0, 77) + '…' : entry.title;
                    const part = body ? `, ${title}` : title;
                    if (body.length + part.length > limit) { omitted++; continue; }
                    body += part;
                }
                if (omitted) body += ` (+${omitted} more)`;
                await send(message.channel, prefix + body).catch(err =>
                    console.error('[AI] citations footer send failed:', err?.message || err)
                );
            }
        }
    } catch (error) {
        // Reuse the streaming placeholder if one is already on screen, so the
        // failure replaces the "…" instead of leaving it dangling beside it.
        const report = async text => {
            if (placeholder) {
                const edited = await edit(placeholder, text).then(() => true).catch(() => false);
                if (edited) return;
            }
            await reply(message, text).catch(() => {});
        };

        // The peek above passed but somebody else took the last slot in between.
        if (error?.rateLimited) {
            await report(error.scope === 'channel'
                ? 'This channel has reached the AI request limit. Please wait before sending more AI requests here.'
                : `Rate limit reached (${error.limit} per ${error.windowMin}m). Please slow down.`);
            return;
        }
        console.error(`[AI:${provider}] error:`, error?.message || error);
        const status = error?.status || error?.response?.status;
        let detail = status ? ` (HTTP ${status})` : '';
        if (status === 401) detail += ' — check your API key';
        else if (status === 404) detail += ' — model not found; check your model name in the AI settings';
        else if (status === 429) detail += ' — rate limit exceeded';
        else if (status === 503) detail += ' — provider unavailable';
        await report(`Sorry, I hit an error talking to ${providerLabel}${detail}.`);
    }
}

module.exports = { handleAIChat };
