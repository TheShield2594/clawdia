'use strict';

const User = require('../../models/User');
const { MAX_REMINDER_MINUTES, MAX_REMINDER_MESSAGE_LENGTH } = require('../../utils/reminderLimits');
const {
    MAX_TASK_PROMPT_LENGTH,
    MAX_TASK_DELAY_MINUTES,
    MIN_TASK_DELAY_MINUTES,
    MIN_CRON_INTERVAL_MINUTES
} = require('../../utils/scheduledTaskLimits');
const { MAX_MEMORY_LENGTH, memoryCapFor } = require('../../utils/memoryLimits');
const { runAction } = require('./actions');

/**
 * The bot's own actions, as tools (#832).
 *
 * Creating a poll or setting a reminder used to travel as a line of text the
 * model appended to its reply — `ACTION:{"type":"create_reminder",…}` — which
 * the transport cut back off afterwards. That protocol cost more than it looked
 * like it did: one action per turn at most, no schema, and a payload that was
 * malformed silently did nothing at all while the model went on telling the user
 * their reminder was set. The JSON also streamed visibly into the channel before
 * being reconciled away, and at an overflow split could end up sitting in its
 * own message.
 *
 * A tool has none of those problems. The schemas below are validated by the
 * provider, several can be called in one turn, each one answers in words the
 * model can act on, and they inherit the approval buttons and the activity
 * footer from the MCP toolkit — `load_tools` is the precedent for a tool the bot
 * owns rather than a server.
 *
 * The text protocol stays for Anthropic's own MCP connector route, where the bot
 * never sees a tool call and so has nothing to attach a definition to.
 */

// What these calls are attributed to in the activity footer, where every other
// tool is named for the server it came from.
const BOT_SERVER = 'clawdia';

// Discord's own ceiling on poll options.
const MAX_POLL_OPTIONS = 5;

/** A definition in the shape the toolkit's `definitions` array takes. */
function tool({ name, description, properties, required, confirm = false, destructive = false, run }) {
    return {
        name,
        serverName: BOT_SERVER,
        toolName: name,
        description,
        inputSchema: { type: 'object', properties, required },
        // What the approval prompt says about the call when there is one. These
        // all write something, which is the whole point of them.
        annotations: { readOnlyHint: false, destructiveHint: destructive },
        confirm,
        run
    };
}

function pollTool(message) {
    return tool({
        name: 'create_poll',
        description: 'Post a poll in this channel with up to five options for people to vote on.',
        properties: {
            question: { type: 'string', description: 'The question the poll asks.' },
            options: {
                type: 'array',
                items: { type: 'string' },
                minItems: 2,
                maxItems: MAX_POLL_OPTIONS,
                description: `Between 2 and ${MAX_POLL_OPTIONS} answers to choose from.`
            }
        },
        required: ['question', 'options'],
        run: args => runAction({ type: 'create_poll', ...args }, message)
    });
}

function reminderTool(message) {
    return tool({
        name: 'create_reminder',
        description: 'Set a reminder for the person you are replying to. Use this to actually set one — saying you have is not setting it.',
        properties: {
            text: {
                type: 'string',
                maxLength: MAX_REMINDER_MESSAGE_LENGTH,
                description: 'What to remind them about, in their own words where possible.'
            },
            delayMinutes: {
                type: 'integer',
                minimum: 1,
                maximum: MAX_REMINDER_MINUTES,
                description: 'How many minutes from now the reminder should fire.'
            }
        },
        required: ['text', 'delayMinutes'],
        // The tool's own answer carries the timestamp for the model to quote, so
        // a second confirmation message in the channel would only repeat it.
        run: args => runAction({ type: 'create_reminder', ...args }, message, { announce: false })
    });
}

/**
 * Turn "remind me every Friday to…" into a standing agentic task (#834).
 *
 * The distinction this tool has to hold, and the description works hard at, is
 * against `create_reminder`: a reminder replays text the user already wrote,
 * and this wakes the model up on a cadence to *do* something — which is a full
 * provider request against the guild's budget, on a schedule, with nobody
 * watching. So it asks first, the way `save_memory` does and for the stronger
 * version of the same reason: this is the only tool here whose effect is a
 * recurring cost.
 *
 * And it is offered only to a member with Manage Server, matching the slash
 * command. Approval is not a substitute for that: the prompt can be answered by
 * whoever asked for the call.
 */
