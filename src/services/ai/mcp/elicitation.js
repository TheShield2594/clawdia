'use strict';

const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
    TextInputBuilder, TextInputStyle, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { rejectOtherUser } = require('../../../utils/collectorOwner');
const { toolLabel } = require('../../../utils/toolLabel');

/**
 * Letting an MCP server ask the person a question mid-tool-call (#838).
 *
 * Everything else in this directory is the bot asking a server for something.
 * Elicitation is the one exchange that runs the other way: a tool that has got
 * halfway and needs one more fact — which of your three organisations, what
 * date, are you sure — sends `elicitation/create` down the stream its result is
 * still coming on, and waits. A client that does not answer leaves the server
 * holding a request forever, which is why this is a capability rather than a
 * courtesy: it is claimed only when there is somebody to ask.
 *
 * The shape is very close to `approval.js` — a message in the channel, buttons,
 * an answer routed back to a caller waiting on a promise, a clock. What is
 * different is that the answer carries data rather than a yes, and Discord's
 * only way to collect typed data is a modal, which can only be opened from an
 * interaction. So it is two steps: a message with an Answer button, and the
 * modal that button opens.
 *
 * ── What a server is allowed to ask for ────────────────────────────────────
 * The spec restricts `requestedSchema` to a flat object of primitives, and this
 * enforces that rather than trusting it: a nested schema, or one with twenty
 * fields, is refused before anything reaches the channel. That is not
 * defensiveness for its own sake — a modal holds five inputs, and a schema this
 * cannot render honestly is better declined in a sentence the model can read
 * than half-collected.
 *
 * ── What it is not allowed to ask for ──────────────────────────────────────
 * The spec says servers must not use this for secrets, which is a rule for
 * well-behaved servers and no protection at all from the others. A guild admin
 * connects these servers, so the URL is trusted to the extent the admin is; the
 * person answering the prompt in a channel is often not that admin. So every
 * prompt names the server asking and says, in the prompt itself, that a real
 * one will not ask for a password or a token. It is the same defence the
 * approval prompt uses for tool arguments: show the person exactly who is
 * asking and what for, and make the unusual case look unusual.
 */

// How long a question waits. Longer than a tool approval, which is a yes or a
// no to something already written out: this one has to be read, understood and
// typed into, and the tool on the far side is holding its own request open for
// as long as we take.
const ELICIT_TIMEOUT_MS = 120_000;

// Discord's modal holds five components, so a schema wanting more than five
// answers cannot be put to somebody in one prompt. Refused rather than
// truncated: half the fields collected is a tool call that fails on the far
// side with a message about the fields it did not get.
const MAX_FIELDS = 5;

// Label and placeholder ceilings Discord enforces, applied here so a server
// with a long field description gets a trimmed label rather than an API error
// that loses the whole prompt.
const MAX_LABEL_CHARS = 45;
const MAX_PLACEHOLDER_CHARS = 100;
const MAX_VALUE_CHARS = 1000;

// The server's own words, in a channel. Clamped because they are somebody
// else's text going into a Discord message with a length limit of its own.
const MAX_MESSAGE_CHARS = 600;

// Per turn. An elicitation is a person being interrupted, and a server that
// asks four times in one reply is not collecting an argument, it is running a
// form — or fishing. Past this they are declined in words the model can read.
const MAX_ELICITATIONS_PER_TURN = 2;

const ANSWER = 'mcp-elicit-answer';
const DECLINE = 'mcp-elicit-decline';

/**
 * The modal's custom id, unique per question.
 *
 * `awaitModalSubmit` is not scoped the way `awaitMessageComponent` is: it hands
 * the collector no message, channel or guild, so *every* live collector in the
 * process is offered *every* modal submission and the filter is the only thing
 * that separates them. With one shared id, two questions open at once — which
 * a round running two tool calls can produce, and the per-turn ceiling allows —
 * would both match the first form submitted. Overlapping field names is the bad
 * case: one server is silently sent the answer somebody typed for the other,
 * and both prompts say it was answered.
 *
 * So the id carries a counter, and the filter matches it exactly. The button
 * step needs none of this: `Message#awaitMessageComponent` scopes its collector
 * to the message the buttons are on.
 */
