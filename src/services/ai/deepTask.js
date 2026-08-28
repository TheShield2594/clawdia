'use strict';

const { resolveProviderConfig, getCompletion } = require('./index');
const { providers } = require('./providers');
const { buildBotTools, BOT_SERVER } = require('./botTools');
const { buildToolActionsAddendum } = require('./actions');
const { buildMcpAddendum } = require('./mcp/prompt');
const { createToolActivity } = require('./mcp/activity');
const { createToolConfirmer } = require('./mcp/approval');
const { recordToolCalls } = require('./mcp/usage');
const { TASK_MAX_TOOL_ROUNDS, TASK_TURN_BUDGET_MS } = require('./mcp/toolkit');
const { checkDeepTaskLimit } = require('./rateLimit');

/**
 * Deep task mode: one turn with room to actually do something (#835).
 *
 * The MCP loop is tuned for a mention-reply — four tool rounds, ninety seconds
 * of wall clock — and those are the right numbers when somebody is watching a
 * message sit on an ellipsis. They are also what caps the bot at "chatbot with
 * tools": "check these three feeds and diff them against last week" is several
 * rounds of looking things up before there is anything to say, and it does not
 * fit in four.
 *
 * So a task runs with the larger pair of ceilings and, crucially, detached from
 * the interaction that started it. The command acknowledges immediately and
 * this posts the result when it is done, which is what makes an eight-minute
 * budget a reasonable thing to have: nobody is holding a webhook open, and
 * Discord's own three-second and fifteen-minute interaction windows stop being
 * the binding constraint.
 *
 * The narration comes almost free. `mcp/activity.js` already turns tool events
 * into a live line and a call/duration/failure footer for the chat transport;
 * the progress message below repaints that same line on the same clock, so a
 * task that spends four minutes searching says what it is searching.
 *
 * Cost posture: attributed to whoever ran it, so the guild's ordinary per-user
 * message and tool windows apply unchanged — plus an allowance of its own, in
 * `rateLimit.js`, because a guild that allowed twenty messages an hour did not
 * thereby allow twenty turns of this.
 *
 * One route this does not reach: a guild on Anthropic's own MCP connector,
 * where the tool loop runs on Anthropic's side and the bot never sees a call.
 * There is nothing there for a round budget to bound — the rounds are not the
 * bot's to count — so a task on that route is an ordinary long prompt with the
 * task framing, and the guild gets the larger loop by setting `mcpRoute` to
 * `client`. Worth knowing rather than worth blocking: the framing alone is most
 * of what makes a task a task.
 */

const DISCORD_MAX_LEN = 2000;
// The activity layer's own clock. Matching the chat transport's, so a task's
// status line moves at the speed people are used to seeing it move at.
const STATUS_REFRESH_INTERVAL_MS = 1200;
// How many messages one task's answer may spread over. A task is allowed to be
// long; it is not allowed to be a wall.
const MAX_RESULT_MESSAGES = 4;
// How long the final write waits for a repaint already in flight, and how often
// it looks. One Discord edit is a fraction of this; the ceiling is only here so
// an edit that never returns cannot hold the result back for ever.
const PAINT_LOCK_WAIT_MS = 2000;
const PAINT_LOCK_TICK_MS = 25;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Split on a line break where there is one nearby, so a long answer breaks between paragraphs. */
function chunk(text, size = DISCORD_MAX_LEN, limit = MAX_RESULT_MESSAGES) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > size && chunks.length < limit - 1) {
        let cut = remaining.lastIndexOf('\n', size);
        if (cut < size * 0.5) cut = remaining.lastIndexOf(' ', size);
        if (cut < size * 0.5) cut = size;
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).trimStart();
    }
    chunks.push(remaining.length > size ? `${remaining.slice(0, size - 1)}…` : remaining);
    return chunks;
}

