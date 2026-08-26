const Reminder = require('../../models/Reminder');
const { formatLocalTime } = require('../../utils/timezones');
const { MAX_REMINDER_MINUTES, MAX_OPEN_REMINDERS, MAX_REMINDER_MESSAGE_LENGTH } = require('../../utils/reminderLimits');

// AI in-channel actions: the prompt addendum offering them, the trailing
// ACTION-block parser, and the executor for the actions themselves.

function buildActionsAddendum(timezone) {
    const now = new Date();
    const timeStr = now.toUTCString();

    let localTimeLine = '';
    let reminderTimingRule = `using the UTC time above — the user's timezone is unknown, so assume UTC and say so when you confirm the reminder`;
    if (timezone) {
        try {
            localTimeLine = `\nThe user's local timezone is ${timezone}; their current local time is ${formatLocalTime(now, timezone)}.`;
            reminderTimingRule = `using the user's local time above (not UTC) to interpret times like "3pm" or "tomorrow", then convert to minutes from now`;
        } catch {
            // Invalid/unset timezone string — fall back to the UTC-only rule above.
        }
    }

    // The rule about MCP servers used to live here, which meant it only reached
    // the model when a guild had actions switched on — see mcp/prompt.js, where
    // it is now its own addendum added whenever there is a server to reach.
    return `
You may optionally take one in-channel action by appending an ACTION block on its own line at the very end of your response. Only do so when the user explicitly asks for it or it is clearly useful.

Current UTC time: ${timeStr}${localTimeLine}

Available actions:
- Create a poll:    ACTION:{"type":"create_poll","question":"...","options":["a","b",...]}
- Set a reminder:   ACTION:{"type":"create_reminder","text":"...","delayMinutes":30}
- Suggest mod action (mods only): ACTION:{"type":"suggest_mod_action","suggestion":"..."}

For reminders: always use the ACTION block to actually set the reminder — never just describe it. Compute delayMinutes ${reminderTimingRule}. If the user says "tomorrow" with no time, use 9am their next day (roughly 18–24 hours). If timing is genuinely ambiguous, ask one clarifying question before setting it. Reminder text must be 500 characters or fewer.

Never fabricate an action. The ACTION block must be the final line of your response with no text after it.`;
}

// Extracts and removes a trailing ACTION block from AI response text.
function extractAction(text) {
    const match = text.match(/\nACTION:(\{.*\})\s*$/s);
    if (!match) return { cleanText: text, action: null };
    try {
        const action = JSON.parse(match[1]);
        const cleanText = text.slice(0, text.lastIndexOf('\nACTION:')).trimEnd();
        return { cleanText, action };
    } catch {
        return { cleanText: text, action: null };
    }
}

async function executeAction(action, message) {
    try {
        switch (action.type) {
            case 'create_poll': {
                const options = (action.options || []).slice(0, 5);
                if (!action.question || options.length < 2) break;

                const { buildPollEmbed, buildPollRows } = require('../../views/pollView');
                const Poll = require('../../models/Poll');

                const counts = new Array(options.length).fill(0);
                const embed = buildPollEmbed(action.question, options, counts, null, 'AI', false);
                const rows = buildPollRows(options);

                const pollMsg = await message.channel.send({ embeds: [embed], components: rows });
                await Poll.create({
                    messageId: pollMsg.id,
                    guildId: message.guild.id,
                    channelId: message.channel.id,
                    question: action.question,
                    options,
                    votes: new Map(),
                    createdBy: 'AI'
                });
                break;
            }

            case 'create_reminder': {
                const MIN_MINUTES = 1;
                const rawMinutes = Number(action.delayMinutes);
                const minutes = Number.isFinite(rawMinutes)
                    ? Math.min(MAX_REMINDER_MINUTES, Math.max(MIN_MINUTES, rawMinutes))
                    : 60;

                const openCount = await Reminder.countDocuments({ userId: message.author.id, completed: false });
                if (openCount >= MAX_OPEN_REMINDERS) {
                    await message.channel.send(
                        `<@${message.author.id}> you already have ${MAX_OPEN_REMINDERS} open reminders — cancel one with \`/reminders cancel\` before adding more.`
                    );
                    break;
                }

                const rawText = typeof action.text === 'string' && action.text.trim() ? action.text.trim() : 'Reminder set by AI';
                const text = rawText.length > MAX_REMINDER_MESSAGE_LENGTH
                    ? rawText.slice(0, MAX_REMINDER_MESSAGE_LENGTH)
                    : rawText;

                const delayMs = minutes * 60 * 1000;
                const remindAt = new Date(Date.now() + delayMs);
                await Reminder.create({
                    userId: message.author.id,
                    guildId: message.guild.id,
                    channelId: message.channel.id,
                    message: text,
                    remindAt,
                    completed: false
                });
                await message.channel.send(
                    `Reminder set for <@${message.author.id}> — <t:${Math.floor(remindAt.getTime() / 1000)}:F> (<t:${Math.floor(remindAt.getTime() / 1000)}:R>)`
                );
                break;
            }

            case 'suggest_mod_action': {
                if (!message.member.permissions.has('ModerateMembers') &&
                    !message.member.permissions.has('ManageGuild')) break;
                const Guild = require('../../models/Guild');
                const gs = await Guild.findOne({ guildId: message.guild.id });
                const logId = gs?.moderation?.logChannelId;
                if (!logId) break;
                const logCh = message.guild.channels.cache.get(logId);
                if (!logCh) break;
                await logCh.send(
                    `**[AI Mod Suggestion]** in <#${message.channel.id}>:\n${action.suggestion}`
                );
                break;
            }
        }
    } catch (err) {
        console.error('[AI Action] execution error:', err.message);
    }
}

module.exports = { buildActionsAddendum, extractAction, executeAction };