const MODAL_PREFIX = 'mcp-elicit-modal';
let modalSeq = 0;
const nextModalId = () => `${MODAL_PREFIX}:${Date.now().toString(36)}:${++modalSeq}`;

const NOT_YOURS = 'Only the person who asked, or someone who can manage this server, can answer this.';

// The three answers the spec defines. `accept` carries content; the other two
// are the person saying no and the client saying nobody said anything, and the
// server is expected to tell them apart — "I decided not to" is not "ask me
// again later".
const ACCEPT = 'accept';
const DECLINE_ACTION = 'decline';
const CANCEL = 'cancel';

/** Server-written text, safe to put inside a Discord message. */
function clean(text, limit) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/`/g, "'");
    return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

/**
 * One property of a `requestedSchema` as something a modal can render, or null
 * when it is not a primitive this can honestly collect.
 *
 * `enum` is checked before `type` because an enum of strings is a choice rather
 * than free text, and the difference matters to what the person is shown: a
 * list of the legal answers beats a blank box they can get wrong.
 */
function fieldOf(name, schema) {
    if (!schema || typeof schema !== 'object') return null;

    const title = clean(schema.title || name, MAX_LABEL_CHARS);
    const description = clean(schema.description || '', MAX_PLACEHOLDER_CHARS);
    const options = Array.isArray(schema.enum)
        ? schema.enum.filter(v => typeof v === 'string' || typeof v === 'number').map(String)
        : null;

    if (options?.length) return { name, title, description, kind: 'enum', options };

    switch (schema.type) {
        case 'string':
            return { name, title, description, kind: 'string' };
        case 'number':
        case 'integer':
            return { name, title, description, kind: schema.type, minimum: schema.minimum, maximum: schema.maximum };
        case 'boolean':
            return { name, title, description, kind: 'boolean' };
        default:
            // An object, an array, or a type nobody named. The spec does not
            // allow these here, and a modal could not collect one anyway.
            return null;
    }
}

/**
 * A `requestedSchema` as the fields to put in a modal, or a refusal.
 *
 * The refusal is a string rather than a throw because it is an answer: the
 * server is told the client declined and why, and the model sees the tool
 * result that follows from it. Nothing about a schema this cannot render is
 * recoverable by trying again.
 */
function fieldsOf(requestedSchema) {
    const properties = requestedSchema?.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
        return { error: 'the requested schema has no properties to fill in' };
    }

    const required = new Set(Array.isArray(requestedSchema.required) ? requestedSchema.required : []);
    const entries = Object.entries(properties);
    if (!entries.length) return { error: 'the requested schema asks for nothing' };
    if (entries.length > MAX_FIELDS) {
        return { error: `the requested schema asks for ${entries.length} values and this client can collect at most ${MAX_FIELDS} at once` };
    }

    const fields = [];
    for (const [name, schema] of entries) {
        const field = fieldOf(name, schema);
        if (!field) return { error: `"${clean(name, 40)}" is not a type this client can ask a person for` };
        fields.push({ ...field, required: required.has(name) });
    }
    return { fields };
}

/** Words a person types when they mean yes, and when they mean no. */
const TRUTHY = new Set(['true', 'yes', 'y', '1', 'on']);
const FALSY = new Set(['false', 'no', 'n', '0', 'off']);

/**
 * One typed answer as the value the schema asked for, or an error to show.
 *
 * An empty answer to an optional field is an omission rather than an empty
 * string: the server asked whether we had one, and "" is a different statement
 * from "no value", especially to a tool that will pass it on to an API.
 */
function coerce(field, raw) {
    const text = String(raw ?? '').trim();

    if (!text) {
        if (field.required) return { error: `${field.title} is required.` };
        return { omitted: true };
    }

    switch (field.kind) {
        case 'boolean': {
            const lowered = text.toLowerCase();
            if (TRUTHY.has(lowered)) return { value: true };
            if (FALSY.has(lowered)) return { value: false };
            return { error: `${field.title} should be yes or no.` };
        }
        case 'number':
        case 'integer': {
            const value = Number(text);
            if (!Number.isFinite(value)) return { error: `${field.title} should be a number.` };
            if (field.kind === 'integer' && !Number.isInteger(value)) {
                return { error: `${field.title} should be a whole number.` };
            }
            if (field.minimum != null && value < field.minimum) return { error: `${field.title} should be at least ${field.minimum}.` };
            if (field.maximum != null && value > field.maximum) return { error: `${field.title} should be at most ${field.maximum}.` };
            return { value };
        }
        case 'enum': {
            // Case-insensitively, because the person is typing one of a list
            // they were shown and the list is the authority on spelling.
            const match = field.options.find(option => option.toLowerCase() === text.toLowerCase());
            if (!match) return { error: `${field.title} should be one of: ${field.options.join(', ')}.` };
            return { value: match };
        }
        default:
            return { value: text };
    }
}

/** Every answer, or the first thing wrong with them. */
function collect(fields, read) {
    const content = {};
    for (const field of fields) {
        const answer = coerce(field, read(field.name));
        if (answer.error) return { error: answer.error };
        if (!answer.omitted) content[field.name] = answer.value;
    }
    return { content };
}

/** What the person sees above the buttons. */
function promptText(userId, server, message, fields) {
    const asks = fields
        .map(field => `• **${field.title}**${field.required ? '' : ' (optional)'}`
            + `${field.kind === 'enum' ? ` — one of: ${field.options.join(', ')}` : ''}`
            + `${field.kind === 'boolean' ? ' — yes or no' : ''}`)
        .join('\n');

    return `❓ <@${userId}> — the \`${toolLabel(server)}\` server is asking you a question:\n`
        + `> ${clean(message, MAX_MESSAGE_CHARS) || 'It did not say what for.'}\n\n${asks}\n`
        + '-# A real server will not ask for a password, an API key or a login code. Cancel if this one does.';
}