/**
 * Whether this guild may run tasks at all, and whether this person may run one
 * now — answered before anything is posted, so a refusal is one ephemeral line
 * rather than a progress message that goes nowhere.
 *
 * Spends one of the person's deep-task slots when it answers yes, which is why
 * it is called once, by the command, rather than again inside the run.
 *
 * Returns `null` when the task may proceed, or the refusal to show.
 */
function refuseTask({ ai, guildId, userId }) {
    if (!ai?.enabled) return 'The AI is switched off on this server.';
    if (!ai.taskModeEnabled) {
        return 'Deep task mode is switched off on this server. A server admin can turn it on under **AI → Chat** in the dashboard.';
    }

    const config = resolveProviderConfig(ai);
    if (config.provider !== 'ollama' && !config.apiKey) {
        return `${providers.get(config.provider)?.label || config.provider} is not configured. Add an API key in the dashboard.`;
    }
    if (!checkDeepTaskLimit(guildId, userId)) {
        return 'You have used up your deep tasks for this hour. Ordinary questions still work — try again a bit later.';
    }
    return null;
}

/**
 * The system prompt for a task turn.
 *
 * Different from a chat turn in one way that matters: the model is told it has
 * room, and told that the answer is a report rather than a conversational
 * reply. Without that a model given twelve rounds still answers in one, because
 * everything else about the prompt says it is in a chat.
 */
function taskSystemPrompt(ai, { actionsEnabled, hasServers }) {
    let systemPrompt = ai.systemPrompt || 'You are a helpful Discord bot assistant.';

    systemPrompt += '\n\nYou are running a **task**, not answering a chat message. Nobody is watching this arrive, '
        + `and you have up to ${TASK_MAX_TOOL_ROUNDS} rounds of tool calls and several minutes to work in. `
        + 'Use them: gather what you actually need before you answer, check the things you are unsure about, '
        + 'and do not stop at the first partial result.\n\n'
        + 'Answer once, at the end, as a short written report — what you did, what you found, and anything you could '
        + 'not get. Do not ask a clarifying question; there is nobody to answer it. If the request turns out to be '
        + 'impossible with the tools you have, say so plainly and say what you would need.';

    if (hasServers) systemPrompt += buildMcpAddendum({ actionsEnabled: false });
    if (actionsEnabled) systemPrompt += buildToolActionsAddendum(null);

    return systemPrompt;
}

/**
 * The `message`-shaped object the bot's own tools and the approval prompt are
 * written against.
 *
 * They were built for the chat transport, and every one of them acts *as* a
 * message: the reminder is the author's, the poll goes in their channel, the
 * approval buttons ping whoever asked. A task has all of those things — a user,
 * a member, a guild, a channel — just not in a Discord message, so this is the
 * adapter rather than a second copy of each tool.
 */
function messageShim({ user, member, guild, channel }) {
    return { author: user, member, guild, channel };
}

/**
 * Run one task and post the result. Never throws: this runs detached from the
 * interaction that started it, so a failure has to become a message in the
 * channel or it becomes nothing at all.
 *
 * @param {object} params
 * @param {object} params.ai       the guild's `ai` settings
 * @param {object} params.guild    the Discord guild
 * @param {object} params.channel  where the progress and the result are posted
 * @param {object} params.user     who asked (attribution and approvals)
 * @param {object} params.member   their guild member, for the moderator tools
 * @param {string} params.prompt   what they asked for
 */
