const User = require('../../models/User');
const { resolveMcpServers } = require('../../config/mcpServers');
const { providers, mcpMode } = require('./providers');
const { resolveProviderConfig, streamCompletion, getCompletion } = require('./index');
const { retrieveKnowledge, buildKnowledgeContext } = require('./knowledge');
const { loadHistory, appendHistory, clearHistory } = require('./history');
const { peekRateLimit, peekChannelRateLimit, userRateLimitKey } = require('./rateLimit');
const { buildActionsAddendum, extractAction, executeAction } = require('./actions');
const { buildMcpAddendum } = require('./mcp/prompt');
const { retrieveMcpKnowledge } = require('./mcp/resources');
const { createToolActivity, STATUS_RESERVE } = require('./mcp/activity');
const { createToolConfirmer } = require('./mcp/approval');
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

function chunkText(text, size = DISCORD_MAX_LEN) {
    if (text.length <= size) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > size) {
        let cut = remaining.lastIndexOf('\n', size);
        if (cut < size * 0.5) cut = remaining.lastIndexOf(' ', size);
        if (cut < size * 0.5) cut = size;
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

async function handleAIChat(message, aiSettings) {
    const { provider, model, temperature, maxTokens, apiKey, baseUrl, mcpServers, mcpConfirm, mcpRoute, rateLimit } = resolveProviderConfig(aiSettings);
    const providerDef = providers.get(provider);
    const providerLabel = providerDef?.label || provider;

    if (provider !== 'ollama' && !apiKey) {
        return reply(message, `${providerLabel} is not configured. Add an API key in the dashboard.`);
    }

    const modelError = providerDef?.validateModel?.(model);
    if (modelError) {
        return reply(message, modelError);
    }

    const content = message.content.trim();
    if (content.toLowerCase() === '!reset') {
        await clearHistory(message.guild.id, message.channel.id, message.author.id);
        return reply(message, 'Conversation history cleared.');
    }

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

    // Build system prompt: base + pinned memories + knowledge context + action instructions
    let systemPrompt = aiSettings.systemPrompt || 'You are a helpful Discord bot assistant.';

    const userDoc = await User.findOne({ userId: message.author.id, guildId: message.guild.id }).lean();
    const pinnedMemories = userDoc?.pinnedMemories?.length ? userDoc.pinnedMemories : null;

    const { entries: kbEntries, isBackground: kbIsBackground } = await retrieveKnowledge(message.guild.id, content);
    if (kbEntries.length) {
        systemPrompt += buildKnowledgeContext(kbEntries);
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
    if (mcpActive) {
        systemPrompt += buildMcpAddendum({ actionsEnabled: Boolean(aiSettings.actionsEnabled) });
    }
    if (aiSettings.actionsEnabled) {
        systemPrompt += buildActionsAddendum(userDoc?.timezone);
    }

    try {
        await message.channel.sendTyping();

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
        if (mcpKnowledge) systemPrompt += mcpKnowledge.text;

        const { messages: rawHistory } = await loadHistory(
            message.guild.id, message.channel.id, message.author.id, maxHistory
        );

        // Prepend pinned memories as a user-context message so the model treats
        // them as reference information, not authoritative system instructions.
        const history = pinnedMemories
            ? [
                { role: 'user', content: `[My saved context for this conversation]\n${pinnedMemories.map(m => `- ${m.content}`).join('\n')}` },
                { role: 'assistant', content: 'Understood, I have noted your saved context.' },
                ...rawHistory
              ]
            : rawHistory;

        const usageOut = {};
        // Collects what the MCP tools did across every round of this turn, so
        // the reply can say what the bot is waiting on while it waits, and what
        // it used once it is done.
        const activity = createToolActivity();
        const callArgs = {
            provider, model, apiKey, baseUrl, systemPrompt, history,
            prompt: content, temperature, maxTokens, mcpServers,
            guildId: message.guild.id, usageOut, onToolEvent: activity.onEvent,
            // The guild's policy, and the buttons that answer it. The toolkit
            // holds the call until this resolves, so a tool that writes
            // something does not run until somebody in the channel says so.
            mcpConfirm, mcpRoute, confirmTool: createToolConfirmer(message),
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
                                await edit(currentMsg, currentBuf.slice(0, DISCORD_MAX_LEN));
                                const overflow = currentBuf.slice(DISCORD_MAX_LEN);
                                currentMsg = await send(message.channel, overflow || '…');
                                sentMessages.push(currentMsg);
                                currentBuf = overflow;
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
            if (aiSettings.actionsEnabled) {
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

            if (aiSettings.actionsEnabled) {
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
        if (activity.used) {
            await recordToolCalls(message.guild.id, activity.calls, activity.unreachableServers);
        }

        if (fullResponse.trim()) {
            await appendHistory(
                message.guild.id, message.channel.id, message.author.id,
                content, fullResponse, maxHistory
            );
            if (kbEntries.length && !kbIsBackground) {
                const prefix = '📚 Sources: ';
                const limit = DISCORD_MAX_LEN - prefix.length - 10;
                let body = '';
                let omitted = 0;
                for (const entry of kbEntries) {
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