function scheduleTaskTool(message) {
    return tool({
        name: 'schedule_task',
        description:
            'Schedule an instruction for you to carry out later, once or on a repeating cadence — '
            + 'posting the result in this channel, or sending it to the person by DM. Use it only when the answer has to be worked out at '
            + 'the time (checking feeds, recapping a channel, comparing something against last week). '
            + 'For "remind me to…", use create_reminder instead: each run of a scheduled task costs the '
            + 'server a full AI request. The user is asked to approve it before it is set.',
        properties: {
            instruction: {
                type: 'string',
                maxLength: MAX_TASK_PROMPT_LENGTH,
                description: 'What you should do each time it runs, written as a complete standalone instruction — '
                    + 'nobody will be there to clarify it.'
            },
            delayMinutes: {
                type: 'integer',
                minimum: MIN_TASK_DELAY_MINUTES,
                maximum: MAX_TASK_DELAY_MINUTES,
                description: 'How many minutes from now the first run should be. Required unless repeat is "cron", '
                    + 'where the schedule decides the first run and this is left out.'
            },
            repeat: {
                type: 'string',
                enum: ['none', 'daily', 'weekly', 'monthly', 'cron'],
                description: 'How often it repeats after the first run. "none" runs it once; "cron" follows the cron '
                    + 'field, for cadences the others cannot say, like weekdays only or every few hours.'
            },
            cron: {
                type: 'string',
                maxLength: 100,
                description: 'Only with repeat "cron": a five-field cron expression (minute hour day-of-month month '
                    + `day-of-week), e.g. "0 9 * * 1-5" for weekdays at 09:00. Runs at least ${MIN_CRON_INTERVAL_MINUTES} `
                    + 'minutes apart. Times are in the server\'s timezone, which the result tells you.'
            },
            deliverTo: {
                type: 'string',
                enum: ['channel', 'dm'],
                description: 'Where each result goes: "channel" posts it in this channel (the default), "dm" sends '
                    + 'it privately to the person you are replying to — only ever them. Use "dm" only when they ask '
                    + 'for it privately or by DM.'
            },
            deep: {
                type: 'boolean',
                description: 'Give each run deep task mode\'s room — many more tool rounds and several minutes — for '
                    + 'instructions that must look several things up before answering. Only works where the server has '
                    + 'deep task mode on, and repeats at most hourly. Leave it out for anything one look can answer.'
            }
        },
        required: ['instruction', 'repeat'],
        confirm: true,
        run: args => runAction({ type: 'schedule_task', ...args }, message)
    });
}

function modSuggestionTool(message) {
    return tool({
        name: 'suggest_mod_action',
        description: 'Send a moderation suggestion to this server\'s moderation log channel. Moderators only.',
        properties: {
            suggestion: { type: 'string', description: 'What you are suggesting, and why.' }
        },
        required: ['suggestion'],
        run: args => runAction({ type: 'suggest_mod_action', ...args }, message)
    });
}

/**
 * Remember something about this user for future conversations (#833).
 *
 * Memories are read back into the system prompt of every later reply, which is
 * why this one asks first by default: it is the only tool here whose effect
 * outlives the conversation, and a model that can write to its own context
 * unprompted is a model that can talk itself into anything a day later. The
 * approval buttons are the toolkit's, the same ones a writing MCP tool goes
 * through.
 *
 * A guild can switch that off (`ai.memory.autoSave`), and then the model saves
 * what it learns as it goes — the posture of a personal assistant on a server
 * run by one person. The description changes with it, because "the user is
 * asked first" and "save things without being asked" are opposite instructions.
 */
function memoryTool(message, { cap, autoSave }) {
    return tool({
        name: 'save_memory',
        description: autoSave
            ? 'Remember one fact about this person for future conversations — a preference, a project they are working on, '
                + 'a person or place in their life, how they like things done. Save it as soon as you learn it, without '
                + 'asking: they have chosen to have you remember. Only for things worth recalling days later, not for '
                + `what was just said. They can keep ${cap}; when full, forget_memory one that is stale first.`
            : 'Remember one fact about this person for future conversations — a preference, a project they are working on, '
                + 'how they like to be addressed. The user is asked to approve it before it is saved. '
                + 'Only for things worth recalling days later, not for what was just said.',
        properties: {
            content: {
                type: 'string',
                maxLength: MAX_MEMORY_LENGTH,
                description: 'The fact to remember, as one short self-contained sentence.'
            }
        },
        required: ['content'],
        confirm: !autoSave,
        run: args => saveMemory(args, message, { cap })
    });
}

/**
 * Drop a memory that has gone stale or wrong.
 *
 * The counterpart that makes auto-save workable: a memory store the model can
 * only append to fills up with the first ten things it heard and then stops
 * learning. Matched by text rather than by number, because the model sees its
 * memories as a list without numbers and should not have to count.
 */
function forgetMemoryTool(message, { autoSave }) {
    return tool({
        name: 'forget_memory',
        description: 'Remove one of this person\'s saved memories that is out of date, wrong, or that they asked you to '
            + 'forget. Quote it, or enough of it to pick out just that one. To correct a memory, forget the old one '
            + 'and save the new one.'
            + (autoSave ? '' : ' The user is asked to approve it first.'),
        properties: {
            content: {
                type: 'string',
                maxLength: MAX_MEMORY_LENGTH,
                description: 'The memory to remove, as it appears in their saved context.'
            }
        },
        required: ['content'],
        confirm: !autoSave,
        destructive: true,
        run: args => forgetMemory(args, message)
    });
}