async function runDeepTask({ ai, guild, channel, user, member, prompt }) {
    const activity = createToolActivity();
    const config = resolveProviderConfig(ai);
    const shim = messageShim({ user, member, guild, channel });

    const heading = `🧠 <@${user.id}> — working on: ${prompt.length > 180 ? `${prompt.slice(0, 179)}…` : prompt}`;
    const progress = await channel.send({
        content: heading,
        allowedMentions: { users: [user.id] }
    }).catch(() => null);

    // The status line has to be on its own clock. A tool round yields no text
    // at all, so anything driven by the response stream would only paint the
    // status *after* the tool it is announcing had finished.
    //
    // `finished` and the wait below are what keep the last repaint from landing
    // *after* the result: stopping the timer does not cancel an edit already in
    // flight, and one that resolves late would put the progress line back over
    // the answer and leave it there.
    let painting = false;
    let finished = false;
    let lastPainted = heading;
    const repaint = async () => {
        if (!progress || painting || finished) return;
        const next = activity.decorate(heading);
        if (next === lastPainted) return;
        painting = true;
        lastPainted = next;
        await progress.edit({ content: next, allowedMentions: { parse: [] } }).catch(() => {});
        painting = false;
    };
    const statusTimer = setInterval(repaint, STATUS_REFRESH_INTERVAL_MS);
    statusTimer.unref?.();

    async function untilPaintIdle() {
        for (let waited = 0; painting && waited < PAINT_LOCK_WAIT_MS; waited += PAINT_LOCK_TICK_MS) {
            await sleep(PAINT_LOCK_TICK_MS);
        }
    }

    let answer = '';
    let failure = null;
    try {
        answer = await getCompletion({
            ...config,
            systemPrompt: taskSystemPrompt(ai, {
                actionsEnabled: Boolean(ai.actionsEnabled),
                hasServers: (config.mcpServers || []).length > 0
            }),
            history: [],
            prompt,
            guildId: guild.id,
            // The larger ceilings, which is the whole point. They ride down to
            // the toolkit the same way every other per-request setting does.
            maxRounds: TASK_MAX_TOOL_ROUNDS,
            turnBudgetMs: TASK_TURN_BUDGET_MS,
            onToolEvent: activity.onEvent,
            mcpConfirm: config.mcpConfirm,
            confirmTool: createToolConfirmer(shim),
            botTools: ai.actionsEnabled ? buildBotTools(shim) : [],
            // Attributed, so the guild's ordinary windows bound this turn as
            // well as the deep-task allowance already spent above.
            userId: user.id,
            channelId: channel.id
        });
    } catch (err) {
        // A refusal from the limits has wording of its own worth showing; every
        // other failure gets one sentence, because the provider's own text is
        // not something to paste into a channel.
        failure = err?.rateLimited
            ? err.message
            : 'The task could not be finished — the AI provider returned an error.';
        if (!err?.rateLimited) console.error('[Deep task] run failed:', err?.message || err);
    } finally {
        finished = true;
        clearInterval(statusTimer);
        await untilPaintIdle();
    }

    // The guild's activity ledger counts what its own connections did. The
    // bot's tools are not one of them, the same split the chat transport makes.
    if (activity.used) {
        const serverCalls = activity.calls.filter(call => call.server !== BOT_SERVER);
        if (serverCalls.length || activity.unreachableServers.length) {
            await recordToolCalls(guild.id, serverCalls, activity.unreachableServers).catch(() => {});
        }
    }

    const footer = activity.footer();
    const body = failure
        ? `⚠️ ${failure}`
        : ((answer || '').trim() || '_The task finished without producing anything to report._');
    const done = `✅ <@${user.id}> — ${prompt.length > 120 ? `${prompt.slice(0, 119)}…` : prompt}\n\n${body}`;

    const pieces = chunk(footer ? `${done}\n${footer}` : done);

    // Everything below is model-authored or server-authored text going into a
    // channel, so nothing may ping: the reply mentions the person who asked
    // and nobody else, whatever ended up in the answer.
    const mentions = { users: [user.id] };
    if (progress) {
        await progress.edit({ content: pieces[0], allowedMentions: mentions }).catch(() => {});
    } else {
        await channel.send({ content: pieces[0], allowedMentions: mentions }).catch(() => {});
    }
    for (const rest of pieces.slice(1)) {
        await channel.send({ content: rest, allowedMentions: { parse: [] } }).catch(() => {});
    }
}

module.exports = { runDeepTask, refuseTask, __test__: { chunk, taskSystemPrompt, messageShim } };