function buttons(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(ANSWER).setLabel('Answer').setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(DECLINE).setLabel('Cancel').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
    );
}

function modalFor(server, fields, customId) {
    const modal = new ModalBuilder().setCustomId(customId).setTitle(clean(`${server} needs an answer`, MAX_LABEL_CHARS));

    for (const field of fields) {
        const input = new TextInputBuilder()
            .setCustomId(field.name)
            .setLabel(field.title || field.name.slice(0, MAX_LABEL_CHARS))
            .setStyle(TextInputStyle.Short)
            .setRequired(field.required)
            .setMaxLength(MAX_VALUE_CHARS);

        const hint = field.kind === 'enum'
            ? field.options.join(' / ')
            : (field.kind === 'boolean' ? 'yes or no' : field.description);
        if (hint) input.setPlaceholder(clean(hint, MAX_PLACEHOLDER_CHARS));

        modal.addComponents(new ActionRowBuilder().addComponents(input));
    }
    return modal;
}

/**
 * An `elicitation/create` handler for one Discord message's turn.
 *
 * Bound to a server name by the toolkit and handed to `callTool`, not to the
 * client: clients are pooled by (url, credential) and shared by every guild
 * pointed at that server, so a handler living on one would answer another
 * guild's question in this guild's channel. A tool call belongs to exactly one
 * message, which is the scope that knows whose channel to ask in.
 *
 * The per-turn count lives in this closure for the same reason — it is a count
 * of interruptions to one person, not of requests to one server.
 *
 * @param {object} message the message that started the turn
 * @returns {(server: string, params: object, ctx: object) => Promise<object>}
 */