async function saveMemory(args, message, { cap }) {
    const raw = typeof args?.content === 'string' ? args.content.trim() : '';
    if (!raw) return 'Nothing was saved: the memory was empty.';

    const content = raw.length > MAX_MEMORY_LENGTH ? `${raw.slice(0, MAX_MEMORY_LENGTH)}…` : raw;

    // The cap is enforced in the write rather than after a read, so two turns
    // saving at once cannot both find room and take it. `$ne` on the content
    // keeps the model from stacking the same memory up over a conversation.
    const updated = await User.findOneAndUpdate(
        {
            userId: message.author.id,
            guildId: message.guild.id,
            [`pinnedMemories.${cap - 1}`]: { $exists: false },
            'pinnedMemories.content': { $ne: content }
        },
        {
            $setOnInsert: { userId: message.author.id, guildId: message.guild.id },
            $push: { pinnedMemories: { content, pinnedAt: new Date(), channelId: message.channel.id } }
        },
        { new: true, upsert: false }
    );

    if (updated) {
        return `Saved. You will see this in your context in future conversations here: "${content}"`;
    }

    // Which of the two filters missed is worth telling the model apart: one is
    // "say it is already there", the other is "tell them how to make room".
    const existing = await User.findOne(
        { userId: message.author.id, guildId: message.guild.id },
        { pinnedMemories: 1 }
    ).lean();

    if (!existing) {
        return 'Nothing was saved: this user has no profile on this server yet. Ask them to send a message or run a command first.';
    }
    if ((existing.pinnedMemories || []).some(memory => memory.content === content)) {
        return 'Nothing was saved: that is already one of their saved memories.';
    }
    return `Nothing was saved: they already have the maximum of ${cap} saved memories. Use forget_memory on one that `
        + 'is stale, or tell them to remove one with `/ai memories`, then save again.';
}

/** Normalised for matching: case and runs of whitespace do not distinguish two memories. */
function normalizeMemory(text) {
    return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function forgetMemory(args, message) {
    const wanted = normalizeMemory(args?.content);
    if (!wanted) return 'Nothing was removed: say which memory to forget.';

    const existing = await User.findOne(
        { userId: message.author.id, guildId: message.guild.id },
        { pinnedMemories: 1 }
    ).lean();
    const memories = existing?.pinnedMemories || [];

    // An exact match wins outright; otherwise the quote has to pick out exactly
    // one memory, because removing the wrong one is worse than asking again.
    let matches = memories.filter(memory => normalizeMemory(memory.content) === wanted);
    if (!matches.length) matches = memories.filter(memory => normalizeMemory(memory.content).includes(wanted));
    if (!matches.length) return 'Nothing was removed: none of their saved memories matches that.';
    if (matches.length > 1) {
        return `Nothing was removed: that matches ${matches.length} memories. Quote more of the one you mean.`;
    }

    const [target] = matches;
    const result = await User.updateOne(
        { userId: message.author.id, guildId: message.guild.id },
        { $pull: { pinnedMemories: { _id: target._id } } }
    );
    if (!result?.modifiedCount) return 'Nothing was removed: that memory was already gone.';
    return `Forgotten: "${target.content}"`;
}

/**
 * The bot-owned tools for one Discord message's turn, or [] when the guild has
 * in-channel actions switched off.
 *
 * Bound to the message rather than taking it per call, because everything here
 * acts *as* that message: the reminder is the author's, the poll goes in their
 * channel, the mod suggestion carries their permissions.
 *
 * @param {object} message the message that started the turn
 * @param {object} [options]
 * @param {boolean} [options.enabled] the guild's `ai.actionsEnabled`
 * @param {object} [options.ai] the guild's `ai` settings, for the memory cap
 *        and whether memories are saved without asking
 */
function buildBotTools(message, { enabled = true, ai = null } = {}) {
    if (!enabled) return [];

    const memory = { cap: memoryCapFor(ai), autoSave: ai?.memory?.autoSave === true };
    const tools = [
        pollTool(message),
        reminderTool(message),
        memoryTool(message, memory),
        forgetMemoryTool(message, memory)
    ];

    // Offered only to someone who could act on it. The executors check the same
    // permissions again — this is about not putting a tool in front of a model
    // that will always refuse it.
    const canManage = message.member?.permissions?.has('ManageGuild');
    const canModerate = canManage || message.member?.permissions?.has('ModerateMembers');

    // Scheduling is gated the way `/ai schedule add` is gated, and for the same
    // reason: a standing task spends the server's budget on a cadence. The
    // approval buttons do not stand in for the permission — whoever asked for
    // the call can click them themselves.
    if (canManage) tools.push(scheduleTaskTool(message));
    if (canModerate) tools.push(modSuggestionTool(message));

    return tools;
}

module.exports = { buildBotTools, BOT_SERVER, MAX_POLL_OPTIONS, normalizeMemory };