function createElicitationHandler(message, { timeoutMs = ELICIT_TIMEOUT_MS } = {}) {
    let asked = 0;

    return async (serverName, { message: question, requestedSchema } = {}, { extendDeadline } = {}) => {
        // Declining is a first-class answer, so every refusal below is one:
        // the server is told no and carries on, rather than waiting out a
        // request nobody is going to answer.
        //
        // Nothing but `action` and `content` goes back: the reason is for the
        // log, and a field the spec does not define is one a strict server is
        // entitled to reject the whole response over.
        const declined = reason => {
            console.warn(`[MCP] declined an elicitation from "${serverName}": ${reason}`);
            return { action: DECLINE_ACTION };
        };

        if (++asked > MAX_ELICITATIONS_PER_TURN) {
            return declined(`this reply has already put ${MAX_ELICITATIONS_PER_TURN} questions to the user`);
        }

        const parsed = fieldsOf(requestedSchema);
        if (parsed.error) return declined(parsed.error);

        // Before the prompt goes up, not after somebody has answered it: the
        // deadline this is pushing out is the one that would otherwise destroy
        // the stream while they are still reading.
        extendDeadline?.(timeoutMs + 15_000);

        const content = promptText(message.author.id, serverName, question, parsed.fields);
        const prompt = await message.channel.send({
            content,
            components: [buttons()],
            // The asker is pinged because they are the one being waited on.
            // Nothing the server wrote can ping anybody, whatever it put in the
            // question or the field names.
            allowedMentions: { users: [message.author.id] }
        });

        // The prompt is edited in place rather than answered with a new
        // message, so the channel keeps one record of what was asked and what
        // was said — and the buttons go, so a click an hour later cannot land
        // on a request the server stopped waiting for.
        const settle = async (text, result) => {
            await prompt.edit({ content: `${content}\n${text}`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
            return result;
        };

        const filter = interaction => {
            if (interaction.customId !== ANSWER && interaction.customId !== DECLINE) return false;
            if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
            return !rejectOtherUser(interaction, message.author.id, NOT_YOURS);
        };

        let click;
        try {
            click = await prompt.awaitMessageComponent({ filter, time: timeoutMs });
        } catch {
            // Nobody answered. `cancel` rather than `decline`: the person did
            // not refuse, they were not there, and a server may reasonably
            // treat those differently.
            return settle('⏳ Nobody answered.', { action: CANCEL });
        }

        if (click.customId === DECLINE) {
            await click.deferUpdate().catch(() => {});
            return settle(`🚫 Cancelled by <@${click.user.id}>.`, { action: DECLINE_ACTION });
        }

        const modalId = nextModalId();
        await click.showModal(modalFor(serverName, parsed.fields, modalId));

        // The clock again. Answering is two waits, not one — noticing the
        // prompt and clicking, then reading the form and typing — and the
        // extension above only covered the first. Without this second one the
        // stream is destroyed while somebody is mid-form, and the tool call is
        // reported as failed a minute before they press Submit.
        extendDeadline?.(timeoutMs + 15_000);

        let submission;
        try {
            submission = await click.awaitModalSubmit({
                time: timeoutMs,
                // The id is this question's alone; see MODAL_PREFIX for why
                // that matters. The user check is belt and braces on top —
                // Discord only shows the modal to whoever clicked — and it
                // answers rather than dropping a submission in silence, the
                // same as every other filter here.
                filter: interaction => interaction.customId === modalId
                    && !rejectOtherUser(interaction, click.user.id, NOT_YOURS),
            });
        } catch {
            return settle('⏳ The form was not submitted.', { action: CANCEL });
        }

        const answers = collect(parsed.fields, name => submission.fields.getTextInputValue(name));
        if (answers.error) {
            // One shot at the form. A retry loop is a nicer experience and a
            // worse one for the tool call holding its request open behind it —
            // and the model is told what went wrong, so it can ask again in its
            // own words if the answer mattered.
            await submission.reply({ content: `⚠️ ${answers.error} Nothing was sent to the server.`, flags: MessageFlags.Ephemeral }).catch(() => {});
            console.warn(`[MCP] an answer for "${serverName}" did not fit its schema: ${answers.error}`);
            return settle(
                `⚠️ <@${submission.user.id}> — that answer did not fit what the server asked for.`,
                { action: DECLINE_ACTION },
            );
        }

        await submission.deferUpdate().catch(() => {});
        return settle(`✅ Answered by <@${submission.user.id}>.`, { action: ACCEPT, content: answers.content });
    };
}

module.exports = {
    createElicitationHandler,
    MODAL_PREFIX,
    fieldsOf,
    fieldOf,
    coerce,
    collect,
    promptText,
    ELICIT_TIMEOUT_MS,
    MAX_FIELDS,
    MAX_ELICITATIONS_PER_TURN,
};
